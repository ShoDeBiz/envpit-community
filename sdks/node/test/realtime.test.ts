import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvpitClient } from '../src/client.js';
import type { ChangeEvent, ConnectionEvent, Logger } from '../src/types.js';
import { jsonResponse, networkFailure, routedFetch } from './test-utils.js';

afterEach(() => {
  vi.useRealTimers();
});

/** Builds a `Response` that streams SSE frames one at a time as the returned `push()` function
 *  is called, and stays open (never `done`) until `close()` is called — a controllable stand-in
 *  for the real long-lived `GET …/config/events` connection. */
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

function configChangedFrame(etag: string): string {
  return `event: config-changed\ndata: ${JSON.stringify({
    project_id: 'p1',
    environment_id: 'e1',
    etag,
    occurred_at: new Date().toISOString(),
  })}\n\n`;
}

function reconnectFrame(): string {
  return 'event: reconnect\ndata: {}\n\n';
}

/** A logger double that records every call, level included, in order. */
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

describe('EnvpitClient realtime — change event (AC-U1/AC-U3)', () => {
  it('fires `change` once per applied snapshot change via an SSE push, with the new value already readable inside the handler', async () => {
    const sse = sseResponse();
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 60_000,
      fetchImpl: routedFetch({
        config: [
          () => jsonResponse({ DATABASE_URL: 'postgres://old' }),
          () =>
            new Response(JSON.stringify({ values: { DATABASE_URL: 'postgres://new' }, secretKeys: [] }), {
              status: 200,
              headers: { 'content-type': 'application/json', etag: '"etag-2"' },
            }),
        ],
        events: [() => sse.response],
      }),
    });

    // The realtime connect is fire-and-forget from bootstrap(); let it settle before pushing.
    await flushMicrotasks();

    const events: ChangeEvent[] = [];
    let valueSeenInsideHandler: string | undefined;
    client.on('change', (e) => {
      events.push(e);
      valueSeenInsideHandler = client.get('DATABASE_URL');
    });

    sse.push(configChangedFrame('"etag-2"'));
    await flushMicrotasks();

    expect(events).toHaveLength(1);
    expect(events[0]?.changedKeys).toEqual(['DATABASE_URL']);
    expect(events[0]?.trigger).toBe('push');
    // The refetch this push triggered came back tagged "etag-2" (the SAME etag the push
    // itself carried) — this is the server's own consistency guarantee (Sara §4.2: "ETag
    // computed FROM THE SAME ROWS the response was built from"), not a coincidence of the fixture.
    expect(events[0]?.etag).toBe('"etag-2"');
    expect(valueSeenInsideHandler).toBe('postgres://new');

    client.close();
  });

  it('does NOT fire `change` on `load()` itself, and does not fire again if a later refetch found nothing different (AC-U3)', async () => {
    const changes: ChangeEvent[] = [];
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 1000,
      fetchImpl: routedFetch({ config: [() => jsonResponse({ K: 'v' }), () => jsonResponse({ K: 'v' })] }),
    });
    client.on('change', (e) => changes.push(e));

    expect(changes).toHaveLength(0); // nothing fired just from load() resolving

    vi.useFakeTimers({ shouldAdvanceTime: true });
    await vi.advanceTimersByTimeAsync(1000); // triggers the poll refresh — identical content
    expect(changes).toHaveLength(0);

    client.close();
  });

  it('never puts a config VALUE in a `change` payload — only key names (AC-U2)', async () => {
    const sse = sseResponse();
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 60_000,
      fetchImpl: routedFetch({
        config: [
          () => jsonResponse({ DB_PASSWORD: 'hunter2', API_TOKEN: 'shh-secret' }),
          () => jsonResponse({ DB_PASSWORD: 'hunter3', API_TOKEN: 'shh-secret' }),
        ],
        events: [() => sse.response],
      }),
    });
    await flushMicrotasks();

    let received: ChangeEvent | undefined;
    client.on('change', (e) => {
      received = e;
    });
    sse.push(configChangedFrame('"etag-x"'));
    await flushMicrotasks();

    expect(received).toBeDefined();
    const serialized = JSON.stringify(received);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('hunter3');
    expect(serialized).toContain('DB_PASSWORD'); // key NAMES are fine

    client.close();
  });
});

