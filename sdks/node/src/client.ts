import { inspect } from 'node:util';
import { InMemoryCacheStore, type CacheStore } from './cache-store.js';
import { SafeEmitter } from './emitter.js';
import { EnvpitError, MissingKeyError, NetworkError, TypeMismatchError } from './errors.js';
import { mergeSnapshotIntoEnv, type MergeIntoProcessEnvOptions, type MergeIntoProcessEnvResult } from './process-env-merge.js';
import { RealtimeTransport } from './realtime-transport.js';
import { fetchConfig, type ConfigScope } from './transport.js';
import type {
  CacheInfo,
  ChangeTrigger,
  ConfigSnapshot,
  ConfigValues,
  ConnectionMode,
  ConnectionReason,
  EnvpitClientEvents,
  EnvpitClientOptions,
  Logger,
} from './types.js';

const DEFAULT_HOST = 'https://envpit.com';
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);
const INTEGER_PATTERN = /^-?\d+$/;
// `contract/openapi.json`: ApiKeyConfigResolveController_resolve's `projectId`/`environmentId`
// path params are both `"format": "uuid"` — version-agnostic (accepts any RFC 4122 layout, not
// just v4), matching what the app repo actually issues (Postgres `gen_random_uuid()`, v4).
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validates the explicit project/environment scope override (bd:envpit-ed3h Part 2). Both must
 *  be given together (the server path needs both segments) or neither (default: the
 *  key-scope-inferred alias). Throws a plain, synchronous `Error` — the SAME precedent the
 *  constructor already uses for a missing `apiKey` a few lines below: an options-shape mistake
 *  is a caller-code bug, not a runtime `EnvpitError` condition (that hierarchy models
 *  server/config-read failures, not local input validation). */
function resolveScopeOverride(project: string | undefined, environment: string | undefined): ConfigScope | undefined {
  if (project === undefined && environment === undefined) return undefined;
  if (project === undefined || environment === undefined) {
    throw new Error(
      'EnvPit: `project` and `environment` must both be provided together, or both omitted ' +
        '(the default: the key-scope-inferred alias). Pass { project, environment } to `EnvpitClient.load(...)`.',
    );
  }
  if (project.trim().length === 0 || environment.trim().length === 0) {
    throw new Error('EnvPit: `project` and `environment` must be non-empty strings.');
  }
  if (!UUID_PATTERN.test(project) || !UUID_PATTERN.test(environment)) {
    throw new Error(
      'EnvPit: `project` and `environment` must be UUIDs (contract/openapi.json: ' +
        `ApiKeyConfigResolveController_resolve's projectId/environmentId are format:"uuid"). ` +
        `Got { project: ${JSON.stringify(project)}, environment: ${JSON.stringify(environment)} }.`,
    );
  }
  return { project, environment };
}

/**
 * `const envpit = await EnvpitClient.load({ apiKey?, host?, ... });` — the Node/TS core client
 * (public API shape per `outputs/SPEC-envpit-0t2z-1a-architecture.md` §1 and the published
 * quick-start in `outputs/SPEC-envpit-0t2z-1b-ux.md` §A1). One bulk fetch per environment
 * (`GET /api/v1/config`, key-scope-inferred from the API key — no project/environment id
 * needed); every `get*()` call after `load()` resolves is a synchronous, in-memory read —
 * never a network call.
 *
 * Caching (owner-confirmed contract, see bd:envpit-0t2z.2 notes): memory-only, never
 * persisted to disk. Background refresh uses stale-while-revalidate — a failed refresh keeps
 * serving the last good snapshot and records the failure on `cacheInfo`, it never throws or
 * evicts the cache. Only the FIRST load throws (there is nothing to fall back to yet), which
 * `load()` surfaces as a rejected Promise — a caller can never hold a half-initialized client.
 *
 * Realtime (bd:envpit-0t2z.2 UPDATE 2026-07-15 / bd:envpit-a9d): whenever `pollIntervalMs > 0`,
 * the client ALSO opens a realtime (SSE) connection to `GET …/config/events` alongside the
 * existing poll timer. A `config-changed` push triggers an immediate refetch; the poll timer
 * remains the correctness backstop regardless (bounded staleness even if the realtime channel
 * is degraded — `outputs/SPEC-envpit-a9d-1a-architecture.md` §2 NFR). `on('change', ...)` /
 * `on('connection', ...)` / `on('error', ...)` are the push-style surfaces; `cacheInfo` is the
 * pull-style equivalent (`outputs/SPEC-envpit-a9d-1b-ux.md` §3.2–§3.4 — the authoritative event
 * shape/semantics this class implements verbatim).
 */
