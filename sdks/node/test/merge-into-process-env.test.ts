import { afterEach, describe, expect, it } from 'vitest';
import { EnvpitClient } from '../src/client.js';
import { mergeSnapshotIntoEnv } from '../src/process-env-merge.js';
import { fakeFetch, jsonResponse } from './test-utils.js';

// bd:envpit-yvyr — "merge into the native mechanism" (process.env), owner directive
// 2026-07-27. bd:envpit-durd then added the `secretKeys` wire flag this file's `includeSecrets`
// coverage depends on. Two layers under test:
//   1. `mergeSnapshotIntoEnv` — the pure core (snapshot + target object + options -> result),
//      no real `process.env` mutation, so most cases live here.
//   2. `EnvpitClient#mergeIntoProcessEnv` — the thin wrapper that reads `this.snapshot` and
//      writes the REAL `process.env` (a couple of integration-style checks only).
//
// Full input/output coverage for the check-order/secret-vs-existing semantics lives in
// `test/vectors/env-merge.vectors.test.ts` (test-vectors/env-merge.json) — this file keeps only
// the hand-written cases that aren't pure vector-shaped data (the required-options-object-being-
// optional API shape, and the real-`process.env` integration checks).

describe('mergeSnapshotIntoEnv (pure core)', () => {
  it('works with no options at all — the zero-arg call is the safe default', () => {
    const target: Record<string, string | undefined> = {};
    const result = mergeSnapshotIntoEnv({ values: { FOO: 'bar' }, secretKeys: [] }, target);
    expect(target['FOO']).toBe('bar');
    expect(result.merged).toEqual(['FOO']);
    expect(result.skippedExisting).toEqual([]);
    expect(result.skippedSecrets).toEqual([]);
  });

  it('excludes secret-flagged keys by default — no acknowledgment flag required or accepted', () => {
    const target: Record<string, string | undefined> = {};
    const result = mergeSnapshotIntoEnv(
      { values: { API_URL: 'https://api.example.com', DB_PASSWORD: 'hunter2' }, secretKeys: ['DB_PASSWORD'] },
      target,
      {},
    );
    expect(target['API_URL']).toBe('https://api.example.com');
    expect(target['DB_PASSWORD']).toBeUndefined();
    expect(result.merged).toEqual(['API_URL']);
    expect(result.skippedSecrets).toEqual(['DB_PASSWORD']);
  });

  it('merges every non-null, non-secret key into an empty target', () => {
    const target: Record<string, string | undefined> = {};
    const result = mergeSnapshotIntoEnv(
      { values: { DATABASE_URL: 'postgres://x', PORT: '3000' }, secretKeys: [] },
      target,
      {},
    );
    expect(target['DATABASE_URL']).toBe('postgres://x');
    expect(target['PORT']).toBe('3000');
    expect(result.merged).toEqual(['DATABASE_URL', 'PORT']);
    expect(result.skippedExisting).toEqual([]);
    expect(result.skippedSecrets).toEqual([]);
  });

  it('skips a null-valued key entirely — never writes the string "null"', () => {
    const target: Record<string, string | undefined> = {};
    const result = mergeSnapshotIntoEnv({ values: { UNSET_KEY: null }, secretKeys: [] }, target, {});
    expect(target['UNSET_KEY']).toBeUndefined();
    expect(result.merged).toEqual([]);
    expect(result.skippedExisting).toEqual([]);
    expect(result.skippedSecrets).toEqual([]);
  });

  it('an existing target key wins by default — never overwritten', () => {
    const target: Record<string, string | undefined> = { DATABASE_URL: 'postgres://deploy-time' };
    const result = mergeSnapshotIntoEnv(
      { values: { DATABASE_URL: 'postgres://from-envpit' }, secretKeys: [] },
      target,
      {},
    );
    expect(target['DATABASE_URL']).toBe('postgres://deploy-time');
    expect(result.merged).toEqual([]);
    expect(result.skippedExisting).toEqual(['DATABASE_URL']);
  });

  it('override: true lets the fetched value win over an existing target key', () => {
    const target: Record<string, string | undefined> = { DATABASE_URL: 'postgres://deploy-time' };
    const result = mergeSnapshotIntoEnv(
      { values: { DATABASE_URL: 'postgres://from-envpit' }, secretKeys: [] },
      target,
      { override: true },
    );
    expect(target['DATABASE_URL']).toBe('postgres://from-envpit');
    expect(result.merged).toEqual(['DATABASE_URL']);
    expect(result.skippedExisting).toEqual([]);
  });

  it('override: true does NOT smuggle a secret through on its own', () => {
    const target: Record<string, string | undefined> = { DB_PASSWORD: 'already-here' };
    const result = mergeSnapshotIntoEnv(
      { values: { DB_PASSWORD: 'hunter2' }, secretKeys: ['DB_PASSWORD'] },
      target,
      { override: true },
    );
    expect(target['DB_PASSWORD']).toBe('already-here');
    expect(result.merged).toEqual([]);
    expect(result.skippedExisting).toEqual([]);
    expect(result.skippedSecrets).toEqual(['DB_PASSWORD']);
  });

  it('includeSecrets: true opts secret-flagged keys in', () => {
    const target: Record<string, string | undefined> = {};
    const result = mergeSnapshotIntoEnv(
      { values: { API_URL: 'https://api.example.com', DB_PASSWORD: 'hunter2' }, secretKeys: ['DB_PASSWORD'] },
      target,
      { includeSecrets: true },
    );
    expect(target['DB_PASSWORD']).toBe('hunter2');
    expect(result.merged).toEqual(['API_URL', 'DB_PASSWORD']);
    expect(result.skippedSecrets).toEqual([]);
  });

  it('returns merged/skippedExisting/skippedSecrets sorted, for deterministic assertions', () => {
    const target: Record<string, string | undefined> = { B_KEY: 'existing' };
    const result = mergeSnapshotIntoEnv(
      {
        values: { Z_KEY: '1', A_KEY: '2', B_KEY: 'ignored-because-existing-wins', S_SECRET: 's' },
        secretKeys: ['S_SECRET'],
      },
      target,
      {},
    );
    expect(result.merged).toEqual(['A_KEY', 'Z_KEY']);
    expect(result.skippedExisting).toEqual(['B_KEY']);
    expect(result.skippedSecrets).toEqual(['S_SECRET']);
  });
});

