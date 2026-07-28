import { AuthenticationError, NetworkError } from './errors.js';
import type { ConfigSnapshot, ConfigValues } from './types.js';

/** Explicit project+environment scope override (bd:envpit-ed3h Part 2). When set, `fetchConfig`
 *  targets the DISTINCT `GET {host}/api/v1/projects/:project/environments/:environment/config`
 *  path (`ApiKeyConfigResolveController_resolve`, `contract/openapi.json`) instead of the
 *  key-scope-inferred alias below. Auth is unchanged — both paths use the same `ApiKey`
 *  (`X-Api-Key`) security scheme in the contract. */
export interface ConfigScope {
  project: string;
  environment: string;
}

/** The one real HTTP call this SDK makes (Phase 1 scope — no bootstrap/handshake endpoint).
 *  Default (no `scope`): `GET {host}/api/v1/config` — the key-scope-inferred alias
 *  (`ApiKeyScopedConfigResolveController` in the main repo): auth via `X-Api-Key`, project+
 *  environment are inferred server-side from the key itself. With `scope`: the explicit
 *  `GET {host}/api/v1/projects/:project/environments/:environment/config` path — see
 *  `ConfigScope`. */
export interface FetchConfigParams {
  host: string;
  apiKey: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  /** Explicit project/environment override — see `ConfigScope`. `undefined` (default) uses the
   *  key-scope-inferred alias path. */
  scope?: ConfigScope;
  /** The `ETag` of the snapshot this caller already holds, if any (bd:envpit-ed3h Part 1) —
   *  sent as `If-None-Match` (`contract/openapi.json`: both the alias and the explicit-scope
   *  path document this request header and a `304` response). `undefined`/`null` sends no
   *  conditional header at all — the correct behavior on the very first load, where there is
   *  nothing yet to revalidate against. */
  ifNoneMatch?: string | null;
}

const CONFIG_PATH_ALIAS = '/api/v1/config';

function buildConfigPath(scope: ConfigScope | undefined): string {
  if (!scope) return CONFIG_PATH_ALIAS;
  return `/api/v1/projects/${encodeURIComponent(scope.project)}/environments/${encodeURIComponent(scope.environment)}/config`;
}

/** `fetchConfig`'s result. A `304 Not Modified` (bd:envpit-ed3h Part 1 — the caller's
 *  `ifNoneMatch` matched the server's current fingerprint) is a DISTINCT outcome from a normal
 *  fetch: there is no snapshot to parse or transfer, and the caller must reuse whatever it
 *  already has (`contract/openapi.json` `304` response on `GET …/config`: "nothing changed, no
 *  body, no decrypt, no KMS unwrap"). */
export type FetchConfigResult =
  | { notModified: true }
  | { notModified: false; snapshot: ConfigSnapshot; etag: string | null };

export async function fetchConfig({ host, apiKey, fetchImpl, timeoutMs, scope, ifNoneMatch }: FetchConfigParams): Promise<FetchConfigResult> {
  const url = `${host}${buildConfigPath(scope)}`;
  const response = await performRequest(url, apiKey, fetchImpl, timeoutMs, ifNoneMatch);

  if (response.status === 304) {
    return { notModified: true };
  }

  if (response.status === 401 || response.status === 403) {
    throw new AuthenticationError(
      `API key rejected (HTTP ${response.status}). It may be revoked, expired, or mistyped. ` +
        `Check Project → API Keys in EnvPit.`,
    );
  }

  if (!response.ok) {
    throw new NetworkError(`EnvPit returned HTTP ${response.status} while fetching config from ${url}.`);
  }

  const snapshot = await parseJsonBody(response, url);
  return { notModified: false, snapshot, etag: response.headers.get('etag') };
}

async function performRequest(
  url: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  ifNoneMatch: string | null | undefined,
): Promise<Response> {
  try {
    const headers: Record<string, string> = { 'X-Api-Key': apiKey };
    if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch;
    return await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    throw new NetworkError(
      `Could not reach EnvPit at ${url} (${describeFailure(cause)}). Check your network/proxy and https://status.envpit.com.`,
    );
  }
}

async function parseJsonBody(response: Response, url: string): Promise<ConfigSnapshot> {
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new NetworkError(`EnvPit returned an invalid JSON response from ${url}.`);
  }
  return parseConfigSnapshotEnvelope(raw, url);
}

/**
 * Validates + unwraps the `{ values, secretKeys }` envelope (bd:envpit-durd, AC-SEC-E11,
 * `test-vectors/resolve-body.json`). Strict by design: the pre-durd bare `{key: value}` map —
 * and anything else that isn't exactly this envelope — is REJECTED as a `NetworkError` rather
 * than accepted as a legacy fallback. Accepting a bare map would mean `secretKeys` reads as
 * `[]`, which `mergeSnapshotIntoEnv` would take as "this environment has no secrets" and merge
 * production secrets into `process.env` while reporting that it excluded them — failing loudly
 * against a pre-durd (or otherwise malformed) server is the safe direction. There were zero
 * published SDK releases when bd:envpit-durd landed, so no real consumer regresses from this
 * strictness (see the vector file's `notes.breakingChange`).
 *
 * An unmatched name in `secretKeys` (one that doesn't appear in `values`) is deliberately
 * tolerated, not an error — see `test-vectors/resolve-body.json`'s
 * `secret-key-absent-from-values-is-tolerated` case: the two lists come from the same
 * server-side query, but hard-failing on a name this client can't cross-reference would turn
 * any future server-side widening of `secretKeys` into a client-side outage.
 */
function parseConfigSnapshotEnvelope(raw: unknown, url: string): ConfigSnapshot {
  // Two different failures, same `NetworkError` class, deliberately different messages — the same
  // split Go and Python make. `notAnObject` means the body was never a config-resolve response at
  // all (a proxy error page, a truncated stream); `malformed` means it WAS a JSON object but not
  // this envelope, which is overwhelmingly a server predating the secret-labelling change. One
  // shared message would tell someone whose reverse proxy returned HTML to upgrade their server.
  const notAnObject = (): NetworkError =>
    new NetworkError(`EnvPit returned an invalid JSON response from ${url}.`);

  const malformed = (): NetworkError =>
    new NetworkError(
      `EnvPit returned a config-resolve response this SDK does not understand (from ${url}). ` +
        'Expected `{ values, secretKeys }`. An EnvPit server predating the secret-labelling ' +
        'change returns a bare key -> value map instead — if you self-host, upgrade the server.',
    );

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw notAnObject();
  const body = raw as Record<string, unknown>;

  const { values } = body;
  if (typeof values !== 'object' || values === null || Array.isArray(values)) throw malformed();
  for (const value of Object.values(values as Record<string, unknown>)) {
    if (value !== null && typeof value !== 'string') throw malformed();
  }

  const { secretKeys } = body;
  if (!Array.isArray(secretKeys)) throw malformed();
  for (const key of secretKeys) {
    if (typeof key !== 'string') throw malformed();
  }

  return { values: values as ConfigValues, secretKeys: secretKeys as string[] };
}

function describeFailure(cause: unknown): string {
  if (cause instanceof Error && cause.name === 'TimeoutError') return 'timed out';
  if (cause instanceof Error) return cause.message;
  return 'unknown error';
}
