import type { ConfigSnapshot } from '../src/types.js';

/** Builds a fake `fetch` for injection into `EnvPitOptions.fetchImpl` — no real network I/O
 *  in unit tests (per bd:envpit-0t2z.2's DoD: "mock HTTP layer, ไม่ต้องต่อ EnvPit จริงก็ได้"). */
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
