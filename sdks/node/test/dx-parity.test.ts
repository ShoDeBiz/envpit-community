/**
 * bd:envpit-ed3h Part 3 — DX-copy parity per `outputs/SPEC-envpit-0t2z-1b-ux.md` §A1/§A3:
 *   - `getOptional('KEY') -> string | undefined`, the non-throwing counterpart to `get()`.
 *   - `MissingKeyError` did-you-mean: nearest-key fuzzy suggestion against the loaded snapshot's
 *     own key set.
 * (Stable `.code`/`.docsAnchor` on every error class is covered in `test/errors.test.ts` — a
 * pure taxonomy concern that doesn't need a live `EnvpitClient`.)
 */
import { describe, expect, it } from 'vitest';
import { EnvpitClient } from '../src/client.js';
import { MissingKeyError } from '../src/errors.js';
import { fakeFetch, jsonResponse } from './test-utils.js';

describe('EnvpitClient#getOptional — non-throwing counterpart to get()', () => {
  it('returns the value when the key is present', async () => {
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 0,
      fetchImpl: fakeFetch([() => jsonResponse({ DATABASE_URL: 'postgres://good' })]),
    });
    expect(client.getOptional('DATABASE_URL')).toBe('postgres://good');
    client.close();
  });

  it('returns undefined (never throws) when the key is absent', async () => {
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 0,
      fetchImpl: fakeFetch([() => jsonResponse({ DATABASE_URL: 'postgres://good' })]),
    });
    expect(client.getOptional('NOT_SET')).toBeUndefined();
    client.close();
  });

  it('returns undefined for a key whose stored value is null (same missing-vs-null equivalence as get())', async () => {
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 0,
      fetchImpl: fakeFetch([() => jsonResponse({ FEATURE_X: null })]),
    });
    expect(client.getOptional('FEATURE_X')).toBeUndefined();
    client.close();
  });
});

describe('MissingKeyError did-you-mean — nearest-key suggestion (bd:envpit-ed3h Part 3)', () => {
  it('suggests the nearest known key on a near-miss typo (edit distance <= 2)', async () => {
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 0,
      fetchImpl: fakeFetch([() => jsonResponse({ DATABASE_URL: 'postgres://good', API_TOKEN: 'x' })]),
    });
    try {
      client.get('DATABSE_URL'); // 1-char transposition/drop of DATABASE_URL
      throw new Error('expected MissingKeyError');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingKeyError);
      const missingKeyError = err as MissingKeyError;
      expect(missingKeyError.suggestion).toBe('DATABASE_URL');
      expect(missingKeyError.message).toContain('Did you mean "DATABASE_URL"?');
    } finally {
      client.close();
    }
  });

  it('no suggestion when nothing is close enough (edit distance > 2) — message unchanged, suggestion undefined', async () => {
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 0,
      fetchImpl: fakeFetch([() => jsonResponse({ DATABASE_URL: 'postgres://good' })]),
    });
    try {
      client.get('COMPLETELY_UNRELATED_THING');
      throw new Error('expected MissingKeyError');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingKeyError);
      const missingKeyError = err as MissingKeyError;
      expect(missingKeyError.suggestion).toBeUndefined();
      expect(missingKeyError.message).not.toContain('Did you mean');
    } finally {
      client.close();
    }
  });

  it('no suggestion (and no crash) when the snapshot is empty', async () => {
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 0,
      fetchImpl: fakeFetch([() => jsonResponse({})]),
    });
    try {
      client.get('DATABASE_URL');
      throw new Error('expected MissingKeyError');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingKeyError);
      expect((err as MissingKeyError).suggestion).toBeUndefined();
    } finally {
      client.close();
    }
  });

  it('did-you-mean also fires through getInt()/getBoolean(), not just get()', async () => {
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 0,
      fetchImpl: fakeFetch([() => jsonResponse({ PORT: '3000', DEBUG: 'true' })]),
    });
    try {
      expect(() => client.getInt('PROT')).toThrow(/Did you mean "PORT"\?/);
      expect(() => client.getBoolean('DEBUG_')).toThrow(/Did you mean "DEBUG"\?/);
    } finally {
      client.close();
    }
  });
});