describe('EnvpitClient realtime — transport-agnostic change payload (AC-U4)', () => {
  it('a change delivered via poll (realtime unavailable) carries the same shape as one delivered via push, differing only in trigger', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const changes: ChangeEvent[] = [];
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 1000,
      // No `events` route configured -> the realtime channel fails every attempt and this
      // client is effectively poll-only for its whole life, same as AC-U4's "stream disabled".
      fetchImpl: routedFetch({
        config: [() => jsonResponse({ FEATURE_X: 'off' }), () => jsonResponse({ FEATURE_X: 'on' })],
      }),
    });
    client.on('change', (e) => changes.push(e));

    await vi.advanceTimersByTimeAsync(1000);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.trigger).toBe('poll');
    expect(changes[0]?.changedKeys).toEqual(['FEATURE_X']);

    client.close();
  });
});

describe('EnvpitClient realtime — degradation signal (AC-U5)', () => {
  it('a severed stream that never recovers flips to polling exactly once, with exactly one info log line and zero warn before the 5-minute threshold', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sse = sseResponse();
    const logger = recordingLogger();
    const connectionEvents: ConnectionEvent[] = [];

    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 60_000,
      logger,
      fetchImpl: routedFetch({
        config: [() => jsonResponse({ K: 'v' })],
        events: [
          () => sse.response,
          // Every reconnect attempt after the first stream dies fails outright — "not restored".
          networkFailure('connect ECONNREFUSED'),
        ],
      }),
    });
    client.on('connection', (e) => connectionEvents.push(e));

    await vi.advanceTimersByTimeAsync(0); // let the initial SSE connect resolve
    expect(client.cacheInfo.refreshMode).toBe('realtime');

    sse.close(); // sever the stream
    await vi.advanceTimersByTimeAsync(0);

    // Quick silent retry window (1s) — should still report realtime, no logs/events yet.
    await vi.advanceTimersByTimeAsync(500);
    expect(client.cacheInfo.refreshMode).toBe('realtime');
    expect(connectionEvents).toHaveLength(0);

    // Past the quick-retry delay, the retry attempt itself fails -> degraded is announced.
    await vi.advanceTimersByTimeAsync(1000);

    expect(client.cacheInfo.refreshMode).toBe('polling');
    expect(connectionEvents).toHaveLength(1);
    expect(connectionEvents[0]?.mode).toBe('polling');

    const infoLines = logger.lines.filter((l) => l.level === 'info');
    expect(infoLines).toHaveLength(1);
    expect(infoLines[0]?.message).toMatch(/falling back to polling/);

    const warnLines = logger.lines.filter((l) => l.level === 'warn');
    expect(warnLines).toHaveLength(0); // not yet at the 5-minute threshold

    client.close();
  });

  it('logs exactly one warn after the channel is still degraded past the 5-minute threshold', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sse = sseResponse();
    const logger = recordingLogger();

    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 60_000,
      logger,
      fetchImpl: routedFetch({
        config: [() => jsonResponse({ K: 'v' })],
        events: [() => sse.response, networkFailure()],
      }),
    });

    await vi.advanceTimersByTimeAsync(0);
    sse.close();
    await vi.advanceTimersByTimeAsync(2000); // clears the quick retry, enters degraded

    const infoCountAtDegraded = logger.lines.filter((l) => l.level === 'info').length;
    expect(infoCountAtDegraded).toBe(1);

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1000); // cross the 5-minute threshold

    const warnLines = logger.lines.filter((l) => l.level === 'warn');
    expect(warnLines).toHaveLength(1);
    expect(warnLines[0]?.message).toMatch(/still unavailable/);

    client.close();
  });
});

