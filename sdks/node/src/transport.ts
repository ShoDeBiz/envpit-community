import { AuthenticationError, NetworkError } from './errors.js';
import type { ConfigSnapshot } from './types.js';

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
  try {
    return (await response.json()) as ConfigSnapshot;
  } catch {
    throw new NetworkError(`EnvPit returned an invalid JSON response from ${url}.`);
  }
}

function describeFailure(cause: unknown): string {
  if (cause instanceof Error && cause.name === 'TimeoutError') return 'timed out';
  if (cause instanceof Error) return cause.message;
  return 'unknown error';
}
