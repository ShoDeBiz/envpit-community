import type { EnvpitError } from './errors.js';

/** One environment's resolved config VALUES only — key -> value map, secret-flagged keys
 *  already decrypted, non-secret keys as-is. This is the shape `diffSnapshots`/`ChangeEvent`
 *  operate over (bd:envpit-durd — a `secretKeys`-only change is not a config change, so the
 *  diff deliberately stays values-only) and the shape vector families like `getters.json` /
 *  `snapshot-diff.json` describe. See `ConfigSnapshot` below for the full wire envelope this
 *  is nested inside. */
export type ConfigValues = Record<string, string | null>;

/** One environment's resolved config, exactly the shape `GET /api/v1/config` returns as of
 *  bd:envpit-durd (AC-SEC-E11) — `{ values, secretKeys }`, NOT the pre-durd bare `values` map
 *  this type used to alias. `secretKeys` carries KEY NAMES only, never values: an unset
 *  secret still appears here with a `null` `values` entry, because the flag is key-level, not
 *  value-level (`test-vectors/resolve-body.json`). See
 *  apps/api/src/config-management/config-resolve.controller.ts (main envpit repo) for the
 *  authoritative schema. */
export interface ConfigSnapshot {
  values: ConfigValues;
  secretKeys: readonly string[];
}

/** Structurally compatible with `console`, `pino`, and `winston` — pass any of those, or a
 *  hand-rolled object with a subset of these methods. Every method is optional; absent
 *  methods are simply never called. Absent entirely (the default) = the SDK emits no prose,
 *  matching the pre-realtime shipped behavior (`outputs/SPEC-envpit-a9d-1b-ux.md` §3.1
 *  principle 5 — "silent by default, observable by choice"). SDK log lines are always
 *  English (§3.3) and NEVER contain a config value, only key names/counts/durations. */
export interface Logger {
  debug?(message: string): void;
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}

/** Options accepted by `EnvpitClient.load(options)`. All optional — the zero-arg quick-start
 *  (`await EnvpitClient.load()`) covers the common case via `ENVPIT_API_KEY`. */
export interface EnvpitClientOptions {
  /** Sent as the `X-Api-Key` header (never `Authorization` — a separate trust boundary from
   *  session auth, ADR-M5-03). Falls back to `process.env.ENVPIT_API_KEY` when omitted. */
  apiKey?: string;
  /** API host, scheme + authority only (no path). Default: the production single-origin
   *  edge `https://envpit.com` (Caddy routes `/api/*` to the NestJS API — see
   *  docker/caddy/Caddyfile.prod in the main repo). Override for self-hosted/local dev, e.g.
   *  `http://localhost:8080`. */
  host?: string;
  /** Background refresh interval in ms. Default 60_000 (Phase 1 polling — SPEC §10). Set to
   *  `0` to disable ALL background refresh, including the realtime (SSE) channel below — a
   *  `0` here is a true "fetch once during `load()` and never again" mode
   *  (`CacheInfo.refreshMode` reports `'off'`). */
  pollIntervalMs?: number;
  /** Per-request timeout in ms, applied to the initial load and every background poll
   *  refresh. Default 5_000. Not applied to the long-lived realtime (SSE) connection itself
   *  (that connection is expected to stay open for minutes; see `RealtimeTransport`). */
  timeoutMs?: number;
  /** Injectable `fetch` implementation — override in tests, or to add proxy/agent support.
   *  Defaults to the global `fetch` (Node >=18). Used for both the polled config fetch and
   *  the realtime SSE connection. */
  fetchImpl?: typeof fetch;
  /** Optional diagnostics sink for the realtime channel's connect/degrade/restore signals and
   *  background-refresh failures (`outputs/SPEC-envpit-a9d-1b-ux.md` §3.3's normative
   *  level/copy table). Never required — everything it would log is also available
   *  pull-style via `cacheInfo` and push-style via `on('connection', ...)`/`on('error', ...)`. */
  logger?: Logger;
  /** Explicit project/environment scope override (bd:envpit-ed3h Part 2). Bypasses the
   *  key-scope-inferred alias (`GET /v1/config`) and targets
   *  `GET /v1/projects/:project/environments/:environment/config` instead
   *  (`contract/openapi.json` `ApiKeyConfigResolveController_resolve`) — the escape hatch for a
   *  single API key scoped to more than one project/environment (a project-wildcard key), where
   *  the alias otherwise returns a 400 (`outputs/SPEC-envpit-0t2z-1b-ux.md` §A3's
   *  `ENVPIT_KEY_NOT_ENV_PINNED`). Must be given TOGETHER with `environment` below (or both
   *  omitted — the default); each must be the project/environment's UUID (matches the
   *  contract's `projectId`/`environmentId` path params, both `format: "uuid"`). */
  project?: string;
  /** Paired with `project` above — see there. */
  environment?: string;
}