export class EnvpitClient {
  private readonly apiKey: string;
  private readonly host: string;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;
  private readonly emitter: SafeEmitter<EnvpitClientEvents>;
  private readonly scope: ConfigScope | undefined;

  // bd:envpit-ckv2: the cached snapshot/etag/fetchedAt triple lives behind the `CacheStore`
  // seam (`cache-store.ts`) rather than as three loose fields, so a future opt-in disk-backed
  // store can conform to the same interface and be swapped in via `EnvpitClientOptions` without
  // touching this class's refresh/read logic. `InMemoryCacheStore` is the only implementation
  // shipped in this release — behavior is unchanged, this is a seam, not a new cache tier.
  private readonly cacheStore: CacheStore;
  private lastError: Error | null = null;
  private lastChangeAt: Date | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private realtime: RealtimeTransport | null = null;
  private refreshMode: 'realtime' | 'polling' | 'off';
  private realtimeSince: Date | null = null;
  private sawFirstRealtimeConnect = false;
  // In-flight guard (bd:envpit-1mvf): the poll timer, push-triggered refreshes, and the
  // reconnect catch-up refresh all call `refresh()`, and any two calls can have their HTTP
  // responses resolve out of order. Every call captures the generation counter's value at the
  // moment it's issued; a response is only applied if that generation is STILL the latest one
  // issued by the time the response arrives. An overtaken (stale) response is discarded outright
  // — see `refresh()`.
  private refreshGeneration = 0;

  /** Read-only views over the `CacheStore`'s single entry — every other method reads the cache
   *  through these three instead of calling `this.cacheStore.get()` directly, so a `null` store
   *  (nothing cached yet) collapses to the same "not loaded" shape (`null`) these fields had
   *  before the `CacheStore` seam existed. Writes go through `writeCache`/`touchCacheFetchedAt`
   *  below — never a direct field assignment, since the three values are stored as one
   *  `CacheEntry`, not independently settable. */
  private get snapshot(): ConfigSnapshot | null {
    return this.cacheStore.get()?.snapshot ?? null;
  }

  private get fetchedAt(): Date | null {
    return this.cacheStore.get()?.fetchedAt ?? null;
  }

  private get etag(): string | null {
    return this.cacheStore.get()?.etag ?? null;
  }

  private constructor(options: EnvpitClientOptions) {
    const apiKey = options.apiKey ?? process.env['ENVPIT_API_KEY'];
    if (!apiKey) {
      throw new Error(
        'EnvPit: no API key found. Set the ENVPIT_API_KEY environment variable, or pass { apiKey } to `EnvpitClient.load(...)`.',
      );
    }
    this.apiKey = apiKey;
    this.scope = resolveScopeOverride(options.project, options.environment);
    // bd:envpit-ubky — mirror the apiKey resolution above: fall back to the ENVPIT_HOST env
    // var before DEFAULT_HOST, so a self-hoster who sets ENVPIT_API_KEY + ENVPIT_HOST in the
    // environment (and never passes { host }) reaches their own server instead of silently
    // hitting the cloud. Explicit { host } still wins.
    this.host = (options.host ?? process.env['ENVPIT_HOST'] ?? DEFAULT_HOST).replace(/\/+$/, '');
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.logger = options.logger;
    this.emitter = new SafeEmitter(this.logger);
    this.refreshMode = this.pollIntervalMs > 0 ? 'polling' : 'off';
    this.cacheStore = new InMemoryCacheStore();
  }

