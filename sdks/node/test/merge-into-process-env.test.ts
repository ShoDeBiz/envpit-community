import { afterEach, describe, expect, it } from 'vitest';
import { EnvpitClient } from '../src/client.js';
import { mergeSnapshotIntoEnv } from '../src/process-env-merge.js';
import { fakeFetch, jsonResponse } from './test-utils.js';

// bd:envpit-yvyr — "merge into the native mechanism" (process.env), owner directive
// 2026-07-27. Two layers under test:
//   1. `mergeSnapshotIntoEnv` — the pure core (snapshot + target object + options -> result),
//      no real `process.env` mutation, so most cases live here.
//   2. `EnvpitClient#mergeIntoProcessEnv` — the thin wrapper that reads `this.snapshot` and
//      writes the REAL `process.env` (a couple of integration-style checks only).

describe('mergeSnapshotIntoEnv (pure core)', () => {
  it('requires `acknowledgeSecretsMayBeIncluded: true` — throws a plain Error if omitted', () => {
    expect(() =>
      // @ts-expect-error — deliberately omitting the required field to assert the runtime guard
      // a plain-JS caller (no type-checker) would otherwise sail past.
      mergeSnapshotIntoEnv({ FOO: 'bar' }, {}, {}),
    ).toThrow(/acknowledgeSecretsMayBeIncluded/);
  });

  it('throws if `acknowledgeSecretsMayBeIncluded` is explicitly false', () => {
    expect(() =>
      mergeSnapshotIntoEnv(
        { FOO: 'bar' },
        {},
        // @ts-expect-error — same as above, exercising the runtime guard's else-branch.
        { acknowledgeSecretsMayBeIncluded: false },
      ),
    ).toThrow(/acknowledgeSecretsMayBeIncluded/);
  });

  it('merges every non-null key into an empty target', () => {
    const target: Record<string, string | undefined> = {};
    const result = mergeSnapshotIntoEnv(
      { DATABASE_URL: 'postgres://x', PORT: '3000' },
      target,
      { acknowledgeSecretsMayBeIncluded: true },
    );
    expect(target['DATABASE_URL']).toBe('postgres://x');
    expect(target['PORT']).toBe('3000');
    expect(result.merged).toEqual(['DATABASE_URL', 'PORT']);
    expect(result.skippedExisting).toEqual([]);
  });

  it('skips a null-valued key entirely — never writes the string "null"', () => {
    const target: Record<string, string | undefined> = {};
    const result = mergeSnapshotIntoEnv({ UNSET_KEY: null }, target, {
      acknowledgeSecretsMayBeIncluded: true,
    });
    expect(target['UNSET_KEY']).toBeUndefined();
    expect(result.merged).toEqual([]);
    expect(result.skippedExisting).toEqual([]);
  });

  it('an existing target key wins by default — never overwritten', () => {
    const target: Record<string, string | undefined> = { DATABASE_URL: 'postgres://deploy-time' };
    const result = mergeSnapshotIntoEnv({ DATABASE_URL: 'postgres://from-envpit' }, target, {
      acknowledgeSecretsMayBeIncluded: true,
    });
    expect(target['DATABASE_URL']).toBe('postgres://deploy-time');
    expect(result.merged).toEqual([]);
    expect(result.skippedExisting).toEqual(['DATABASE_URL']);
  });

  it('override: true lets the fetched value win over an existing target key', () => {
    const target: Record<string, string | undefined> = { DATABASE_URL: 'postgres://deploy-time' };
    const result = mergeSnapshotIntoEnv(
      { DATABASE_URL: 'postgres://from-envpit' },
      target,
      { acknowledgeSecretsMayBeIncluded: true, override: true },
    );
    expect(target['DATABASE_URL']).toBe('postgres://from-envpit');
    expect(result.merged).toEqual(['DATABASE_URL']);
    expect(result.skippedExisting).toEqual([]);
  });

  it('returns merged/skippedExisting sorted, for deterministic assertions', () => {
    const target: Record<string, string | undefined> = { B_KEY: 'existing' };
    const result = mergeSnapshotIntoEnv(
      { Z_KEY: '1', A_KEY: '2', B_KEY: 'ignored-because-existing-wins' },
      target,
      { acknowledgeSecretsMayBeIncluded: true },
    );
    expect(result.merged).toEqual(['A_KEY', 'Z_KEY']);
    expect(result.skippedExisting).toEqual(['B_KEY']);
  });
});

describe('EnvpitClient#mergeIntoProcessEnv (real process.env, save/restore per test)', () => {
  const touchedKeys = ['ENVPIT_TEST_DATABASE_URL', 'ENVPIT_TEST_ALREADY_SET'];

  afterEach(() => {
    for (const key of touchedKeys) delete process.env[key];
  });

  it('writes the loaded snapshot into the real process.env', async () => {
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 0,
      fetchImpl: fakeFetch([() => jsonResponse({ ENVPIT_TEST_DATABASE_URL: 'postgres://from-envpit' })]),
    });

    const result = client.mergeIntoProcessEnv({ acknowledgeSecretsMayBeIncluded: true });

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

    const result = client.mergeIntoProcessEnv({ acknowledgeSecretsMayBeIncluded: true });

    expect(process.env['ENVPIT_TEST_ALREADY_SET']).toBe('set-by-deploy-env');
    expect(result.skippedExisting).toContain('ENVPIT_TEST_ALREADY_SET');
  });

  it('does not accidentally merge before acknowledging (no default true)', async () => {
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 0,
      fetchImpl: fakeFetch([() => jsonResponse({ ENVPIT_TEST_DATABASE_URL: 'postgres://from-envpit' })]),
    });

    // @ts-expect-error — the whole point: TS refuses to compile a call missing the
    // required, loud acknowledgment flag.
    expect(() => client.mergeIntoProcessEnv({})).toThrow(/acknowledgeSecretsMayBeIncluded/);
    expect(process.env['ENVPIT_TEST_DATABASE_URL']).toBeUndefined();
  });
});
