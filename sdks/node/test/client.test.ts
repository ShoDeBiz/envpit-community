import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvpitClient } from '../src/client.js';
import { AuthenticationError, MissingKeyError, NetworkError, TypeMismatchError } from '../src/errors.js';
import { fakeFetch, jsonResponse, networkFailure, problemResponse, routedFetch } from './test-utils.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('EnvpitClient.load() — apiKey resolution', () => {
  it('rejects if no apiKey is supplied and ENVPIT_API_KEY is unset', async () => {
    const original = process.env['ENVPIT_API_KEY'];
    delete process.env['ENVPIT_API_KEY'];
    try {
      await expect(EnvpitClient.load({})).rejects.toThrow(/no API key found/i);
    } finally {
      if (original !== undefined) process.env['ENVPIT_API_KEY'] = original;
    }
  });

  it('accepts an apiKey via ENVPIT_API_KEY env var when not passed explicitly', async () => {
    process.env['ENVPIT_API_KEY'] = 'epk_env_test';
    try {
      const client = await EnvpitClient.load({
        fetchImpl: fakeFetch([() => jsonResponse({ FOO: 'bar' })]),
        pollIntervalMs: 0,
      });
      expect(client.getString('FOO')).toBe('bar');
    } finally {
      delete process.env['ENVPIT_API_KEY'];
    }
  });
});

describe('EnvpitClient.load() + typed getters (happy path)', () => {
  it('fetches the config once and serves getString/getInt/getBoolean/get synchronously', async () => {
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 0,
      fetchImpl: fakeFetch([
        () =>
          jsonResponse({
            DATABASE_URL: 'postgres://localhost/db',
            PORT: '3333',
            FEATURE_X: 'true',
            DISABLED_FLAG: 'false',
          }),
      ]),
    });

    expect(client.get('DATABASE_URL')).toBe('postgres://localhost/db');
    expect(client.getString('DATABASE_URL')).toBe('postgres://localhost/db');
    expect(client.getInt('PORT')).toBe(3333);
    expect(client.getBoolean('FEATURE_X')).toBe(true);
    expect(client.getBoolean('DISABLED_FLAG')).toBe(false);
  });
});

describe('MissingKeyError', () => {
  it('throws MissingKeyError for an absent key with no default', async () => {
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 0,
      fetchImpl: fakeFetch([() => jsonResponse({ EXISTING: 'yes' })]),
    });

    expect(() => client.get('MISSING')).toThrow(MissingKeyError);
    expect(() => client.getInt('MISSING')).toThrow(MissingKeyError);
    expect(() => client.getBoolean('MISSING')).toThrow(MissingKeyError);
  });

  it('treats a null-valued key as missing', async () => {
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 0,
      fetchImpl: fakeFetch([() => jsonResponse({ UNSET_IN_THIS_ENV: null })]),
    });
    expect(() => client.get('UNSET_IN_THIS_ENV')).toThrow(MissingKeyError);
  });

  it('returns the default instead of throwing when a default value is provided', async () => {
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 0,
      fetchImpl: fakeFetch([() => jsonResponse({})]),
    });

    expect(client.get('MISSING', 'fallback')).toBe('fallback');
    expect(client.getInt('MISSING', 42)).toBe(42);
    expect(client.getBoolean('MISSING', true)).toBe(true);
  });
});

describe('TypeMismatchError', () => {
  it('throws TypeMismatchError when getInt cannot parse the value', async () => {
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 0,
      fetchImpl: fakeFetch([() => jsonResponse({ PORT: 'not-a-number' })]),
    });
    expect(() => client.getInt('PORT')).toThrow(TypeMismatchError);
  });

  it('throws TypeMismatchError when getBoolean cannot parse the value', async () => {
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 0,
      fetchImpl: fakeFetch([() => jsonResponse({ FEATURE_X: 'maybe' })]),
    });
    expect(() => client.getBoolean('FEATURE_X')).toThrow(TypeMismatchError);
  });
});

describe('AuthenticationError', () => {
  it('rejects load() with AuthenticationError on a 401 response', async () => {
    await expect(
      EnvpitClient.load({
        apiKey: 'epk_bad',
        pollIntervalMs: 0,
        fetchImpl: fakeFetch([() => problemResponse(401)]),
      }),
    ).rejects.toThrow(AuthenticationError);
  });

  it('rejects load() with AuthenticationError on a 403 response (e.g. IP not allowlisted)', async () => {
    await expect(
      EnvpitClient.load({
        apiKey: 'epk_bad',
        pollIntervalMs: 0,
        fetchImpl: fakeFetch([() => problemResponse(403)]),
      }),
    ).rejects.toThrow(AuthenticationError);
  });
});

describe('NetworkError on first load (fatal — no cache to fall back to)', () => {
  it('rejects load() with NetworkError when the first fetch fails outright', async () => {
    await expect(
      EnvpitClient.load({
        apiKey: 'epk_test',
        pollIntervalMs: 0,
        fetchImpl: fakeFetch([networkFailure()]),
      }),
    ).rejects.toThrow(NetworkError);
  });

  it('rejects load() with NetworkError for a non-auth 5xx on first load', async () => {
    await expect(
      EnvpitClient.load({
        apiKey: 'epk_test',
        pollIntervalMs: 0,
        fetchImpl: fakeFetch([() => problemResponse(503)]),
      }),
    ).rejects.toThrow(NetworkError);
  });
});

describe('stale-while-revalidate on background refresh failure', () => {
  it('keeps serving the last good snapshot when a later refresh fails, and records the error on cacheInfo', async () => {
    vi.useFakeTimers();
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 1000,
      // routedFetch: the realtime channel also calls fetchImpl (for …/config/events) once
      // pollIntervalMs > 0 — give it its own queue so it doesn't consume these two `config`
      // responses out of order (no `events` route configured — it fails/retries quietly in
      // the background, which this test doesn't assert on).
      fetchImpl: routedFetch({ config: [() => jsonResponse({ DATABASE_URL: 'postgres://good' }), networkFailure('timeout')] }),
    });

    expect(client.get('DATABASE_URL')).toBe('postgres://good');
    expect(client.cacheInfo.lastError).toBeNull();
    const firstFetchedAt = client.cacheInfo.fetchedAt;

    // Advance past the poll interval to trigger the (failing) background refresh.
    await vi.advanceTimersByTimeAsync(1000);

    // Stale value is still served — the failed refresh must not throw or evict the cache.
    expect(client.get('DATABASE_URL')).toBe('postgres://good');
    expect(client.cacheInfo.lastError).toBeInstanceOf(NetworkError);
    expect(client.cacheInfo.fetchedAt).toEqual(firstFetchedAt);
    expect(client.cacheInfo.ageMs).toBeGreaterThanOrEqual(0);

    client.stop();
  });

  it('stop() halts background polling (no further refresh attempts)', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 1000,
      fetchImpl: routedFetch({
        config: [
          () => {
            calls += 1;
            return jsonResponse({ K: 'v' });
          },
        ],
      }),
    });

    expect(calls).toBe(1);
    client.stop();

    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(1);
  });
});