  /**
   * The SDK's only entry point — replaces the old two-step `new EnvPit(options);
   * await client.start();`. Constructs the client, fetches the environment's config once
   * (rejects on failure — no cache exists yet to fall back to), and — unless
   * `pollIntervalMs` is `0` — starts the background poll timer AND the realtime (SSE)
   * connection. Resolves with a ready-to-read client; every `get*()` call on the result is
   * synchronous. `load()` resolving is NOT itself a `change` event (AC-U3 — no boot double-fire).
   */
  static async load(options: EnvpitClientOptions = {}): Promise<EnvpitClient> {
    const client = new EnvpitClient(options);
    await client.bootstrap();
    return client;
  }

  private async bootstrap(): Promise<void> {
    await this.refresh({ isFirstLoad: true });
    if (this.pollIntervalMs > 0) {
      this.timer = setInterval(() => {
        void this.refresh({ isFirstLoad: false, trigger: 'poll' });
      }, this.pollIntervalMs);
      // Never keep the host process alive just for background polling (Node-only API; a
      // no-op in non-Node fetch-compatible runtimes where `.unref` doesn't exist).
      this.timer.unref?.();

      this.realtime = new RealtimeTransport({
        host: this.host,
        apiKey: this.apiKey,
        fetchImpl: this.fetchImpl,
        pollIntervalMs: this.pollIntervalMs,
        // bd:envpit-ed3h loop iter-2, Chris High #2: the SSE channel must target the SAME scope
        // as the poll channel (`this.scope`, already threaded into `fetchConfig` above) — an
        // unscoped alias connection from a scope-override client hits a path that returns a
        // permanent 400 for the override's own primary use case (a project-wildcard key).
        scope: this.scope,
        callbacks: {
          onChangeSignal: (pushedEtag) => this.handlePushSignal(pushedEtag),
          onModeChange: (mode, reason, since) => this.handleConnectionModeChange(mode, reason, since),
          onRealtimeConnected: (since) => this.handleRealtimeConnected(since),
          onLog: (level, message) => this.logger?.[level]?.(message),
        },
      });
      this.realtime.start();
    }
  }

  private handlePushSignal(pushedEtag: string): void {
    // The event's own etag lets us skip a wasted refetch when this is a duplicate
    // notification we already reflect (e.g. a repeat after reconnect) — Sara §5.3.
    if (this.etag !== null && pushedEtag === this.etag) return;
    void this.refresh({ isFirstLoad: false, trigger: 'push' });
  }

  /** Owns ONLY the `connection`-event / `refreshMode` bookkeeping concern — fires exclusively
   *  on an actual mode transition (`RealtimeTransport.onModeChange`'s own contract). Deliberately
   *  does NOT drive the self-healing refetch — see `handleRealtimeConnected` below, and
   *  bd:envpit-wvll for why the two were split. */
  private handleConnectionModeChange(mode: ConnectionMode, reason: ConnectionReason, since: Date): void {
    this.refreshMode = mode;
    this.realtimeSince = mode === 'realtime' ? since : null;
    this.emitter.emit('connection', { mode, since, reason });
  }

  /** Owns ONLY the self-healing catch-up refetch concern (Sara §5.2: "SDK refetches on every
   *  (re)connect"). Fires on EVERY successful realtime (re)connect — including a quiet
   *  server-rotation reconnect where `mode` never actually left `'realtime'` and
   *  `handleConnectionModeChange` above therefore never runs for it (AC-U6: that case stays
   *  quiet — no log, no `connection` event, mode stays `'realtime'` — but the refetch must
   *  still happen; bd:envpit-wvll regression fix). Skipped on the very first realtime connect
   *  right after `load()` — that data is already fresh, and firing it there would just be a
   *  wasted duplicate of the bootstrap fetch. */
  private handleRealtimeConnected(_since: Date): void {
    if (this.sawFirstRealtimeConnect) {
      void this.refresh({ isFirstLoad: false, trigger: 'reconnect' });
    }
    this.sawFirstRealtimeConnect = true;
  }

