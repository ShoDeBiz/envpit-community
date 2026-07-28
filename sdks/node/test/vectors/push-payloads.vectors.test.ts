/**
 * Retrofit (bd:envpit-0t2z.3 Slice 0): the `Malformed config-changed payload` cases that used to
 * live inline in `realtime-adversarial.test.ts` now load from `test-vectors/push-payloads.json`.
 * Drives the REAL `EnvpitClient` end-to-end (not just the frame parser) — proving each vector's
 * `expectedBehavior` against the shipped push -> refetch decision in `realtime-transport.ts` /
 * `client.ts`.
 */
import { describe, expect, it } from 'vitest';
import { EnvpitClient } from '../../src/client.js';
import type { ChangeEvent } from '../../src/types.js';
import { jsonResponse, routedFetch } from '../test-utils.js';
import { loadVectors } from '../vector-loader.js';

interface PushPayloadVectorCase {
  name: string;
  event: string;
  data: string;
  expectedBehavior: 'refetch' | 'ignore';
  expectedEtag?: string;
}
interface PushPayloadVectors {
  cases: PushPayloadVectorCase[];
}

const vectors = loadVectors<PushPayloadVectors>('push-payloads.json');

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

describe('EnvpitClient realtime — test-vectors/push-payloads.json', () => {
  for (const c of vectors.cases) {
    it(c.name, async () => {
      const sse = sseResponse();
      const logger = { lines: [] as string[], error: (m: string) => void logger.lines.push(m) };
      const configResponses =
        c.expectedBehavior === 'refetch'
          ? [
              () => jsonResponse({ K: 'v0' }),
              () =>
                new Response(JSON.stringify({ values: { K: 'v1' }, secretKeys: [] }), {
                  status: 200,
                  headers: { 'content-type': 'application/json', etag: c.expectedEtag ?? '' },
                }),
            ]
          : [() => jsonResponse({ K: 'v0' })];

      const client = await EnvpitClient.load({
        apiKey: 'epk_test',
        pollIntervalMs: 60_000,
        logger,
        fetchImpl: routedFetch({ config: configResponses, events: [() => sse.response] }),
      });
      await flushMicrotasks();

      const changes: ChangeEvent[] = [];
      const errors: Error[] = [];
      client.on('change', (e) => changes.push(e));
      client.on('error', (e) => errors.push(e));

      expect(() => sse.push(`event: ${c.event}\ndata: ${c.data}\n\n`)).not.toThrow();
      await flushMicrotasks();

      expect(errors).toHaveLength(0); // no adversarial push payload ever produces an `error` event
      expect(logger.lines).toHaveLength(0); // and none of them are severe enough to log an error line

      if (c.expectedBehavior === 'refetch') {
        expect(changes).toHaveLength(1);
        expect(changes[0]?.etag).toBe(c.expectedEtag);
        expect(client.get('K')).toBe('v1');
      } else {
        expect(changes).toHaveLength(0);
        expect(client.get('K')).toBe('v0'); // untouched — no spurious refetch happened
      }

      client.close();
    });
  }
});
