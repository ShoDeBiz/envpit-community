/**
 * Retrofit (bd:envpit-0t2z.3 Slice 0): the `AuthenticationError` / `NetworkError on first load`
 * cases that used to live inline in `client.test.ts` now load from
 * `test-vectors/error-mapping.json`.
 */
import { describe, expect, it } from 'vitest';
import { EnvpitClient } from '../../src/client.js';
import { AuthenticationError, NetworkError } from '../../src/errors.js';
import { fakeFetch, networkFailure, problemResponse } from '../test-utils.js';
import { loadVectors } from '../vector-loader.js';

interface ErrorMappingVectorCase {
  name: string;
  condition: { status: number } | { transportFailure: 'timeout' | 'connection-refused' | 'invalid-json-body' };
  expectedError: 'AuthenticationError' | 'NetworkError';
}
interface ErrorMappingVectors {
  cases: ErrorMappingVectorCase[];
}

const vectors = loadVectors<ErrorMappingVectors>('error-mapping.json');
const ERROR_CLASSES = { AuthenticationError, NetworkError } as const;

function fetchImplFor(condition: ErrorMappingVectorCase['condition']): typeof fetch {
  if ('status' in condition) {
    return fakeFetch([() => problemResponse(condition.status)]);
  }
  if (condition.transportFailure === 'invalid-json-body') {
    return fakeFetch([() => new Response('not valid json {{', { status: 200, headers: { 'content-type': 'application/json' } })]);
  }
  const message = condition.transportFailure === 'timeout' ? 'timed out' : 'connect ECONNREFUSED';
  return fakeFetch([networkFailure(message)]);
}

describe('EnvpitClient.load() error mapping — test-vectors/error-mapping.json', () => {
  for (const c of vectors.cases) {
    it(c.name, async () => {
      await expect(
        EnvpitClient.load({ apiKey: 'epk_test', pollIntervalMs: 0, fetchImpl: fetchImplFor(c.condition) }),
      ).rejects.toThrow(ERROR_CLASSES[c.expectedError]);
    });
  }
});
