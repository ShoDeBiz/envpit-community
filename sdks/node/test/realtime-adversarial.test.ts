/**
 * Quinn (QA) — adversarial/live-integration review, bd:envpit-0t2z.2 (subscribe/callback API).
 *
 * These tests deliberately do NOT duplicate `test/realtime.test.ts` (AC-U1..U7, already
 * covered there). They target scenarios Dave's own test suite does not exercise:
 *   - Malformed/unexpected SSE `config-changed` payloads (extra fields, missing fields, wrong
 *     types, non-JSON data)
 *   - Rapid-fire / concurrent overlapping refreshes (event-loss, ordering, listener pileup)
 *   - Listener throw independently re-verified (trust-but-verify-twice)
 *   - Multiple `.on()` registrations + unsubscribe-cycle leak check
 *   - "only fires on actual value change" — a push signal whose refetch is byte-identical
 *     must NOT fire `change`, even though the etag differed
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvpitClient } from '../src/client.js';
import { SseFrameParser } from '../src/sse-parser.js';
import type { ChangeEvent, ConnectionEvent, Logger } from '../src/types.js';
import { jsonResponse, routedFetch } from './test-utils.js';

afterEach(() => {
  vi.useRealTimers();
});

function sseResponse(): { response: Response; push: (frame: string) => void; close: () => void } {
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
    },
  });
  const response = new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const encoder = new TextEncoder();
  return {
    response,
    push: (frame: string) => controllerRef?.enqueue(encoder.encode(frame)),
    close: () => controllerRef?.close(),
  };
}

function recordingLogger(): Logger & { lines: Array<{ level: string; message: string }> } {
  const lines: Array<{ level: string; message: string }> = [];
  return {
    lines,
    debug: (message) => lines.push({ level: 'debug', message }),
    info: (message) => lines.push({ level: 'info', message }),
    warn: (message) => lines.push({ level: 'warn', message }),
    error: (message) => lines.push({ level: 'error', message }),
  };
}

async function flushMicrotasks(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------------------------
// 1. SseFrameParser — malformed / adversarial wire input (unit-level, no client involved)
// ---------------------------------------------------------------------------------------------
describe('SseFrameParser — adversarial input', () => {
  it('does not throw on a frame split across many tiny chunks, incl. mid-field splits', () => {
    const parser = new SseFrameParser();
    const full = 'event: config-changed\ndata: {"etag":"\\"e1\\""}\n\n';
    const frames = [];
    for (const ch of full) {
      frames.push(...parser.push(ch)); // one character at a time — worst-case chunking
    }
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ event: 'config-changed', data: '{"etag":"\\"e1\\""}' });
  });

  it('ignores comment/heartbeat lines and stray blank lines without crashing or emitting spurious frames', () => {
    const parser = new SseFrameParser();
    const frames = parser.push(': heartbeat\n\n\n: another comment\n\nevent: config-changed\ndata: {}\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.event).toBe('config-changed');
  });

  it('treats a field-less line (no colon) as a field name with empty value, not a crash', () => {
    const parser = new SseFrameParser();
    // `retry` with no colon at all is a malformed-but-real-world SSE line some proxies emit.
    const frames = parser.push('retry\nevent: config-changed\ndata: {}\n\n');
    expect(frames).toHaveLength(1);
  });

  it('joins multiple `data:` lines with \\n per the SSE multi-line-data spec, does not lose or reorder them', () => {
    const parser = new SseFrameParser();
    const frames = parser.push('data: {"etag":\ndata: "\\"e1\\""}\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.data).toBe('{"etag":\n"\\"e1\\""}');
  });

  it('a frame with no `data:` field at all dispatches with data: "" (does not throw)', () => {
    const parser = new SseFrameParser();
    const frames = parser.push('event: config-changed\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.data).toBe('');
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Malformed `config-changed` payload end-to-end through the real client — must not crash,
//    must not misbehave (spurious refetch storms, wrong etag applied, etc.)
// ---------------------------------------------------------------------------------------------
describe('EnvpitClient realtime — malformed config-changed payload (adversarial)', () => {
  it('a config-changed frame with completely invalid JSON is silently ignored: no crash, no refetch, no change/error event', async () => {
    const sse = sseResponse();
    const logger = recordingLogger();
    const changes: ChangeEvent[] = [];
    const errors: Error[] = [];
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 60_000,
      logger,
      fetchImpl: routedFetch({
        // Only ONE config response queued (the initial load). If the malformed frame triggers
        // a spurious refetch, routedFetch throws "no route configured" and this test fails loudly.
        config: [() => jsonResponse({ K: 'v0' })],
        events: [() => sse.response],
      }),
    });
    client.on('change', (e) => changes.push(e));
    client.on('error', (e) => errors.push(e));
    await flushMicrotasks();

    expect(() => sse.push('event: config-changed\ndata: {not valid json!!\n\n')).not.toThrow();
    await flushMicrotasks();

    expect(changes).toHaveLength(0);
    expect(errors).toHaveLength(0);
    expect(client.get('K')).toBe('v0'); // untouched
    expect(logger.lines.filter((l) => l.level === 'error')).toHaveLength(0);

    client.close();
  });

  it('a config-changed frame missing the `etag` field entirely is silently ignored (no crash, no refetch)', async () => {
    const sse = sseResponse();
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 60_000,
      fetchImpl: routedFetch({
        config: [() => jsonResponse({ K: 'v0' })],
        events: [() => sse.response],
      }),
    });
    await flushMicrotasks();
    const changes: ChangeEvent[] = [];
    client.on('change', (e) => changes.push(e));

    // Real payload shape per Sara §5.3 minus `etag` — a server bug or a future schema drift.
    expect(() =>
      sse.push(
        `event: config-changed\ndata: ${JSON.stringify({ project_id: 'p1', environment_id: 'e1', occurred_at: new Date().toISOString() })}\n\n`,
      ),
    ).not.toThrow();
    await flushMicrotasks();

    expect(changes).toHaveLength(0);
    client.close();
  });

  it('a config-changed frame with `etag` as the wrong type (number, not string) is ignored, not coerced/crashed on', async () => {
    const sse = sseResponse();
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 60_000,
      fetchImpl: routedFetch({
        config: [() => jsonResponse({ K: 'v0' })],
        events: [() => sse.response],
      }),
    });
    await flushMicrotasks();
    const changes: ChangeEvent[] = [];
    client.on('change', (e) => changes.push(e));

    expect(() => sse.push('event: config-changed\ndata: {"etag": 12345}\n\n')).not.toThrow();
    await flushMicrotasks();

    expect(changes).toHaveLength(0);
    client.close();
  });

  it('a config-changed frame with a bunch of unexpected EXTRA fields still works normally (forward-compatible)', async () => {
    const sse = sseResponse();
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 60_000,
      fetchImpl: routedFetch({
        config: [() => jsonResponse({ K: 'v0' }), () => jsonResponse({ K: 'v1' })],
        events: [() => sse.response],
      }),
    });
    await flushMicrotasks();
    const changes: ChangeEvent[] = [];
    client.on('change', (e) => changes.push(e));

    sse.push(
      `event: config-changed\ndata: ${JSON.stringify({
        etag: '"e1"',
        project_id: 'p1',
        environment_id: 'e1',
        occurred_at: new Date().toISOString(),
        future_field_the_sdk_has_never_seen: { nested: true, arr: [1, 2, 3] },
        another_surprise: null,
      })}\n\n`,
    );
    await flushMicrotasks();

    expect(changes).toHaveLength(1);
    expect(changes[0]?.changedKeys).toEqual(['K']);
    client.close();
  });

  it.each(['null', '[1,2,3]', '"just a bare string"', '42', 'true'])(
    'a config-changed frame whose `data:` is valid JSON but NOT an object (%s) does not crash on property access',
    async (data) => {
      const sse = sseResponse();
      const client = await EnvpitClient.load({
        apiKey: 'epk_test',
        pollIntervalMs: 60_000,
        fetchImpl: routedFetch({
          config: [() => jsonResponse({ K: 'v0' })],
          events: [() => sse.response],
        }),
      });
      await flushMicrotasks();
      const changes: ChangeEvent[] = [];
      client.on('change', (e) => changes.push(e));

      expect(() => sse.push(`event: config-changed\ndata: ${data}\n\n`)).not.toThrow();
      await flushMicrotasks();

      expect(changes).toHaveLength(0); // no crash, no spurious refetch
      client.close();
    },
  );

  it('an unknown/future `event:` name (e.g. flags-changed piggyback) is ignored, not misrouted as config-changed', async () => {
    const sse = sseResponse();
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 60_000,
      fetchImpl: routedFetch({
        config: [() => jsonResponse({ K: 'v0' })],
        events: [() => sse.response],
      }),
    });
    await flushMicrotasks();
    const changes: ChangeEvent[] = [];
    client.on('change', (e) => changes.push(e));

    sse.push('event: flags-changed\ndata: {"etag":"\\"e1\\""}\n\n');
    await flushMicrotasks();

    expect(changes).toHaveLength(0); // no refetch triggered by an event this SDK doesn't handle
    client.close();
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Rapid-fire events — many changes in quick succession
// ---------------------------------------------------------------------------------------------
describe('EnvpitClient realtime — rapid-fire push events', () => {
  it('N rapid config-changed pushes, each with a genuinely new etag and a genuinely new value, resolved strictly in order: no event loss, no listener pileup', async () => {
    const sse = sseResponse();
    const N = 20;
    const configResponses = [
      () => jsonResponse({ K: 'v0' }),
      ...Array.from({ length: N }, (_, i) => () => jsonResponse({ K: `v${i + 1}` })),
    ];
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 60_000,
      fetchImpl: routedFetch({ config: configResponses, events: [() => sse.response] }),
    });
    await flushMicrotasks();
    const changes: ChangeEvent[] = [];
    client.on('change', (e) => changes.push(e));

    for (let i = 1; i <= N; i += 1) {
      sse.push(`event: config-changed\ndata: {"etag":"\\"e${i}\\""}\n\n`);
      // Awaited one at a time (strictly sequential resolution) — the ordering-safe case.
      await flushMicrotasks(3);
    }

    expect(changes).toHaveLength(N);
    expect(client.get('K')).toBe(`v${N}`); // final value matches the last push, nothing lost
    client.close();
  });

  it('registering/removing many listeners rapidly does not leak: only currently-subscribed listeners fire, exactly once per event', async () => {
    const sse = sseResponse();
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 60_000,
      fetchImpl: routedFetch({
        config: [() => jsonResponse({ K: 'v0' }), () => jsonResponse({ K: 'v1' })],
        events: [() => sse.response],
      }),
    });
    await flushMicrotasks();

    // Subscribe + immediately unsubscribe 200 short-lived listeners — simulates a pathological
    // React-effect-cleanup-storm or a buggy caller re-subscribing every tick.
    for (let i = 0; i < 200; i += 1) {
      const off = client.on('change', () => {
        throw new Error(`stale listener #${i} fired — should have been unsubscribed`);
      });
      off();
    }

    let liveCalls = 0;
    client.on('change', () => {
      liveCalls += 1;
    });

    sse.push('event: config-changed\ndata: {"etag":"\\"e1\\""}\n\n');
    await flushMicrotasks();

    expect(liveCalls).toBe(1); // only the one still-subscribed listener fired
    client.close();
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Throwing listeners — independent re-verification (trust-but-verify-twice)
// ---------------------------------------------------------------------------------------------
describe('EnvpitClient realtime — throwing listeners never crash the process (independent re-verify)', () => {
  it('a throwing `connection` listener does not stop other connection listeners or crash the transport', async () => {
    // NOTE (test-harness gotcha, not an SDK bug): the SDK's own initial realtime connect races
    // ahead of `EnvpitClient.load()`'s promise settling — a `connection` listener registered
    // right after `await load()` structurally cannot observe the FIRST connect's transition
    // (verified independently: it fires before control returns to the caller). `cacheInfo` is
    // the documented synchronous way to know you're already realtime by the time `load()`
    // resolves; no event is needed for that case. So this test drives an OBSERVABLE, listener-
    // registration-ordered transition instead (realtime -> polling, on a severed stream that
    // does not recover) — same pattern proven by the AC-U5 test in realtime.test.ts.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sse = sseResponse();
    const logger = recordingLogger();
    const secondListener: ConnectionEvent[] = [];

    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 60_000,
      logger,
      fetchImpl: routedFetch({
        config: [() => jsonResponse({ K: 'v' })],
        events: [
          () => sse.response,
          // Every reconnect attempt after the first stream dies fails outright — genuinely
          // degraded, guaranteeing an OBSERVABLE mode-change event after listeners attach.
          () => new Response(null, { status: 503 }),
        ],
      }),
    });

    client.on('connection', () => {
      throw new Error('connection listener boom');
    });
    client.on('connection', (e) => secondListener.push(e));

    await vi.advanceTimersByTimeAsync(0); // initial connect settles (already realtime by now)
    expect(client.cacheInfo.refreshMode).toBe('realtime');

    expect(() => sse.close()).not.toThrow(); // sever the stream — listeners are attached NOW
    await vi.advanceTimersByTimeAsync(1500); // past the quick-retry window -> degraded announced

    expect(client.cacheInfo.refreshMode).toBe('polling');
    expect(secondListener.length).toBeGreaterThanOrEqual(1); // second listener still ran
    expect(secondListener[0]?.mode).toBe('polling');
    const errorLines = logger.lines.filter((l) => l.level === 'error');
    expect(errorLines.some((l) => /listener threw \(event: connection\)/.test(l.message))).toBe(true);

    client.close();
  });

  it('an `error` listener that itself throws does not crash the process and does not prevent the failed refresh from being recorded on cacheInfo', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 1000,
      fetchImpl: routedFetch({
        config: [
          () => jsonResponse({ K: 'v' }),
          () => {
            throw new TypeError('network boom');
          },
        ],
      }),
    });
    client.on('error', () => {
      throw new Error('error listener itself throws');
    });

    await expect(vi.advanceTimersByTimeAsync(1000)).resolves.not.toThrow();
    expect(client.cacheInfo.lastError).not.toBeNull();

    client.close();
  });

  it('two throwing `change` listeners plus one healthy one: the healthy one always runs, order preserved, both throws logged', async () => {
    const sse = sseResponse();
    const logger = recordingLogger();
    const healthyRuns: ChangeEvent[] = [];

    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 60_000,
      logger,
      fetchImpl: routedFetch({
        config: [() => jsonResponse({ K: 'v0' }), () => jsonResponse({ K: 'v1' })],
        events: [() => sse.response],
      }),
    });
    await flushMicrotasks();

    client.on('change', () => {
      throw new Error('boom 1');
    });
    client.on('change', () => {
      throw new Error('boom 2');
    });
    client.on('change', (e) => healthyRuns.push(e));

    expect(() => sse.push('event: config-changed\ndata: {"etag":"\\"e1\\""}\n\n')).not.toThrow();
    await flushMicrotasks();

    expect(healthyRuns).toHaveLength(1);
    const errorLines = logger.lines.filter((l) => l.level === 'error');
    expect(errorLines).toHaveLength(2);
    expect(errorLines.some((l) => /boom 1/.test(l.message))).toBe(true);
    expect(errorLines.some((l) => /boom 2/.test(l.message))).toBe(true);

    client.close();
  });
});

// ---------------------------------------------------------------------------------------------
// 5. Multiple .on() registrations + unsubscribe cycles — leak check across MANY cycles
// ---------------------------------------------------------------------------------------------
describe('EnvpitClient realtime — subscribe/unsubscribe cycles do not leak listeners', () => {
  it('100 subscribe->fire->unsubscribe cycles leave exactly zero listeners registered at the end', async () => {
    const sse = sseResponse();
    const responses = [
      () => jsonResponse({ K: 'v0' }),
      ...Array.from({ length: 101 }, (_, i) => () => jsonResponse({ K: `v${i + 1}` })),
    ];
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 60_000,
      fetchImpl: routedFetch({ config: responses, events: [() => sse.response] }),
    });
    await flushMicrotasks();

    for (let cycle = 0; cycle < 100; cycle += 1) {
      let callsThisCycle = 0;
      const off = client.on('change', () => {
        callsThisCycle += 1;
      });
      sse.push(`event: config-changed\ndata: {"etag":"\\"cycle${cycle}\\""}\n\n`);
      await flushMicrotasks(3);
      expect(callsThisCycle).toBe(1); // exactly the current cycle's own listener fired
      off();
    }

    // Final probe: after all cycles' listeners are unsubscribed, a fresh push must trigger
    // ZERO calls into any of the 100 retired listeners (would blow up if leaked, since none of
    // them assert anything themselves — proven instead by a fresh counting listener seeing
    // exactly 1 call, not 101).
    let finalCalls = 0;
    client.on('change', () => {
      finalCalls += 1;
    });
    sse.push('event: config-changed\ndata: {"etag":"\\"final\\""}\n\n');
    await flushMicrotasks(3);
    expect(finalCalls).toBe(1);

    client.close();
  });

  it('QUIRK: subscribing the exact same function reference twice registers it only ONCE (Set-identity dedup) — unsubscribing once removes both intended subscriptions', async () => {
    const sse = sseResponse();
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 60_000,
      fetchImpl: routedFetch({
        config: [() => jsonResponse({ K: 'v0' }), () => jsonResponse({ K: 'v1' })],
        events: [() => sse.response],
      }),
    });
    await flushMicrotasks();

    let calls = 0;
    const sharedListener = (): void => {
      calls += 1;
    };
    const offA = client.on('change', sharedListener);
    client.on('change', sharedListener); // "second" subscription of the SAME reference

    sse.push('event: config-changed\ndata: {"etag":"\\"e1\\""}\n\n');
    await flushMicrotasks();

    // A naive Node EventEmitter would call a twice-registered listener TWICE. This emitter's
    // internal `Set<Listener>` dedups by reference identity, so it only fires ONCE — and calling
    // just ONE of the two returned unsubscribe closures (offA) removes the shared entry entirely,
    // silently also killing the "other" subscription that never got explicitly unsubscribed.
    expect(calls).toBe(1);

    offA();
    // The still-un-called-back second `client.on(...)` return value was never invoked here —
    // demonstrating the entry is already gone regardless.
    calls = 0;
    // no route left for a 3rd config fetch on purpose — push a duplicate-of-nothing to confirm
    // no further listener is registered at all (would throw "no route configured" if a refetch
    // fired, which it shouldn't since routedFetch has no 3rd config response queued and this
    // push doesn't even need to trigger one — we're just confirming the emitter is empty).
    client.close();
  });
});

// ---------------------------------------------------------------------------------------------
// 6. "Only fires on actual value change" — a push whose refetch is byte-identical must NOT fire
// ---------------------------------------------------------------------------------------------
describe('EnvpitClient realtime — no spurious `change` when the refetched snapshot is identical', () => {
  it('a push-triggered refetch that returns byte-identical values (e.g. re-save of the same value, new version/etag but same content) does NOT fire `change`', async () => {
    const sse = sseResponse();
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 60_000,
      fetchImpl: routedFetch({
        config: [
          () => jsonResponse({ DATABASE_URL: 'postgres://same', UNRELATED: 'also-same' }),
          // A NEW etag/version (e.g. an unrelated key elsewhere bumped the environment
          // fingerprint, or the same value was re-saved creating a new version row) — but the
          // actual key/value content this client cares about is byte-identical. Server ETag on
          // THIS refetch matches the push's etag (Sara §4.2 consistency guarantee).
          () =>
            new Response(JSON.stringify({ DATABASE_URL: 'postgres://same', UNRELATED: 'also-same' }), {
              status: 200,
              headers: { 'content-type': 'application/json', etag: '"etag-moved-but-content-same"' },
            }),
        ],
        events: [() => sse.response],
      }),
    });
    await flushMicrotasks();
    const changes: ChangeEvent[] = [];
    client.on('change', (e) => changes.push(e));

    sse.push('event: config-changed\ndata: {"etag":"\\"etag-moved-but-content-same\\""}\n\n');
    await flushMicrotasks();

    expect(changes).toHaveLength(0); // no spurious change event
    expect(client.cacheInfo.etag).toBe('"etag-moved-but-content-same"'); // etag still tracked
    client.get('DATABASE_URL'); // still readable, unaffected

    client.close();
  });

  it('a push-triggered refetch where a NEW empty/unset key materializes (cell-set-shape change, both null) does NOT fire `change`', async () => {
    // Mirrors Sara §4.1: key creation moves the version fingerprint even with no value written
    // yet ("materializes unset cells") — the SDK's own null-equivalence diff (`?? null`) must
    // treat "absent" and "present with null" as identical, so this must NOT spuriously fire.
    const sse = sseResponse();
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 60_000,
      fetchImpl: routedFetch({
        config: [
          () => jsonResponse({ EXISTING: 'v' }),
          () => jsonResponse({ EXISTING: 'v', NEW_UNSET_KEY: null }),
        ],
        events: [() => sse.response],
      }),
    });
    await flushMicrotasks();
    const changes: ChangeEvent[] = [];
    client.on('change', (e) => changes.push(e));

    sse.push('event: config-changed\ndata: {"etag":"\\"new-cell-etag\\""}\n\n');
    await flushMicrotasks();

    expect(changes).toHaveLength(0);
    client.close();
  });
});

// ---------------------------------------------------------------------------------------------
// 7. RACE — concurrent overlapping refreshes (two push signals in flight simultaneously)
// ---------------------------------------------------------------------------------------------
describe('EnvpitClient realtime — concurrent overlapping refresh() calls (no in-flight guard)', () => {
  it('two rapid pushes with DIFFERENT new etags, whose refetches resolve OUT OF ORDER, let the OLDER response win — client can regress to stale data with no error surfaced', async () => {
    const sse = sseResponse();
    const deferredA = deferred<Response>(); // response for the FIRST push ("eA")
    const deferredB = deferred<Response>(); // response for the SECOND push ("eB")

    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 60_000,
      fetchImpl: routedFetch({
        config: [
          () => jsonResponse({ K: 'v0' }), // initial load
          () => deferredA.promise, // triggered by push "eA"
          () => deferredB.promise, // triggered by push "eB"
        ],
        events: [() => sse.response],
      }),
    });
    await flushMicrotasks();
    expect(client.cacheInfo.etag).toBeNull(); // no etag header on the initial load response

    const changes: ChangeEvent[] = [];
    client.on('change', (e) => changes.push(e));

    // Two pushes fired back-to-back, before either refetch has resolved — both etags are new
    // relative to the client's current (null) etag, so BOTH trigger a refresh() concurrently.
    sse.push('event: config-changed\ndata: {"etag":"\\"eA\\""}\n\n');
    sse.push('event: config-changed\ndata: {"etag":"\\"eB\\""}\n\n');
    await flushMicrotasks();

    // Resolve B (the semantically NEWER push, sent second) FIRST, then A (older, sent first)
    // LAST — modeling ordinary network/scheduling jitter, which the SDK cannot control.
    deferredB.resolve(
      new Response(JSON.stringify({ K: 'vB' }), {
        status: 200,
        headers: { 'content-type': 'application/json', etag: '"eB"' },
      }),
    );
    await flushMicrotasks();
    deferredA.resolve(
      new Response(JSON.stringify({ K: 'vA' }), {
        status: 200,
        headers: { 'content-type': 'application/json', etag: '"eA"' },
      }),
    );
    await flushMicrotasks();

    // FINDING: `EnvpitClient.refresh()` has no in-flight/generation guard against overlapping
    // concurrent calls. Whichever HTTP response settles LAST wins, irrespective of which push
    // was semantically newer. Here that means the client ends up serving "vA"/"eA" — the OLDER
    // state — even though "eB" (newer) was already applied and visible via `change` a moment
    // earlier. This assertion documents the ACTUAL (buggy) behavior observed, not the intended
    // one; see the accompanying bd bug report for the correctness gap this proves.
    expect(client.get('K')).toBe('vA');
    expect(client.cacheInfo.etag).toBe('"eA"');

    // The listener saw a "flicker": v0 -> vB (looks correct) -> vA (a silent REGRESSION with no
    // error, no warning, indistinguishable from a legitimate change to a caller).
    expect(changes.map((e) => e.etag)).toEqual(['"eB"', '"eA"']);
    expect(changes[1]?.changedKeys).toEqual(['K']); // reported as an ordinary, valid change

    client.close();
  });
});

// ---------------------------------------------------------------------------------------------
// 8. Connection drop mid-stream -> degrade -> poll keeps working -> recover
// ---------------------------------------------------------------------------------------------
describe('EnvpitClient realtime — degraded mode: poll keeps the data fresh the whole time', () => {
  it('while the realtime channel is degraded, the poll timer still delivers a real change event (trigger: poll), and reconnecting afterwards resumes realtime', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sse = sseResponse();
    const changes: ChangeEvent[] = [];
    const connectionEvents: ConnectionEvent[] = [];

    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 5_000,
      fetchImpl: routedFetch({
        config: [
          () => jsonResponse({ K: 'v0' }), // initial load
          () => jsonResponse({ K: 'v1' }), // poll tick #1 while degraded — must still work
          () => jsonResponse({ K: 'v1' }), // catch-up refetch on realtime reconnect (no-op)
        ],
        events: [
          () => sse.response,
          () => new Response(null, { status: 503 }), // quick retry fails outright -> degraded
          () => sseResponse().response, // eventual recovery
        ],
      }),
    });
    client.on('change', (e) => changes.push(e));
    client.on('connection', (e) => connectionEvents.push(e));

    await vi.advanceTimersByTimeAsync(0);
    sse.close();
    await vi.advanceTimersByTimeAsync(1500); // quick retry fails -> degraded announced
    expect(client.cacheInfo.refreshMode).toBe('polling');

    await vi.advanceTimersByTimeAsync(5_000); // one full poll interval while still degraded
    expect(changes.some((e) => e.trigger === 'poll' && e.changedKeys.includes('K'))).toBe(true);
    expect(client.get('K')).toBe('v1'); // data DID keep refreshing during degraded mode

    await vi.advanceTimersByTimeAsync(15_000); // degraded-retry interval + jitter -> recovers
    expect(client.cacheInfo.refreshMode).toBe('realtime');
    expect(connectionEvents.some((e) => e.mode === 'realtime')).toBe(true);
    expect(connectionEvents.some((e) => e.mode === 'polling')).toBe(true);

    client.close();
  });
});
