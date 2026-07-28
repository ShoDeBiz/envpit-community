/**
 * New (bd:envpit-0t2z.3 Slice 0) — closes three CONFORMANCE.md gaps identified while writing
 * `../../test-vectors/CONFORMANCE.md`'s Node-coverage column: real, previously-unasserted
 * behavior (not new runtime code) that had no dedicated test. Each `it()` name embeds its
 * `INV-SDK-N` id per the shared suite's naming convention (`test-vectors/README.md` §"Adding a
 * language" / `CONFORMANCE.md`'s own rule) so a future ID-grep CI gate can find it.
 */
import { describe, expect, it } from 'vitest';
import { EnvpitClient } from '../src/client.js';
import type { ChangeEvent } from '../src/types.js';
import { jsonResponse, routedFetch } from './test-utils.js';

function sseResponse(): { response: Response; push: (frame: string) => void } {
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
    },
  });
  const response = new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const encoder = new TextEncoder();
  return { response, push: (frame: string) => controllerRef?.enqueue(encoder.encode(frame)) };
}

async function flushMicrotasks(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('INV-SDK-9 — etag dedup on push (client.ts handlePushSignal)', () => {
  it('INV-SDK-9: a config-changed push carrying the SAME etag the client already has does not trigger a refetch', async () => {
    const sse = sseResponse();
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 60_000,
      fetchImpl: routedFetch({
        // Only ONE config response queued. If the duplicate-etag push triggered a refetch,
        // routedFetch throws "no route configured" and this test fails loudly.
        config: [
          () =>
            new Response(JSON.stringify({ values: { K: 'v0' }, secretKeys: [] }), {
              status: 200,
              headers: { 'content-type': 'application/json', etag: '"same-etag"' },
            }),
        ],
        events: [() => sse.response],
      }),
    });
    await flushMicrotasks();
    expect(client.cacheInfo.etag).toBe('"same-etag"');

    const changes: ChangeEvent[] = [];
    client.on('change', (e) => changes.push(e));

    expect(() => sse.push('event: config-changed\ndata: {"etag":"\\"same-etag\\""}\n\n')).not.toThrow();
    await flushMicrotasks();

    expect(changes).toHaveLength(0); // deduped — no refetch, no change event
    client.close();
  });
});

describe('INV-SDK-12 — auth header is X-Api-Key, never Authorization', () => {
  it('INV-SDK-12: the config fetch sends X-Api-Key and does NOT send an Authorization header', async () => {
    let seenHeaders: Headers | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      seenHeaders = new Headers(init?.headers);
      return jsonResponse({ K: 'v' });
    }) as unknown as typeof fetch;

    const client = await EnvpitClient.load({ apiKey: 'epk_test', pollIntervalMs: 0, fetchImpl });

    expect(seenHeaders?.get('x-api-key')).toBe('epk_test');
    expect(seenHeaders?.has('authorization')).toBe(false);
    client.close();
  });
});

describe('INV-SDK-11 — no config value or API key ever appears in an error message', () => {
  it('INV-SDK-11: every EnvpitError thrown across the public surface is free of the injected apiKey substring', async () => {
    const secretLookingApiKey = 'epk_super-secret-do-not-leak-this-value';
    const thrownMessages: string[] = [];

    // First-load 401 -> AuthenticationError.
    try {
      await EnvpitClient.load({
        apiKey: secretLookingApiKey,
        pollIntervalMs: 0,
        fetchImpl: (async () => new Response(null, { status: 401 })) as unknown as typeof fetch,
      });
    } catch (err) {
      if (err instanceof Error) thrownMessages.push(err.message);
    }

    // First-load network failure -> NetworkError.
    try {
      await EnvpitClient.load({
        apiKey: secretLookingApiKey,
        pollIntervalMs: 0,
        fetchImpl: (async () => {
          throw new TypeError('connect ECONNREFUSED');
        }) as unknown as typeof fetch,
      });
    } catch (err) {
      if (err instanceof Error) thrownMessages.push(err.message);
    }

    // MissingKeyError / TypeMismatchError from the loaded client's own getters.
    const client = await EnvpitClient.load({
      apiKey: secretLookingApiKey,
      pollIntervalMs: 0,
      fetchImpl: (async () => jsonResponse({ PORT: 'not-a-number' })) as unknown as typeof fetch,
    });
    try {
      client.get('MISSING_KEY');
    } catch (err) {
      if (err instanceof Error) thrownMessages.push(err.message);
    }
    try {
      client.getInt('PORT');
    } catch (err) {
      if (err instanceof Error) thrownMessages.push(err.message);
    }
    client.close();

    expect(thrownMessages.length).toBeGreaterThan(0);
    for (const message of thrownMessages) {
      expect(message).not.toContain(secretLookingApiKey);
    }
    // Sanity — proves the try/catch blocks above actually exercised all 4 intended throw paths,
    // not silently caught nothing.
    expect(thrownMessages.length).toBe(4);
  });
});
