import { AuthenticationError, NetworkError } from './errors.js';
import type { ConfigSnapshot } from './types.js';

/** The one real HTTP call this SDK makes (Phase 1 scope — no bootstrap/handshake endpoint).
 *  `GET {host}/api/v1/config` — the key-scope-inferred alias (`ApiKeyScopedConfigResolveController`
 *  in the main repo): auth via `X-Api-Key`, project+environment are inferred server-side from
 *  the key itself, so the SDK never needs to know its own project/environment id. */
export interface FetchConfigParams {
  host: string;
  apiKey: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}

const CONFIG_PATH = '/api/v1/config';

export async function fetchConfig({ host, apiKey, fetchImpl, timeoutMs }: FetchConfigParams): Promise<ConfigSnapshot> {
  const url = `${host}${CONFIG_PATH}`;
  const response = await performRequest(url, apiKey, fetchImpl, timeoutMs);

  if (response.status === 401 || response.status === 403) {
    throw new AuthenticationError(
      `API key rejected (HTTP ${response.status}). It may be revoked, expired, or mistyped. ` +
        `Check Project → API Keys in EnvPit.`,
    );
  }

  if (!response.ok) {
    throw new NetworkError(`EnvPit returned HTTP ${response.status} while fetching config from ${url}.`);
  }

  return parseJsonBody(response, url);
}

async function performRequest(url: string, apiKey: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<Response> {
  try {
    return await fetchImpl(url, {
      method: 'GET',
      headers: { 'X-Api-Key': apiKey },
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