/** Point-in-time view of the SDK's in-memory cache — lets a caller inspect how fresh the
 *  data it just read is, and whether the last background refresh attempt failed (per the
 *  owner-confirmed stale-while-revalidate contract: refresh failures never throw, they keep
 *  serving the last good snapshot and surface the failure here instead). */
export interface CacheInfo {
  /** When the currently-served snapshot was fetched. Always set once `load()` has resolved. */
  fetchedAt: Date | null;
  /** `Date.now() - fetchedAt.getTime()`, or `null` before the first successful load. */
  ageMs: number | null;
  /** The error from the most recent FAILED refresh attempt, if the last attempt failed.
   *  `null` whenever the most recent refresh (or the initial load) succeeded. */
  lastError: Error | null;
  /** The `ETag` response header captured from the currently-served snapshot's fetch (server
   *  fingerprint of the environment's version metadata, bd:envpit-a9d §4.1), or `null` if the
   *  server didn't send one. Matches the `etag` field on a `change`/`config-changed` push. */
  etag: string | null;
  /** `'realtime'` while the SSE channel is connected and delivering push notifications,
   *  `'polling'` while relying solely on the `pollIntervalMs` timer (including any time the
   *  realtime channel is degraded), `'off'` when `pollIntervalMs` is `0` (no background
   *  refresh of any kind is attempted). */
  refreshMode: 'realtime' | 'polling' | 'off';
  /** When the realtime channel most recently became connected. `null` whenever
   *  `refreshMode !== 'realtime'`. */
  realtimeSince: Date | null;
  /** When the currently-served snapshot last differed from the one before it (i.e. the last
   *  time a `change` event fired). `null` if no change has been observed since `load()`. */
  lastChangeAt: Date | null;
}

/** What triggered a `change` event's underlying refresh — always fires the same shape
 *  regardless of transport (`outputs/SPEC-envpit-a9d-1b-ux.md` §3.1 principle 2). */
export type ChangeTrigger = 'push' | 'poll' | 'reconnect';

/** Payload of a `change` event. Log-safe by construction (§3.1 principle 1): key NAMES only,
 *  never values — `JSON.stringify(event)` is always safe to write to any log sink. */
export interface ChangeEvent {
  /** Key names that were added, removed, or had their value change since the previously
   *  served snapshot. Computed client-side from the SDK's own before/after in-memory
   *  snapshots — never sent over the wire. */
  changedKeys: string[];
  /** Fingerprint of the snapshot now being served (the `ETag` this refresh's response
   *  carried), or `null` if the server didn't send one for this refresh. */
  etag: string | null;
  /** When this refresh's response was received and applied. */
  receivedAt: Date;
  /** `'push'` — an SSE `config-changed` notification triggered the refresh that found this
   *  change. `'poll'` — the regular `pollIntervalMs` timer found it. `'reconnect'` — the
   *  realtime channel just (re)connected and a catch-up refresh found a change that may have
   *  been missed while it was down. */
  trigger: ChangeTrigger;
}

/** Realtime channel state: `'realtime'` = the SSE connection is open and receiving pushes;
 *  `'polling'` = relying on `pollIntervalMs` only (never opened, or currently degraded). */
export type ConnectionMode = 'realtime' | 'polling';

/** Why `mode` is what it is. `'connected'` — a normal (re)connect. `'server-reconnect'` —
 *  reserved for the internal bookkeeping of a routine server-initiated rotation; per
 *  `outputs/SPEC-envpit-a9d-1b-ux.md` §3.2/AC-U6 that case resolves within one silent retry
 *  and does not itself surface as a `connection` event (mode never leaves `'realtime'`).
 *  `'network'` — the channel dropped/failed to connect and did not recover within the quiet
 *  retry window. `'unsupported'` — this runtime's `fetch` doesn't expose a streamable
 *  response body; the SDK will not retry the realtime channel again for this client's
 *  lifetime. `'shutdown'` — `close()`/`stop()` was called. */
export type ConnectionReason = 'connected' | 'server-reconnect' | 'network' | 'unsupported' | 'shutdown';

/** Payload of a `connection` event — fires ONLY on an actual `mode` transition, never once
 *  per (re)connect attempt (`outputs/SPEC-envpit-a9d-1b-ux.md` §3.2). */
export interface ConnectionEvent {
  mode: ConnectionMode;
  /** When this `mode` was entered. */
  since: Date;
  reason: ConnectionReason;
}

/** The full set of events `EnvpitClient#on()` accepts, and each one's payload shape. */
export interface EnvpitClientEvents {
  change: ChangeEvent;
  error: EnvpitError;
  connection: ConnectionEvent;
}
