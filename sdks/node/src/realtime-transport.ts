import { SseFrameParser, type SseFrame } from './sse-parser.js';
import type { ConfigScope } from './transport.js';
import type { ConnectionMode, ConnectionReason, Logger } from './types.js';

/** `GET {host}/api/v1/config/events` — the key-scope-inferred alias
 *  (`ApiKeyScopedConfigEventsController` in the main repo), mirroring `transport.ts`'s
 *  `CONFIG_PATH_ALIAS`. Auth via `X-Api-Key`; project+environment inferred server-side from the
 *  key. Used only when no `scope` override is set — see `buildEventsPath` below.
 *  bd:envpit-a9d §5.3. */
const CONFIG_EVENTS_PATH_ALIAS = '/api/v1/config/events';

/** Explicit-scope events path builder — mirrors `transport.ts`'s `buildConfigPath` (bd:envpit-ed3h
 *  loop iter-2, Chris High #2). When a scope override is set, the SSE channel MUST target the
 *  matching `GET {host}/api/v1/projects/:project/environments/:environment/config/events` path
 *  (`ApiKeyConfigEventsController_streamEvents`, `contract/openapi.json` — verified present).
 *  Previously this transport always hit `CONFIG_EVENTS_PATH_ALIAS` regardless of scope: for a
 *  scope-override client whose key is a project-wildcard key (the override's own primary use
 *  case), that alias deterministically returns a permanent 400 ("not scoped to a single
 *  environment"), which `onFailure()` misread as a transient blip — degrading to polling AND
 *  retrying the doomed connection forever instead of hitting the scoped path, which has no such
 *  400 case. */
function buildEventsPath(scope: ConfigScope | undefined): string {
  if (!scope) return CONFIG_EVENTS_PATH_ALIAS;
  return `/api/v1/projects/${encodeURIComponent(scope.project)}/environments/${encodeURIComponent(scope.environment)}/config/events`;
}

/** The SSE `event:` name for a real config change (`libs/shared/src/config-events.dto.ts`,
 *  main repo — `CONFIG_CHANGED_SSE_EVENT_NAME`). Hardcoded here rather than imported: this SDK
 *  is a standalone published package with no dependency on the server's internal libs, same
 *  posture as `transport.ts`'s hardcoded `CONFIG_PATH`. */
const CONFIG_CHANGED_EVENT_NAME = 'config-changed';

/** The SSE `event:` name the server force-closes a stream with (max-lifetime rotation,
 *  SIGTERM, revocation sweep) — `config-events.constants.ts`'s
 *  `CONFIG_EVENTS_RECONNECT_SSE_EVENT_NAME`, main repo. A client treats this identically to a
 *  plain disconnect: reconnect and re-run the guard chain — this SDK just also uses it to pick
 *  quieter diagnostics copy for what's an expected, healthy rotation. */
const RECONNECT_EVENT_NAME = 'reconnect';

/** Any OTHER `event:` name (e.g. `flags-changed`, bd:envpit-0t2z.6's piggyback on the same
 *  connection) is intentionally ignored here — forward-compatible, out of this SDK slice's
 *  scope (Remote Config / config subscribe only). */

/** One silent, immediate retry after ANY disconnect (server rotation OR an unexpected drop)
 *  before this transport "announces" degraded mode — this is what makes AC-U6's routine
 *  server-rotation reconnect quiet, and also spares a single transient network blip from
 *  flipping `refreshMode`/firing a `connection` event/logging at `info`. */
const QUICK_RECONNECT_DELAY_MS = 1_000;

/** Retry cadence once genuinely degraded. Sized well under the server's per-key connect budget
 *  (`CONFIG_EVENTS_CONNECT_RATE_LIMIT = 10` per 60s, main repo) — at this interval a lone
 *  client attempts at most ~6/min, leaving headroom. Jitter avoids a synchronized reconnect
 *  storm across many clients recovering from the same outage at once. */
const DEGRADED_RECONNECT_INTERVAL_MS = 10_000;
const DEGRADED_RECONNECT_JITTER_MS = 2_000;

/** "Still degraded after a threshold (default 5 min)" → one `warn`, per
 *  `outputs/SPEC-envpit-a9d-1b-ux.md` §3.3's normative table. */
const DEGRADED_WARN_THRESHOLD_MS = 5 * 60_000;