  /** Stops the background poll timer AND the realtime (SSE) connection. Idempotent. The last
   *  snapshot remains readable. Kept for backward compatibility with the pre-realtime SDK
   *  surface — prefer `close()` in new code (same behavior, matches the published event-API
   *  shape, `outputs/SPEC-envpit-a9d-1b-ux.md` §3.2: `client.close()` tears down stream + timer). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.realtime?.close();
    this.realtime = null;
  }

  /** Alias of `stop()`. */
  close(): void {
    this.stop();
  }

  /** AC-SEC-SDK3-1 (`outputs/THREATMODEL-envpit-0t2z-3.md` F1, Node parity-gap register item 1):
   *  `util.inspect`/`console.log` render every own property by default — including `apiKey`
   *  AND the full `snapshot` value map (secrets included). Shared by the three redaction
   *  overrides below so `console.log(client)`, `JSON.stringify(client)`, a debugger watch
   *  expression, and an error-reporter object dump all see the SAME value-free/key-free text —
   *  never the raw API key or a config value, only the safe key COUNT. Mirrors the `<redacted>`
   *  token and shape already shipped in the sibling SDKs (Go `String()`/`GoString()`, Python
   *  `__repr__`/`__str__`, Java `toString()`). */
  private redactedSummary(): string {
    const keyCount = this.snapshot === null ? 0 : Object.keys(this.snapshot.values).length;
    return `EnvpitClient(host=${JSON.stringify(this.host)}, keys=${keyCount}, apiKey=<redacted>)`;
  }

  /** `console.log(client)` / a debugger watch expression / `require('node:util').inspect`
   *  all route through this instead of enumerating own properties. */
  [inspect.custom](): string {
    return this.redactedSummary();
  }

  /** `String(client)` / template-literal interpolation (`` `${client}` ``). */
  toString(): string {
    return this.redactedSummary();
  }

  /** `JSON.stringify(client)` calls this instead of enumerating own properties — same leak
   *  boundary as `[inspect.custom]` above, for the JSON-serialization path. */
  toJSON(): string {
    return this.redactedSummary();
  }

  /** Subscribes `listener` to `event` (`'change' | 'error' | 'connection'`). Returns an
   *  unsubscribe function — `const off = client.on('change', cb); off();`. A throwing
   *  listener is caught and reported through the injected `logger`; it never crashes the host
   *  app and never stops other listeners from running (`outputs/SPEC-envpit-a9d-1b-ux.md`
   *  §3.1 principle 4). */
  on<K extends keyof EnvpitClientEvents>(event: K, listener: (payload: EnvpitClientEvents[K]) => void): () => void {
    return this.emitter.on(event, listener);
  }

  /** Point-in-time cache freshness/health — see `CacheInfo` for field meaning. */
  get cacheInfo(): CacheInfo {
    return {
      fetchedAt: this.fetchedAt,
      ageMs: this.fetchedAt ? Date.now() - this.fetchedAt.getTime() : null,
      lastError: this.lastError,
      etag: this.etag,
      refreshMode: this.refreshMode,
      realtimeSince: this.refreshMode === 'realtime' ? this.realtimeSince : null,
      lastChangeAt: this.lastChangeAt,
    };
  }