describe('EnvpitClient realtime — routine server rotation is quiet (AC-U6)', () => {
  it('a server-initiated `reconnect` frame that resolves on the next attempt logs only at debug and never flips mode / fires a connection event', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const first = sseResponse();
    const second = sseResponse();
    const logger = recordingLogger();
    const connectionEvents: ConnectionEvent[] = [];

    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 60_000,
      logger,
      fetchImpl: routedFetch({
        config: [() => jsonResponse({ K: 'v' })],
        events: [() => first.response, () => second.response],
      }),
    });
    client.on('connection', (e) => connectionEvents.push(e));

    await vi.advanceTimersByTimeAsync(0);
    expect(client.cacheInfo.refreshMode).toBe('realtime');
    logger.lines.length = 0; // discard the initial "connected" debug line

    first.push(reconnectFrame()); // server announces a routine rotation
    first.close(); // ...then closes the stream, as the server does
    await vi.advanceTimersByTimeAsync(1000); // the quiet quick-retry window

    expect(client.cacheInfo.refreshMode).toBe('realtime'); // never left realtime
    expect(connectionEvents).toHaveLength(0); // no transition = no event

    expect(logger.lines.filter((l) => l.level === 'info' || l.level === 'warn')).toHaveLength(0);
    const debugLines = logger.lines.filter((l) => l.level === 'debug');
    expect(debugLines.some((l) => /server rotation/.test(l.message))).toBe(true);

    client.close();
  });

  it('a quiet server-rotation reconnect STILL fires the self-healing catch-up refetch, even though it stays quiet otherwise (regression: bd:envpit-wvll)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const first = sseResponse();
    const second = sseResponse();
    const logger = recordingLogger();
    const connectionEvents: ConnectionEvent[] = [];
    const changes: ChangeEvent[] = [];

    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 60_000,
      logger,
      fetchImpl: routedFetch({
        // Two config responses: the initial `load()` fetch, then the catch-up refetch this
        // quiet reconnect must trigger — with a DIFFERENT value so a `change` is observable.
        config: [() => jsonResponse({ K: 'v1' }), () => jsonResponse({ K: 'v2' })],
        events: [() => first.response, () => second.response],
      }),
    });
    client.on('connection', (e) => connectionEvents.push(e));
    client.on('change', (e) => changes.push(e));

    await vi.advanceTimersByTimeAsync(0);
    expect(client.cacheInfo.refreshMode).toBe('realtime');
    logger.lines.length = 0; // discard the initial "connected" debug line

    first.push(reconnectFrame()); // server announces a routine rotation
    first.close(); // ...then closes the stream, as the server does
    await vi.advanceTimersByTimeAsync(1000); // the quiet quick-retry window

    // AC-U6 preserved: still quiet — no mode flip, no `connection` event, no info/warn log.
    expect(client.cacheInfo.refreshMode).toBe('realtime');
    expect(connectionEvents).toHaveLength(0);
    expect(logger.lines.filter((l) => l.level === 'info' || l.level === 'warn')).toHaveLength(0);

    // bd:envpit-wvll: SPEC-envpit-a9d-1a-architecture.md §5.2(a) — "SDK refetches on every
    // (re)connect" — the catch-up refetch must still fire on THIS reconnect despite it being
    // the quiet-rotation path, which shares no `connection`-event gate with it.
    expect(changes).toHaveLength(1);
    expect(changes[0]?.trigger).toBe('reconnect');
    expect(changes[0]?.changedKeys).toEqual(['K']);

    client.close();
  });
});

describe('EnvpitClient realtime — listeners can never crash the host (AC-U7)', () => {
  it('a throwing `change` listener does not stop other listeners and is reported through the logger', async () => {
    const sse = sseResponse();
    const logger = recordingLogger();
    const secondListenerCalls: ChangeEvent[] = [];

    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 60_000,
      logger,
      fetchImpl: routedFetch({
        config: [() => jsonResponse({ K: 'v1' }), () => jsonResponse({ K: 'v2' })],
        events: [() => sse.response],
      }),
    });
    await flushMicrotasks();

    client.on('change', () => {
      throw new Error('boom');
    });
    client.on('change', (e) => secondListenerCalls.push(e));

    expect(() => sse.push(configChangedFrame('"e2"'))).not.toThrow();
    await flushMicrotasks();

    expect(secondListenerCalls).toHaveLength(1); // the second listener still ran
    const errorLines = logger.lines.filter((l) => l.level === 'error');
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]?.message).toMatch(/listener threw \(event: change\)/);
    expect(errorLines[0]?.message).toMatch(/boom/);

    client.close();
  });

  it('an async `change` listener that rejects does not crash the host process — no unhandled promise rejection (regression: bd:envpit-r59g)', async () => {
    const sse = sseResponse();
    const logger = recordingLogger();
    const secondListenerCalls: ChangeEvent[] = [];

    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 60_000,
      logger,
      fetchImpl: routedFetch({
        config: [() => jsonResponse({ K: 'v1' }), () => jsonResponse({ K: 'v2' })],
        events: [() => sse.response],
      }),
    });
    await flushMicrotasks();

    // Any unhandled rejection surfaced anywhere in the process during this test is exactly
    // the failure mode Chris reproduced against dist/index.js (default Node behavior: exit
    // code 1, process termination). Registering our own listener here doesn't mask a real
    // bug — Node still delivers the event to every listener; the assertion below is what
    // proves whether one fired.
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      // The exact idiomatic real-world shape from Chris's repro and the SDK's own docs guide
      // (`outputs/SPEC-envpit-a9d-1b-ux.md` §4 step 3, "reconnect a pool when DATABASE_URL
      // changes") — an ASYNC listener whose body throws/rejects, not a synchronous throw.
      client.on('change', async () => {
        await Promise.resolve(); // force a real microtask hop before rejecting
        throw new Error('async-boom-bd-envpit-r59g');
      });
      client.on('change', (e) => secondListenerCalls.push(e));

      expect(() => sse.push(configChangedFrame('"e2"'))).not.toThrow();
      await flushMicrotasks();
      // An unhandled rejection can surface on a later turn of the event loop than a
      // synchronous throw would — give it several turns to appear before asserting silence.
      await new Promise((resolve) => setImmediate(resolve));
      await flushMicrotasks();
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }

    expect(unhandledRejections).toHaveLength(0); // <- this is what crashes the process pre-fix
    expect(secondListenerCalls).toHaveLength(1); // the other (non-throwing) listener still ran
    const errorLines = logger.lines.filter((l) => l.level === 'error');
    expect(errorLines.some((l) => /listener threw \(event: change\)/.test(l.message))).toBe(true);
    expect(errorLines.some((l) => /async-boom-bd-envpit-r59g/.test(l.message))).toBe(true);

    client.close();
  });

  it('a background refresh failure with no `error` listener registered does not throw/crash', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 1000,
      fetchImpl: routedFetch({ config: [() => jsonResponse({ K: 'v' }), networkFailure()] }),
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(client.cacheInfo.lastError).not.toBeNull();

    client.close();
  });

  it('emits a typed `error` event for a failed background refresh', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const errors: Error[] = [];
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 1000,
      fetchImpl: routedFetch({ config: [() => jsonResponse({ K: 'v' }), networkFailure('timeout')] }),
    });
    client.on('error', (err) => errors.push(err));

    await vi.advanceTimersByTimeAsync(1000);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.name).toBe('NetworkError');

    client.close();
  });
});