export interface RealtimeTransportCallbacks {
  /** A `config-changed` push arrived; `etag` is its fingerprint. The caller decides whether a
   *  refetch is actually needed (e.g. skip if it already holds this etag). */
  onChangeSignal(etag: string): void;
  /** `mode` just transitioned (never fired per-attempt — only on an actual state change). Governs
   *  ONLY the `connection` event / `refreshMode` bookkeeping concern — see `onRealtimeConnected`
   *  for the separate self-healing-refetch concern, which fires on a strictly wider set of
   *  connects (bd:envpit-wvll — the two must NOT share one gate). */
  onModeChange(mode: ConnectionMode, reason: ConnectionReason, since: Date): void;
  /** Fires on EVERY successful realtime (re)connect — including a quiet server-rotation
   *  reconnect where `mode` never actually left `'realtime'` and `onModeChange` therefore does
   *  NOT fire (AC-U6). This is the hook the client uses to drive the self-healing catch-up
   *  refetch (`outputs/SPEC-envpit-a9d-1a-architecture.md` §5.2(a): "SDK refetches on every
   *  (re)connect"), deliberately decoupled from `onModeChange` so a quiet rotation still
   *  triggers it (bd:envpit-wvll regression fix — previously coupled to the same gate as
   *  `onModeChange`, so the refetch was silently skipped whenever the `connection` event
   *  correctly stayed silent). */
  onRealtimeConnected(since: Date): void;
  onLog(level: 'debug' | 'info' | 'warn', message: string): void;
}

export interface RealtimeTransportParams {
  host: string;
  apiKey: string;
  fetchImpl: typeof fetch;
  /** Only used to word the "falling back to polling every {n}s" diagnostic copy — this
   *  transport does not itself poll. */
  pollIntervalMs: number;
  /** Explicit project/environment scope override (bd:envpit-ed3h loop iter-2, Chris High #2) —
   *  mirrors `FetchConfigParams.scope` in `transport.ts`. `undefined` (default) connects to the
   *  key-scope-inferred alias; when set, the SSE connection targets the matching scoped events
   *  path instead — see `buildEventsPath`. */
  scope?: ConfigScope;
  callbacks: RealtimeTransportCallbacks;
}

/**
 * Manages exactly one logical realtime (SSE) connection to `GET …/config/events`, with
 * transparent reconnection: a single quiet retry for any disconnect, then a degraded/backoff
 * loop with the diagnostics cadence `outputs/SPEC-envpit-a9d-1b-ux.md` §3.3 specifies (one
 * `info` on entering degraded mode, one `warn` after 5 minutes still degraded, one `info` on
 * restore — never a line per failed attempt). `EnvpitClient` owns deciding WHAT to do with a
 * change signal or a mode change (`RealtimeTransportCallbacks`); this class owns the
 * connection lifecycle only.
 *
 * `mode` degrading to `'polling'` is always safe: it means the caller's own `pollIntervalMs`
 * timer is the sole freshness mechanism for as long as this transport stays degraded — "zero
 * correctness loss, staleness bounded by poll interval" (Sara §2 NFR).
 */
export class RealtimeTransport {
  private stopped = true;
  private abortController: AbortController | null = null;
  private currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private expectingServerReconnect = false;
  private degradedSince: Date | null = null;
  private warnedThisEpisode = false;
  private quickRetryUsedForEpisode = false;
  private warnTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private permanentlyUnsupported = false;

  private mode: ConnectionMode = 'polling';

  constructor(private readonly params: RealtimeTransportParams) {}

