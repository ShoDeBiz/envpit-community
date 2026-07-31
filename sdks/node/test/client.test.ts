import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvpitClient } from '../src/client.js';
import { NetworkError } from '../src/errors.js';
import { fakeFetch, jsonResponse, networkFailure, routedFetch } from './test-utils.js';

// bd:envpit-0t2z.3 Slice 0 retrofit: the typed-getter happy-path, MissingKeyError,
// TypeMismatchError, AuthenticationError, and "NetworkError on first load" describe blocks that
// used to live inline here now load from the shared `test-vectors/getters.json` /
// `test-vectors/error-mapping.json` — see `test/vectors/getters.vectors.test.ts` and
// `test/vectors/error-mapping.vectors.test.ts`. apiKey resolution and the stale-while-revalidate
// lifecycle test stay here — neither is pure input/output vector data.

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

describe('EnvpitClient.load() — host resolution (bd:envpit-ubky)', () => {
  it('falls back to the ENVPIT_HOST env var when { host } is not passed', async () => {
    const original = process.env['ENVPIT_HOST'];
    process.env['ENVPIT_HOST'] = 'http://self-hosted.internal:8080';
    try {
      const client = await EnvpitClient.load({
        apiKey: 'epk_test',
        fetchImpl: fakeFetch([() => jsonResponse({ FOO: 'bar' })]),
        pollIntervalMs: 0,
      });
      expect(String(client)).toContain('host="http://self-hosted.internal:8080"');
    } finally {
      if (original !== undefined) process.env['ENVPIT_HOST'] = original;
      else delete process.env['ENVPIT_HOST'];
    }
  });

  it('lets an explicit { host } win over the ENVPIT_HOST env var', async () => {
    const original = process.env['ENVPIT_HOST'];
    process.env['ENVPIT_HOST'] = 'http://env-host.internal:8080';
    try {
      const client = await EnvpitClient.load({
        apiKey: 'epk_test',
        host: 'http://explicit.internal:9000',
        fetchImpl: fakeFetch([() => jsonResponse({ FOO: 'bar' })]),
        pollIntervalMs: 0,
      });
      expect(String(client)).toContain('host="http://explicit.internal:9000"');
    } finally {
      if (original !== undefined) process.env['ENVPIT_HOST'] = original;
      else delete process.env['ENVPIT_HOST'];
    }
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

describe('EnvpitClient#secretKeys() — bd:envpit-durd public secret-key-names surface', () => {
  it('returns the secret-flagged key NAMES from the current snapshot', async () => {
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 0,
      fetchImpl: fakeFetch([
        () => jsonResponse({ API_URL: 'https://api.example.com', DB_PASSWORD: 'hunter2' }, 200, ['DB_PASSWORD']),
      ]),
    });

    expect(client.secretKeys()).toEqual(['DB_PASSWORD']);
    client.close();
  });

  it('returns an empty array when this environment has no secrets', async () => {
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 0,
      fetchImpl: fakeFetch([() => jsonResponse({ API_URL: 'https://api.example.com' })]),
    });

    expect(client.secretKeys()).toEqual([]);
    client.close();
  });

  it('never carries a value — only names, even for a set secret', async () => {
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 0,
      fetchImpl: fakeFetch([() => jsonResponse({ DB_PASSWORD: 'hunter2' }, 200, ['DB_PASSWORD'])]),
    });

    const serialized = JSON.stringify(client.secretKeys());
    expect(serialized).not.toContain('hunter2');
    expect(serialized).toContain('DB_PASSWORD');
    client.close();
  });
});
