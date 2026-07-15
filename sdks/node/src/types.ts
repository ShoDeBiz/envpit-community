/** One environment's resolved config, exactly the shape `GET /api/v1/config` returns —
 *  key -> value map, secret-flagged keys already decrypted, non-secret keys as-is.
 *  See apps/api/src/config-management/config-resolve.controller.ts (main envpit repo). */
export type ConfigSnapshot = Record<string, string | null>;

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
   *  `0` to disable background refresh (fetch once during `load()` and never again). */
  pollIntervalMs?: number;
  /** Per-request timeout in ms, applied to both the initial load and every background
   *  refresh. Default 5_000. */
  timeoutMs?: number;
  /** Injectable `fetch` implementation — override in tests, or to add proxy/agent support.
   *  Defaults to the global `fetch` (Node >=18). */
  fetchImpl?: typeof fetch;
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
}