  /** Starts (or restarts) the connection loop. Idempotent while already running. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.quickRetryUsedForEpisode = false;
    void this.connectOnce();
  }

  /** Tears down the current connection (if any) and stops all reconnect attempts. Idempotent. */
  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.abortController?.abort();
    this.abortController = null;
    void this.currentReader?.cancel().catch(() => undefined);
    this.currentReader = null;
    this.clearTimers();
  }

  private clearTimers(): void {
    if (this.warnTimer) {
      clearTimeout(this.warnTimer);
      this.warnTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private async connectOnce(): Promise<void> {
    if (this.stopped || this.permanentlyUnsupported) return;
    this.abortController = new AbortController();

    let response: Response;
    try {
      response = await this.params.fetchImpl(`${this.params.host}${buildEventsPath(this.params.scope)}`, {
        method: 'GET',
        headers: { 'X-Api-Key': this.params.apiKey, Accept: 'text/event-stream' },
        signal: this.abortController.signal,
      });
    } catch {
      if (this.stopped) return;
      this.onFailure();
      return;
    }
    if (this.stopped) return;

    if (!response.ok) {
      this.onFailure();
      return;
    }
    if (!response.body) {
      this.onUnsupported();
      return;
    }

    this.onSuccess();

    try {
      await this.pump(response.body);
    } catch {
      // Read/decode error mid-stream — treated as a disconnect below, same as a clean end.
    }
    this.currentReader = null;
    if (this.stopped) return;
    this.onFailure();
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    this.currentReader = reader;
    const decoder = new TextDecoder();
    const parser = new SseFrameParser();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value) {
          const text = decoder.decode(value, { stream: true });
          for (const frame of parser.push(text)) {
            this.handleFrame(frame);
            if (this.stopped) return;
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // already released/cancelled — fine.
      }
    }
  }

  private handleFrame(frame: SseFrame): void {
    if (frame.event === CONFIG_CHANGED_EVENT_NAME) {
      const etag = parseEtag(frame.data);
      if (etag) this.params.callbacks.onChangeSignal(etag);
      return;
    }
    if (frame.event === RECONNECT_EVENT_NAME) {
      // The server is about to close this stream deliberately (rotation/shutdown/revocation
      // sweep) — remember that, so the next successful connect logs the quieter
      // "reconnected (server rotation)" line instead of a generic "connected" one.
      this.expectingServerReconnect = true;
      return;
    }
    // Unknown event name (e.g. a future/`flags-changed` frame) — ignored by design.
  }

  private onSuccess(): void {
    this.quickRetryUsedForEpisode = false;
    const wasServerReconnect = this.expectingServerReconnect;
    this.expectingServerReconnect = false;
    const wasDegraded = this.degradedSince !== null;
    this.degradedSince = null;
    this.warnedThisEpisode = false;
    this.clearTimers();

    const modeChanged = this.mode !== 'realtime';
    const since = new Date();
    if (modeChanged) this.mode = 'realtime';

    if (wasDegraded) {
      this.params.callbacks.onLog('info', 'envpit: realtime channel restored');
    } else if (wasServerReconnect) {
      this.params.callbacks.onLog('debug', 'envpit: realtime channel reconnected (server rotation)');
    } else {
      this.params.callbacks.onLog('debug', 'envpit: realtime config channel connected');
    }

    if (modeChanged) {
      this.params.callbacks.onModeChange('realtime', 'connected', since);
    }
    // Unconditional — every successful (re)connect, not just ones where `mode` transitioned
    // (bd:envpit-wvll). This is what lets a quiet server-rotation reconnect still drive the
    // client's self-healing catch-up refetch even though `modeChanged` above is `false` for it.
    this.params.callbacks.onRealtimeConnected(since);
  }

  private onFailure(): void {
    if (this.stopped) return;
    // One silent, immediate retry per episode before announcing anything (AC-U6).
    if (!this.quickRetryUsedForEpisode && this.degradedSince === null) {
      this.quickRetryUsedForEpisode = true;
      this.retryTimer = setTimeout(() => void this.connectOnce(), QUICK_RECONNECT_DELAY_MS);
      this.retryTimer.unref?.();
      return;
    }
    this.declareDegraded('network');
    this.scheduleDegradedRetry();
  }

  private onUnsupported(): void {
    // Structural incompatibility (no streamable response body in this runtime) — retrying
    // would only ever fail the same way, so this is permanent for the client's lifetime.
    this.permanentlyUnsupported = true;
    this.declareDegraded('unsupported');
  }

  private declareDegraded(reason: ConnectionReason): void {
    if (this.degradedSince !== null) return; // already announced this episode — stay quiet
    const since = new Date();
    this.degradedSince = since;
    const pollSec = Math.max(1, Math.round(this.params.pollIntervalMs / 1000));
    const message =
      reason === 'unsupported'
        ? 'envpit: realtime channel unavailable in this runtime (no streamable response body) — ' +
          `falling back to polling only, every ${pollSec}s`
        : `envpit: realtime channel unavailable — falling back to polling every ${pollSec}s; ` +
          `config still refreshes, max staleness ${pollSec}s`;
    this.params.callbacks.onLog('info', message);

    const modeChanged = this.mode !== 'polling';
    this.mode = 'polling';
    if (modeChanged) {
      this.params.callbacks.onModeChange('polling', reason, since);
    }
    this.scheduleWarnTimer();
  }

  private scheduleWarnTimer(): void {
    this.warnTimer = setTimeout(() => {
      if (this.stopped || this.degradedSince === null || this.warnedThisEpisode) return;
      this.warnedThisEpisode = true;
      const minutes = Math.round(DEGRADED_WARN_THRESHOLD_MS / 60_000);
      const pollSec = Math.max(1, Math.round(this.params.pollIntervalMs / 1000));
      this.params.callbacks.onLog(
        'warn',
        `envpit: realtime channel still unavailable after ${minutes} min; continuing to poll every ${pollSec}s`,
      );
    }, DEGRADED_WARN_THRESHOLD_MS);
    this.warnTimer.unref?.();
  }

  private scheduleDegradedRetry(): void {
    if (this.permanentlyUnsupported) return;
    const jitter = Math.floor(Math.random() * DEGRADED_RECONNECT_JITTER_MS);
    this.retryTimer = setTimeout(() => void this.connectOnce(), DEGRADED_RECONNECT_INTERVAL_MS + jitter);
    this.retryTimer.unref?.();
  }
}

function parseEtag(data: string): string | null {
  try {
    const parsed = JSON.parse(data) as { etag?: unknown };
    return typeof parsed.etag === 'string' && parsed.etag.length > 0 ? parsed.etag : null;
  } catch {
    return null;
  }
}