describe('EnvpitClient#mergeIntoProcessEnv (real process.env, save/restore per test)', () => {
  const touchedKeys = ['ENVPIT_TEST_DATABASE_URL', 'ENVPIT_TEST_ALREADY_SET', 'ENVPIT_TEST_DB_PASSWORD'];

  afterEach(() => {
    for (const key of touchedKeys) delete process.env[key];
  });

  it('writes the loaded snapshot into the real process.env with the zero-arg call', async () => {
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 0,
      fetchImpl: fakeFetch([() => jsonResponse({ ENVPIT_TEST_DATABASE_URL: 'postgres://from-envpit' })]),
    });

    const result = client.mergeIntoProcessEnv();

    expect(process.env['ENVPIT_TEST_DATABASE_URL']).toBe('postgres://from-envpit');
    expect(result.merged).toContain('ENVPIT_TEST_DATABASE_URL');
  });

  it('never overwrites a value the host process already set, by default', async () => {
    process.env['ENVPIT_TEST_ALREADY_SET'] = 'set-by-deploy-env';
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 0,
      fetchImpl: fakeFetch([() => jsonResponse({ ENVPIT_TEST_ALREADY_SET: 'set-by-envpit' })]),
    });

    const result = client.mergeIntoProcessEnv();

    expect(process.env['ENVPIT_TEST_ALREADY_SET']).toBe('set-by-deploy-env');
    expect(result.skippedExisting).toContain('ENVPIT_TEST_ALREADY_SET');
  });

  it('excludes a secret-flagged key from the real process.env by default', async () => {
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 0,
      fetchImpl: fakeFetch([
        () => jsonResponse({ ENVPIT_TEST_DB_PASSWORD: 'hunter2' }, 200, ['ENVPIT_TEST_DB_PASSWORD']),
      ]),
    });

    const result = client.mergeIntoProcessEnv();

    expect(process.env['ENVPIT_TEST_DB_PASSWORD']).toBeUndefined();
    expect(result.skippedSecrets).toContain('ENVPIT_TEST_DB_PASSWORD');
  });

  it('includeSecrets: true writes a secret-flagged key into the real process.env', async () => {
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 0,
      fetchImpl: fakeFetch([
        () => jsonResponse({ ENVPIT_TEST_DB_PASSWORD: 'hunter2' }, 200, ['ENVPIT_TEST_DB_PASSWORD']),
      ]),
    });

    const result = client.mergeIntoProcessEnv({ includeSecrets: true });

    expect(process.env['ENVPIT_TEST_DB_PASSWORD']).toBe('hunter2');
    expect(result.merged).toContain('ENVPIT_TEST_DB_PASSWORD');
  });
});