  /**
   * Populates `process.env` from THIS client's current snapshot (bd:envpit-yvyr — owner
   * directive 2026-07-27: existing `process.env.DATABASE_URL`-style code should keep working
   * untouched, rather than every caller being forced through `envpit.get(...)`). Opt-in only —
   * never called automatically by `load()` or a background refresh.
   *
   * Boot-time snapshot, not live (owner-confirmed trade-off, stated plainly rather than
   * discovered in production): this writes the values held AT THE MOMENT OF THIS CALL. Node's
   * `process.env` is a plain object with no refresh hook — unlike `client.get(key)` (always a
   * synchronous read of the latest in-memory snapshot, kept current by the poll timer / SSE
   * push), a value written here will NOT move again on a later `change` event. Call this again
   * after a `change` if you need the merge to catch up, or keep using `client.get(...)` for
   * anything that must always be current.
   *
   * `options` is entirely optional (bd:envpit-durd) — the zero-arg call
   * `await envpit.mergeIntoProcessEnv()` is the SAFE default: it merges only non-secret keys
   * (`includeSecrets` defaults to `false`) and never clobbers a `process.env` value the host
   * already set (`override` defaults to `false`). Naming `includeSecrets: true` at the call
   * site IS the acknowledgment that secret-flagged values will be written into `process.env` —
   * see `MergeIntoProcessEnvOptions` for the exposure that trades against.
   */
  mergeIntoProcessEnv(options: MergeIntoProcessEnvOptions = {}): MergeIntoProcessEnvResult {
    if (this.snapshot === null) {
      throw new Error('EnvPit: config not loaded yet — this should be unreachable via EnvpitClient.load().');
    }
    return mergeSnapshotIntoEnv(this.snapshot, process.env, options);
  }

  /** Key NAMES (never values) of every secret-flagged key in this client's current snapshot —
   *  the same passthrough list the server sent as `secretKeys` (bd:envpit-durd, AC-SEC-E11).
   *  Lets a caller write its own filter (e.g. over a hand-rolled config object) without
   *  re-fetching or re-deriving anything the SDK already has in memory. */
  secretKeys(): readonly string[] {
    if (this.snapshot === null) {
      throw new Error('EnvPit: config not loaded yet — this should be unreachable via EnvpitClient.load().');
    }
    return this.snapshot.secretKeys;
  }

  /** Raw string read. Throws `MissingKeyError` if the key is absent/null and no
   *  `defaultValue` is given. */
  get(key: string, defaultValue?: string): string {
    const raw = this.readRaw(key);
    if (raw !== undefined) return raw;
    if (defaultValue !== undefined) return defaultValue;
    throw this.missingKeyError(key);
  }

  /** Alias of `get()` — explicit typed-getter naming to match the other 3 getters. */
  getString(key: string, defaultValue?: string): string {
    return this.get(key, defaultValue);
  }

  /** Non-throwing counterpart to `get()` (bd:envpit-ed3h Part 3,
   *  `outputs/SPEC-envpit-0t2z-1b-ux.md` §A1's `getOptional` escape hatch) — `undefined` for a
   *  key that's absent or `null`, never a `MissingKeyError`. Prefer this when a missing key is
   *  an expected, handled case rather than a fail-loud misconfiguration. */
  getOptional(key: string): string | undefined {
    return this.readRaw(key);
  }

  /** Parses the value as a base-10 integer. Throws `TypeMismatchError` if it isn't one. */
  getInt(key: string, defaultValue?: number): number {
    const raw = this.readRaw(key);
    if (raw === undefined) {
      if (defaultValue !== undefined) return defaultValue;
      throw this.missingKeyError(key);
    }
    const trimmed = raw.trim();
    if (!INTEGER_PATTERN.test(trimmed)) {
      throw new TypeMismatchError(key, 'integer', raw);
    }
    return Number.parseInt(trimmed, 10);
  }

  /** Parses the value as a boolean. Accepts (case-insensitive) true/false, 1/0, yes/no,
   *  on/off. Throws `TypeMismatchError` for anything else. */
  getBoolean(key: string, defaultValue?: boolean): boolean {
    const raw = this.readRaw(key);
    if (raw === undefined) {
      if (defaultValue !== undefined) return defaultValue;
      throw this.missingKeyError(key);
    }
    const normalized = raw.trim().toLowerCase();
    if (TRUE_VALUES.has(normalized)) return true;
    if (FALSE_VALUES.has(normalized)) return false;
    throw new TypeMismatchError(key, 'boolean', raw);
  }

