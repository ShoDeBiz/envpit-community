/**
 * Unit tests for the wire layer (`src/transport.ts`) — `fetchConfig` in isolation, no
 * `EnvpitClient` involved. bd:envpit-ed3h Part 1 (conditional GET / `If-None-Match` / `304`)
 * and Part 2 (explicit project/environment scope path). Contract evidence:
 * `contract/openapi.json` paths `/v1/config` and
 * `/v1/projects/{projectId}/environments/{environmentId}/config` — both document the
 * `If-None-Match` request header and a `304` response ("nothing changed, no body, no decrypt"),
 * and both use the same `ApiKey` (`X-Api-Key`) security scheme. The app repo sets
 * `app.setGlobalPrefix('api', ...)` (apps/api/src/main.ts) — every contract path is served
 * under `/api` in practice, matching this SDK's existing (pre-Part-1/2) `CONFIG_PATH =
 * '/api/v1/config'` for the alias.
 */
import { describe, expect, it } from 'vitest';
import { AuthenticationError, NetworkError } from '../src/errors.js';
import { fetchConfig } from '../src/transport.js';

const HOST = 'https://example.test';

function capturingFetch(response: Response): { fetchImpl: typeof fetch; seenHeaders: () => Headers | undefined; seenUrl: () => string | undefined } {
  let seenHeaders: Headers | undefined;
  let seenUrl: string | undefined;
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    seenUrl = String(url);
    seenHeaders = new Headers(init?.headers);
    return response;
  }) as unknown as typeof fetch;
  return { fetchImpl, seenHeaders: () => seenHeaders, seenUrl: () => seenUrl };
}

describe('fetchConfig — path building (default alias vs explicit scope, Part 2)', () => {
  it('hits the key-scope-inferred alias GET /api/v1/config when no scope is given', async () => {
    const cap = capturingFetch(new Response(JSON.stringify({ K: 'v' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await fetchConfig({ host: HOST, apiKey: 'epk_test', fetchImpl: cap.fetchImpl, timeoutMs: 1000 });
    expect(cap.seenUrl()).toBe('https://example.test/api/v1/config');
  });

  it('hits GET /api/v1/projects/:project/environments/:environment/config when scope is given', async () => {
    const cap = capturingFetch(new Response(JSON.stringify({ K: 'v' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await fetchConfig({
      host: HOST,
      apiKey: 'epk_test',
      fetchImpl: cap.fetchImpl,
      timeoutMs: 1000,
      scope: { project: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', environment: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' },
    });
    expect(cap.seenUrl()).toBe(
      'https://example.test/api/v1/projects/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/environments/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/config',
    );
  });
});

describe('fetchConfig — conditional GET (Part 1)', () => {
  it('does NOT send If-None-Match on a request with no prior etag', async () => {
    const cap = capturingFetch(new Response(JSON.stringify({ K: 'v' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await fetchConfig({ host: HOST, apiKey: 'epk_test', fetchImpl: cap.fetchImpl, timeoutMs: 1000 });
    expect(cap.seenHeaders()?.has('if-none-match')).toBe(false);
  });

  it('sends If-None-Match: <etag> when a prior etag is supplied', async () => {
    const cap = capturingFetch(new Response(JSON.stringify({ K: 'v' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await fetchConfig({ host: HOST, apiKey: 'epk_test', fetchImpl: cap.fetchImpl, timeoutMs: 1000, ifNoneMatch: '"abc123"' });
    expect(cap.seenHeaders()?.get('if-none-match')).toBe('"abc123"');
  });

  it('still sends X-Api-Key alongside If-None-Match', async () => {
    const cap = capturingFetch(new Response(JSON.stringify({ K: 'v' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await fetchConfig({ host: HOST, apiKey: 'epk_test', fetchImpl: cap.fetchImpl, timeoutMs: 1000, ifNoneMatch: '"abc123"' });
    expect(cap.seenHeaders()?.get('x-api-key')).toBe('epk_test');
  });

  it('returns { notModified: true } on a 304, without attempting to parse a body', async () => {
    const response = new Response(null, { status: 304 });
    const cap = capturingFetch(response);
    const result = await fetchConfig({ host: HOST, apiKey: 'epk_test', fetchImpl: cap.fetchImpl, timeoutMs: 1000, ifNoneMatch: '"abc123"' });
    expect(result).toEqual({ notModified: true });
  });

  it('returns { notModified: false, snapshot, etag } on a normal 200', async () => {
    const cap = capturingFetch(
      new Response(JSON.stringify({ K: 'v' }), { status: 200, headers: { 'content-type': 'application/json', etag: '"new-etag"' } }),
    );
    const result = await fetchConfig({ host: HOST, apiKey: 'epk_test', fetchImpl: cap.fetchImpl, timeoutMs: 1000 });
    expect(result).toEqual({ notModified: false, snapshot: { K: 'v' }, etag: '"new-etag"' });
  });

  it('a 304 still maps 401/403 to AuthenticationError and other non-2xx to NetworkError (regression: 304 branch does not swallow other statuses)', async () => {
    const cap401 = capturingFetch(new Response(null, { status: 401 }));
    await expect(
      fetchConfig({ host: HOST, apiKey: 'epk_test', fetchImpl: cap401.fetchImpl, timeoutMs: 1000, ifNoneMatch: '"x"' }),
    ).rejects.toBeInstanceOf(AuthenticationError);

    const cap500 = capturingFetch(new Response(null, { status: 500 }));
    await expect(
      fetchConfig({ host: HOST, apiKey: 'epk_test', fetchImpl: cap500.fetchImpl, timeoutMs: 1000, ifNoneMatch: '"x"' }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});
