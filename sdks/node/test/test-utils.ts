import type { ConfigSnapshot } from '../src/types.js';

/** Builds a fake `fetch` for injection into `EnvPitOptions.fetchImpl` — no real network I/O
 *  in unit tests (per bd:envpit-0t2z.2's DoD: "mock HTTP layer, ไม่ต้องต่อ EnvPit จริงก็ได้").
 *  Ignores the request URL — every call draws from the same sequential queue. Fine for tests
 *  that only ever make ONE kind of call (`pollIntervalMs: 0`, so the realtime channel never
 *  starts and only `GET …/config` is ever hit). Tests with `pollIntervalMs > 0` — where the
 *  realtime channel ALSO calls `fetchImpl`, for `GET …/config/events` — should use
 *  `routedFetch()` below instead, so the two call streams don't consume each other's queued
 *  responses. */
export function fakeFetch(responses: Array<() => Response | Promise<Response>>): typeof fetch {
  let callCount = 0;
  const fn = (async () => {
    const index = Math.min(callCount, responses.length - 1);
    callCount += 1;
    const factory = responses[index];
    if (!factory) {
      throw new Error('fakeFetch: no response configured for this call');
    }
    return factory();
  }) as unknown as typeof fetch;
  return fn;
}

/** Same idea as `fakeFetch`, but dispatches by request path: `GET …/config` vs.
 *  `GET …/config/events` (`EnvpitClient`'s poll transport and its `RealtimeTransport` share
 *  one injected `fetchImpl` in real use — this lets a test give each its own independent,
 *  ordered response queue). A route with no configured responses left (or omitted entirely)
 *  throws on every call — a deliberate, harmless "this channel is unavailable" default for
 *  tests that only care about the OTHER route (e.g. a poll-only test that doesn't want its
 *  assertions perturbed by the realtime channel's connect attempts). */
export function routedFetch(routes: {
  config?: Array<() => Response | Promise<Response>>;
  events?: Array<() => Response | Promise<Response>>;
}): typeof fetch {
  const queues = { config: routes.config ?? [], events: routes.events ?? [] };
  const counts = { config: 0, events: 0 };
  const fn = (async (input: unknown) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : ((input as { url?: string })?.url ?? '');
    const key: 'config' | 'events' = url.endsWith('/config/events') ? 'events' : 'config';
    const list = queues[key];
    if (list.length === 0) {
      throw new TypeError(`routedFetch: no route configured for "${key}" (${url})`);
    }
    const index = Math.min(counts[key], list.length - 1);
    counts[key] += 1;
    const factory = list[index];
    if (!factory) {
      throw new Error(`routedFetch: no response configured for this "${key}" call`);
    }
    return factory();
  }) as unknown as typeof fetch;
  return fn;
}

export function jsonResponse(body: ConfigSnapshot, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function problemResponse(status: number): Response {
  return new Response(JSON.stringify({ type: 'about:blank', title: 'Error', status, detail: 'x', instance: '/api/v1/config' }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

export function networkFailure(message = 'connect ECONNREFUSED'): () => never {
  return () => {
    throw new TypeError(message);
  };
}