  /** Builds a `MissingKeyError` with a did-you-mean suggestion computed against the currently
   *  loaded snapshot's own key set (bd:envpit-ed3h Part 3) — shared by `get()`/`getInt()`/
   *  `getBoolean()` so the suggestion behaves identically no matter which getter missed. */
  private missingKeyError(key: string): MissingKeyError {
    const knownKeys = this.snapshot === null ? [] : Object.keys(this.snapshot.values);
    return new MissingKeyError(key, suggestNearestKey(key, knownKeys));
  }

  private readRaw(key: string): string | undefined {
    // Structurally unreachable via the public API: `load()` never returns a client without a
    // successful first fetch (it rejects instead). Kept as a defensive guard, not a documented
    // failure mode — see the removed pre-`EnvpitClient` test that covered this on the old
    // constructor+`.start()` two-step shape.
    if (this.snapshot === null) {
      throw new Error('EnvPit: config not loaded yet — this should be unreachable via EnvpitClient.load().');
    }
    const value = this.snapshot.values[key];
    return value === null || value === undefined ? undefined : value;
  }

  private async refresh({ isFirstLoad, trigger }: { isFirstLoad: boolean; trigger?: ChangeTrigger }): Promise<void> {
    // In-flight guard (bd:envpit-1mvf): claim this call's generation BEFORE awaiting the fetch,
    // so any refresh() issued later (poll tick, another push, reconnect catch-up) is guaranteed
    // a strictly higher generation number.
    const myGeneration = ++this.refreshGeneration;
    try {
      const result = await fetchConfig({
        host: this.host,
        apiKey: this.apiKey,
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs,
        scope: this.scope,
        ifNoneMatch: this.etag,
      });

      // A newer refresh() was issued while this one's fetch was in flight — this response is
      // stale/superseded. Discard it silently: do not overwrite the already-fresher in-memory
      // state, and do not fire a `change` event for a result that's about to be thrown away.
      if (myGeneration !== this.refreshGeneration) return;

      if (result.notModified) {
        // Protocol violation guard (bd:envpit-ed3h loop iter-2, Chris High #1): a 304 can only
        // be a valid revalidation when we already hold a snapshot to reuse. On the VERY FIRST
        // load `this.etag` is null, so `ifNoneMatch` is never sent (correct — nothing to
        // revalidate against yet) — a 304 arriving anyway means a misbehaving server, proxy, or
        // CDN returned it unconditionally. Silently "succeeding" here would leave
        // the cache empty while `load()` still resolves — violating `readRaw()`'s class
        // invariant that every `get*()` after a resolved `load()` is safe, and making that
        // guard's "should be unreachable" comment false. Treat it as fatal instead, matching the
        // existing first-load-throws precedent below (`catch`'s `isFirstLoad || this.snapshot
        // === null` propagation path).
        const cached = this.cacheStore.get();
        if (cached === null) {
          throw new NetworkError(
            'EnvPit returned an unexpected 304 Not Modified on the first config fetch, with no ' +
              'previously cached config to reuse (no `If-None-Match` was sent — there was nothing ' +
              'yet to revalidate against). This indicates a misbehaving server, proxy, or CDN.',
          );
        }
        // 304 (bd:envpit-ed3h Part 1): our own `ifNoneMatch` matched the server's current
        // fingerprint — there is no new snapshot to parse or apply. Reuse whatever is already
        // cached as-is (same snapshot + etag, `fetchedAt` bumped to now); this IS a successful
        // refresh (freshness advances, `lastError` clears), it just has nothing new to deliver,
        // so no `change` event fires.
        this.cacheStore.set({ snapshot: cached.snapshot, etag: cached.etag, fetchedAt: new Date() });
        this.lastError = null;
        return;
      }

      const { snapshot, etag } = result;
      const previousSnapshot = this.snapshot;
      this.cacheStore.set({ snapshot, etag, fetchedAt: new Date() });
      this.lastError = null;

      // Consistent-read guarantee (§3.1 principle 3): the snapshot above is already applied
      // BEFORE we emit — a listener calling `client.get(...)` inside its handler sees the new
      // values, never a torn state. No `change` on the very first load (AC-U3), and none when
      // nothing actually differs (this section's own contract, and AC-U3's steady-state half).
      if (!isFirstLoad && previousSnapshot !== null) {
        const changedKeys = diffSnapshots(previousSnapshot.values, snapshot.values);
        if (changedKeys.length > 0) {
          const receivedAt = new Date();
          this.lastChangeAt = receivedAt;
          this.emitter.emit('change', { changedKeys, etag, receivedAt, trigger: trigger ?? 'poll' });
        }
      }
    } catch (err) {
      // Same in-flight guard on the failure path: a stale/superseded refresh's failure must not
      // clobber `cacheInfo.lastError` (or fire a spurious `error` event) once a newer refresh has
      // already landed — only the latest-issued generation's outcome, success or failure, should
      // ever be reflected in client state.
      if (myGeneration !== this.refreshGeneration) return;

      const error = err instanceof Error ? err : new Error(String(err));
      this.lastError = error;
      // Stale-while-revalidate: once we have a snapshot, a refresh failure is recorded on
      // `cacheInfo` but never thrown/propagated — the last good snapshot keeps serving reads.
      if (isFirstLoad || this.snapshot === null) {
        throw error;
      }
      this.logger?.warn?.(
        `envpit: background config refresh failed (${error.name}): ${error.message} — serving last known values`,
      );
      if (error instanceof EnvpitError) {
        this.emitter.emit('error', error);
      }
    }
  }
}