describe('EnvpitClient realtime — recovery re-fetches to catch up (Sara §5.2 self-healing)', () => {
  it('reconnecting after a genuinely degraded episode triggers a catch-up refresh with trigger "reconnect"', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const firstStream = sseResponse();
    const logger = recordingLogger();
    const changes: ChangeEvent[] = [];

    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 60_000,
      logger,
      fetchImpl: routedFetch({
        config: [() => jsonResponse({ K: 'v1' }), () => jsonResponse({ K: 'v2' })],
        events: [
          () => firstStream.response,
          networkFailure(), // quick retry fails -> degraded
          () => sseResponse().response, // degraded-retry eventually succeeds
        ],
      }),
    });
    client.on('change', (e) => changes.push(e));

    await vi.advanceTimersByTimeAsync(0);
    firstStream.close();
    await vi.advanceTimersByTimeAsync(1000); // quick retry fails -> degraded announced
    expect(client.cacheInfo.refreshMode).toBe('polling');

    await vi.advanceTimersByTimeAsync(12_000); // degraded-retry interval + jitter -> recovers

    expect(client.cacheInfo.refreshMode).toBe('realtime');
    expect(changes).toHaveLength(1);
    expect(changes[0]?.trigger).toBe('reconnect');
    expect(changes[0]?.changedKeys).toEqual(['K']);

    client.close();
  });
});

describe('EnvpitClient realtime — cacheInfo additive fields', () => {
  it('exposes etag/refreshMode/realtimeSince/lastChangeAt, and reports refreshMode "off" when pollIntervalMs is 0', async () => {
    const clientOff = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 0,
      fetchImpl: routedFetch({ config: [() => jsonResponse({ K: 'v' }, 200)] }),
    });
    expect(clientOff.cacheInfo.refreshMode).toBe('off');
    expect(clientOff.cacheInfo.realtimeSince).toBeNull();
    expect(clientOff.cacheInfo.lastChangeAt).toBeNull();
    clientOff.close();
  });

  it('captures the ETag response header into cacheInfo.etag', async () => {
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 0,
      fetchImpl: routedFetch({
        config: [
          () =>
            new Response(JSON.stringify({ values: { K: 'v' }, secretKeys: [] }), {
              status: 200,
              headers: { 'content-type': 'application/json', etag: '"abc123"' },
            }),
        ],
      }),
    });
    expect(client.cacheInfo.etag).toBe('"abc123"');
    client.close();
  });
});

/** Lets the realtime connect's async chain (`await fetchImpl(...)`, `reader.read()`, etc.)
 *  settle without needing fake timers for tests that don't otherwise need them. Stream reads
 *  resolve via real I/O-adjacent scheduling (not pure microtasks), so a handful of
 *  `setTimeout(0)` turns is more reliable here than `Promise.resolve()` chaining alone. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
