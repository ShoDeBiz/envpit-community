/**
 * `EnvpitClient`-level integration tests for bd:envpit-ed3h Part 1 (client-side conditional GET)
 * — the `fetchConfig`-level wire behavior is covered in `test/transport.test.ts`; this file
 * proves `EnvpitClient.refresh()` actually wires its stored `etag` into every subsequent
 * request, and that a `304` response is applied correctly (cached snapshot reused, no spurious
 * `change` event, freshness timestamp still advances).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvpitClient } from '../src/client.js';
import { NetworkError } from '../src/errors.js';
import type { ChangeEvent } from '../src/types.js';
import { routedFetch } from './test-utils.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('EnvpitClient — conditional GET on background poll refresh (bd:envpit-ed3h Part 1)', () => {
  it('sends If-None-Match on the 2nd fetch, carrying the etag captured from the 1st', async () => {
    vi.useFakeTimers();
    // pollIntervalMs > 0 ALSO opens the realtime (SSE) channel, which independently calls
    // `fetchImpl` for `.../config/events` — filter by URL so that call stream doesn't perturb
    // the `.../config` call-ordering this test asserts on (same technique `routedFetch` uses,
    // see test-utils.ts).
    const seenConfigHeaders: Headers[] = [];
    let configCall = 0;
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const isConfigCall = !String(url).endsWith('/config/events');
      if (!isConfigCall) {
        return new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      seenConfigHeaders.push(new Headers(init?.headers));
      configCall += 1;
      if (configCall === 1) {
        return new Response(JSON.stringify({ values: { K: 'v0' }, secretKeys: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json', etag: '"etag-1"' },
        });
      }
      return new Response(null, { status: 304 });
    }) as unknown as typeof fetch;

    const client = await EnvpitClient.load({ apiKey: 'epk_test', pollIntervalMs: 1000, fetchImpl });

    expect(seenConfigHeaders[0]?.has('if-none-match')).toBe(false); // first load: nothing to revalidate yet

    await vi.advanceTimersByTimeAsync(1000);

    expect(seenConfigHeaders[1]?.get('if-none-match')).toBe('"etag-1"');
    client.stop();
  });

  it('a 304 response reuses the cached snapshot without re-parsing, keeps the same etag, and fires no `change` event', async () => {
    vi.useFakeTimers();
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 1000,
      fetchImpl: routedFetch({
        config: [
          () =>
            new Response(JSON.stringify({ values: { DATABASE_URL: 'postgres://good' }, secretKeys: [] }), {
              status: 200,
              headers: { 'content-type': 'application/json', etag: '"etag-1"' },
            }),
          () => new Response(null, { status: 304 }),
        ],
      }),
    });

    expect(client.get('DATABASE_URL')).toBe('postgres://good');
    expect(client.cacheInfo.etag).toBe('"etag-1"');
    const firstFetchedAt = client.cacheInfo.fetchedAt;

    const changes: ChangeEvent[] = [];
    client.on('change', (e) => changes.push(e));

    await vi.advanceTimersByTimeAsync(1000);

    // Reused, unchanged snapshot + etag; no spurious change event; freshness (fetchedAt)
    // still advances because a 304 IS a successful revalidation, just with nothing new to apply.
    expect(client.get('DATABASE_URL')).toBe('postgres://good');
    expect(client.cacheInfo.etag).toBe('"etag-1"');
    expect(client.cacheInfo.lastError).toBeNull();
    expect(changes).toHaveLength(0);
    expect(client.cacheInfo.fetchedAt).not.toEqual(firstFetchedAt);

    client.stop();
  });

  it('bd:envpit-ed3h loop iter-2, Chris High #1 — an unsolicited 304 on the VERY FIRST load ' +
    '(no If-None-Match was sent — etag is null, there is nothing cached to revalidate against) ' +
    'rejects load() with NetworkError instead of silently resolving into a broken null-snapshot ' +
    'client', async () => {
    const client = EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 0,
      fetchImpl: routedFetch({
        config: [() => new Response(null, { status: 304 })],
      }),
    });

    await expect(client).rejects.toThrow(NetworkError);
    await expect(client).rejects.toThrow(/unexpected 304/i);
  });
});
