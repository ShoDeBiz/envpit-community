/**
 * bd:envpit-durd — consumes `test-vectors/resolve-body.json`: the raw config-resolve 200 body ->
 * unwrapped `{ values, secretKeys }` snapshot, or `NetworkError` for anything that isn't that
 * exact envelope (including the pre-durd bare `{key: value}` map — see that vector file's
 * `notes.breakingChange` for why strict rejection, not a legacy fallback, is correct). Drives the
 * REAL `EnvpitClient`/`fetchConfig` through `fakeFetch`, exactly like every other
 * `*.vectors.test.ts` file in this directory — no re-implementation of the envelope check here.
 */
import { describe, expect, it } from 'vitest';
import { EnvpitClient } from '../../src/client.js';
import { NetworkError } from '../../src/errors.js';
import { fakeFetch } from '../test-utils.js';
import { loadVectors } from '../vector-loader.js';

interface ResolveBodyVectorCase {
  name: string;
  body: unknown;
  expected?: { values: Record<string, string | null>; secretKeys: string[] };
  expectedError?: 'NetworkError';
  why?: string;
}
interface ResolveBodyVectors {
  cases: ResolveBodyVectorCase[];
}

const vectors = loadVectors<ResolveBodyVectors>('resolve-body.json');

function fetchImplForBody(body: unknown): typeof fetch {
  return fakeFetch([
    () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
  ]);
}

describe('config-resolve body envelope unwrap — test-vectors/resolve-body.json', () => {
  for (const c of vectors.cases) {
    it(c.name, async () => {
      if (c.expectedError) {
        await expect(
          EnvpitClient.load({ apiKey: 'epk_test', pollIntervalMs: 0, fetchImpl: fetchImplForBody(c.body) }),
        ).rejects.toThrow(NetworkError);
        return;
      }

      const expected = c.expected;
      if (!expected) throw new Error(`vector "${c.name}" has neither "expected" nor "expectedError"`);

      const client = await EnvpitClient.load({
        apiKey: 'epk_test',
        pollIntervalMs: 0,
        fetchImpl: fetchImplForBody(c.body),
      });
      try {
        // secretKeys() is a passthrough of the unwrapped envelope's own list (order-agnostic —
        // the vector file only asserts membership/naming, never wire order).
        expect([...client.secretKeys()].sort()).toEqual([...expected.secretKeys].sort());

        for (const [key, value] of Object.entries(expected.values)) {
          if (value === null) {
            expect(client.getOptional(key)).toBeUndefined();
          } else {
            expect(client.getOptional(key)).toBe(value);
          }
        }
      } finally {
        client.close();
      }
    });
  }
});