/** Computes changed key NAMES between two in-memory snapshots' VALUES — never sent over the
 *  wire, and never includes values (log-safe by construction, §3.1 principle 1). Deliberately
 *  values-only (bd:envpit-durd): a `secretKeys`-only change (the server re-flagging a key,
 *  values unchanged) is NOT a config change and must not fire `change` — out of scope for this
 *  diff, unchanged from before the envelope existed. A key absent from a snapshot and a key
 *  present-with-`null` are treated identically ("unset"), matching `readRaw()`'s own
 *  missing-vs-null equivalence. */
function diffSnapshots(previous: ConfigValues, next: ConfigValues): string[] {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  const changed: string[] = [];
  for (const key of keys) {
    const before = previous[key] ?? null;
    const after = next[key] ?? null;
    if (before !== after) changed.push(key);
  }
  return changed.sort();
}

// bd:envpit-ed3h Part 3 — did-you-mean. A tiny inline Levenshtein edit distance, per the DX
// spec's own framing ("the SDK holds the full key list in memory — suggesting the nearest key
// (edit distance <= 2) is nearly free", outputs/SPEC-envpit-0t2z-1b-ux.md §A1). Deliberately NOT
// a dependency — the constraint on this bd is "no new heavy deps".
const MAX_SUGGESTION_DISTANCE = 2;

function levenshteinDistance(a: string, b: string): number {
  let prevRow: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const currRow: number[] = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      const deletion = (prevRow[j] ?? 0) + 1;
      const insertion = (currRow[j - 1] ?? 0) + 1;
      const substitution = (prevRow[j - 1] ?? 0) + substitutionCost;
      currRow.push(Math.min(deletion, insertion, substitution));
    }
    prevRow = currRow;
  }
  return prevRow[b.length] ?? 0;
}

/** Nearest key in `knownKeys` within `MAX_SUGGESTION_DISTANCE` edits of `missingKey`, or
 *  `undefined` if none is close enough (or `knownKeys` is empty) — feeds `MissingKeyError`'s
 *  did-you-mean copy. Deterministic tie-break: smallest distance first, then alphabetical. */
function suggestNearestKey(missingKey: string, knownKeys: readonly string[]): string | undefined {
  let best: { key: string; distance: number } | undefined;
  for (const candidate of knownKeys) {
    const distance = levenshteinDistance(missingKey, candidate);
    if (distance > MAX_SUGGESTION_DISTANCE) continue;
    if (!best || distance < best.distance || (distance === best.distance && candidate < best.key)) {
      best = { key: candidate, distance };
    }
  }
  return best?.key;
}
