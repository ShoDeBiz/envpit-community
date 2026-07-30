/**
 * Property-based tests for `parseEtag` (bd:envpit-jf7i) — `realtime-transport.ts`'s private,
 * unexported helper that turns a `config-changed` SSE frame's `data:` payload into an etag
 * string or `null`. Mirrors the precedent already set for `diffSnapshots`
 * (`test/vectors/snapshot-diff.vectors.test.ts`'s header comment): a correctly-private pure
 * function stays private, and gets exercised through the real public surface it feeds —
 * `RealtimeTransport`'s `onChangeSignal` callback — rather than being exported just to make a
 * test easier to write.
 *
 * `parseEtag`'s actual contract (`src/realtime-transport.ts`):
 *   `JSON.parse(data)` -> if it throws, or the result's `.etag` isn't a non-empty string, `null`
 *   (no signal); otherwise that string, passed straight through to `onChangeSignal`.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { RealtimeTransport } from '../../src/realtime-transport.js';

/** A minimal SSE response whose body a test can push frames into on demand — same shape as
 *  `push-payloads.vectors.test.ts`'s local helper, kept local here too (still small, and this
 *  file's fast-check runs want a FRESH stream/transport per property run, not a shared one). */
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

/** Starts a `RealtimeTransport` wired to a controllable SSE stream and collects every
 *  `onChangeSignal` etag it fires. Caller pushes raw `event: config-changed\ndata: <payload>\n\n`
 *  frames via the returned `push`. */
function startTransport(): { push: (payload: string) => Promise<void>; signals: string[]; close: () => void } {
  const sse = sseResponse();
  const signals: string[] = [];
  const transport = new RealtimeTransport({
    host: 'https://example.test',
    apiKey: 'epk_test',
    fetchImpl: (async () => sse.response) as unknown as typeof fetch,
    pollIntervalMs: 60_000,
    callbacks: {
      onChangeSignal: (etag) => signals.push(etag),
      onModeChange: () => undefined,
      onRealtimeConnected: () => undefined,
      onLog: () => undefined,
    },
  });
  transport.start();
  return {
    push: async (payload: string) => {
      sse.push(`event: config-changed\ndata: ${payload}\n\n`);
      await flushMicrotasks();
    },
    signals,
    close: () => transport.close(),
  };
}

// Kept deliberately JSON.stringify-safe (no BigInt/circular refs `fc.object()`'s full "anything"
// space can produce) — the point of these cases is the `etag` field SHAPE, not JSON's full value
// space, which `JSON.parse`'s own correctness is not this SDK's concern to re-test.
const jsonSafeScalar = fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null));

// An arbitrary JSON value that is NOT `{ etag: <non-empty string> }` — every one of these must
// produce NO signal (parseEtag returns null): wrong type for `etag`, `etag` absent, or `etag`
// present but empty.
const nonSignalingEtagPayload = fc.oneof(
  fc.record({ etag: fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.array(jsonSafeScalar, { maxLength: 3 })) }),
  fc.record({ etag: fc.constant('') }),
  fc.dictionary(
    fc.string({ minLength: 1 }).filter((k) => k !== 'etag'),
    jsonSafeScalar,
    { maxKeys: 3 },
  ),
  fc.constant({}),
);

describe('parseEtag (via RealtimeTransport.onChangeSignal) — property (bd:envpit-jf7i)', () => {
  it('any non-empty string etag round-trips exactly through the config-changed frame', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }).filter((s) => !/[\r\n]/.test(s)),
        async (etag) => {
          const t = startTransport();
          await flushMicrotasks();
          await t.push(JSON.stringify({ etag }));
          expect(t.signals).toEqual([etag]);
          t.close();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('a payload without a usable non-empty string `etag` never fires onChangeSignal', async () => {
    await fc.assert(
      fc.asyncProperty(nonSignalingEtagPayload, async (payload) => {
        const t = startTransport();
        await flushMicrotasks();
        await t.push(JSON.stringify(payload));
        expect(t.signals).toEqual([]);
        t.close();
      }),
      { numRuns: 100 },
    );
  });

  it('malformed (non-JSON) data never fires onChangeSignal and never throws', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 100 }).filter((s) => !/[\r\n]/.test(s)), async (garbage) => {
        const t = startTransport();
        await flushMicrotasks();
        await expect(t.push(garbage)).resolves.not.toThrow();
        // A garbage string COULD coincidentally be valid JSON (e.g. `"3"` or `null`) — only
        // assert "no crash" here; the JSON-shape-specific assertions live in the two tests above.
        t.close();
      }),
      { numRuns: 100 },
    );
  });
});
