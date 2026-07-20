/**
 * Backfill (bd:envpit-0t2z.3, Slice-0 follow-up — 2 missing families flagged during the Python
 * dispatch): consumes `test-vectors/error-messages.json` — MESSAGE TEXT/SHAPE per Uma's DX spec
 * flag #6 (`outputs/SPEC-envpit-0t2z-3-1b-ux.md` §2.1/§2.2), a different concern from
 * `error-mapping.json` (error TYPE only). Every case drives the REAL `EnvpitClient`/`fetchConfig`
 * (not a re-implementation of message text), exactly like every other `*.vectors.test.ts` file
 * in this directory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvpitClient } from '../../src/client.js';
import { fakeFetch, jsonResponse, networkFailure, problemResponse, routedFetch } from '../test-utils.js';
import { loadVectors } from '../vector-loader.js';

const TEST_HOST = 'https://example.test';

interface ErrorMessageCase {
  name: string;
  valueFreeCarveOut: boolean;
  condition?: { status: number } | { transportFailure: 'timeout' | 'connection-refused' | 'invalid-json-body' };
  getter?: { snapshot: Record<string, string | null>; kind: 'string' | 'int' | 'boolean'; key: string };
  apiKeyMissing?: boolean;
  backgroundRefresh?: { condition: { status: number } };
  languages?: string[];
  messages: Record<string, { errorClass: string | null; message: string }>;
}
interface ErrorMessageVectors {
  cases: ErrorMessageCase[];
}

const vectors = loadVectors<ErrorMessageVectors>('error-messages.json');
const nodeCases = vectors.cases.filter((c) => !c.languages || c.languages.includes('node'));

function fetchImplForCondition(condition: NonNullable<ErrorMessageCase['condition']>): typeof fetch {
  if ('status' in condition) {
    return fakeFetch([() => problemResponse(condition.status)]);
  }
  if (condition.transportFailure === 'invalid-json-body') {
    return fakeFetch([
      () => new Response('not valid json {{', { status: 200, headers: { 'content-type': 'application/json' } }),
    ]);
  }
  const message = condition.transportFailure === 'timeout' ? 'timed out' : 'connect ECONNREFUSED';
  return fakeFetch([networkFailure(message)]);
}

describe('EnvpitClient error/log MESSAGE TEXT — test-vectors/error-messages.json', () => {
  const originalApiKey = process.env['ENVPIT_API_KEY'];

  beforeEach(() => {
    delete process.env['ENVPIT_API_KEY'];
  });
  afterEach(() => {
    if (originalApiKey !== undefined) process.env['ENVPIT_API_KEY'] = originalApiKey;
    else delete process.env['ENVPIT_API_KEY'];
  });

  for (const c of nodeCases) {
    const expected = c.messages['node'];
    if (!expected) continue;

    it(c.name, async () => {
      if (c.apiKeyMissing) {
        await expect(EnvpitClient.load({ host: TEST_HOST })).rejects.toThrow(expected.message);
        return;
      }

      if (c.getter) {
        const client = await EnvpitClient.load({
          apiKey: 'epk_test',
          host: TEST_HOST,
          pollIntervalMs: 0,
          fetchImpl: fakeFetch([() => jsonResponse(c.getter!.snapshot)]),
        });
        try {
          const call = (): unknown => {
            if (c.getter!.kind === 'string') return client.get(c.getter!.key);
            if (c.getter!.kind === 'int') return client.getInt(c.getter!.key);
            return client.getBoolean(c.getter!.key);
          };
          expect(call).toThrow(expected.message);
        } finally {
          client.close();
        }
        return;
      }

      if (c.backgroundRefresh) {
        // Fake timers to trigger the poll-driven background refresh — same technique as
        // `client.test.ts`'s "stale-while-revalidate on background refresh failure" describe
        // block (no reach-into-private-method shortcut).
        vi.useFakeTimers();
        const logged: string[] = [];
        const logger = { warn: (m: string) => logged.push(m) };
        try {
          const client = await EnvpitClient.load({
            apiKey: 'epk_test',
            host: TEST_HOST,
            pollIntervalMs: 1000,
            logger,
            fetchImpl: routedFetch({
              config: [() => jsonResponse({ K: 'v0' }), () => problemResponse(c.backgroundRefresh!.condition.status)],
            }),
          });
          await vi.advanceTimersByTimeAsync(1000);
          expect(logged).toContain(expected.message);
          client.close();
        } finally {
          vi.useRealTimers();
        }
        return;
      }

      if (c.condition) {
        await expect(
          EnvpitClient.load({ apiKey: 'epk_test', host: TEST_HOST, pollIntervalMs: 0, fetchImpl: fetchImplForCondition(c.condition) }),
        ).rejects.toThrow(expected.message);
        return;
      }

      throw new Error(`error-messages.json case "${c.name}" has no recognized trigger shape`);
    });
  }

  it('the value-free carve-out is exactly the type-mismatch-integer case — every other case omits the raw value', () => {
    const rawValue = 'abc';
    for (const c of nodeCases) {
      const expected = c.messages['node'];
      if (!expected) continue;
      if (c.name === 'type-mismatch-integer') {
        expect(c.valueFreeCarveOut).toBe(true);
        expect(expected.message).toContain(`"${rawValue}"`);
      } else {
        expect(c.valueFreeCarveOut).toBe(false);
      }
    }
  });
});
