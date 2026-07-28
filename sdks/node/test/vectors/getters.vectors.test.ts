/**
 * Retrofit (bd:envpit-0t2z.3 Slice 0): the typed-getter happy-path / `MissingKeyError` /
 * `TypeMismatchError` cases that used to live inline in `client.test.ts` now load from
 * `test-vectors/getters.json`. `apiKey` resolution and the stale-while-revalidate lifecycle
 * tests stay inline in `client.test.ts` — they aren't pure input/output data (§ scope contract:
 * only genuinely vector-shaped families move here).
 */
import { describe, expect, it } from 'vitest';
import { EnvpitClient } from '../../src/client.js';
import { MissingKeyError, TypeMismatchError } from '../../src/errors.js';
import type { ConfigValues } from '../../src/types.js';
import { jsonResponse, fakeFetch } from '../test-utils.js';
import { loadVectors } from '../vector-loader.js';

type GetterKind = 'string' | 'int' | 'boolean';
interface GetterVectorCase {
  name: string;
  snapshot: ConfigValues;
  kind: GetterKind;
  key: string;
  default?: string | number | boolean;
  expected: { value: string | number | boolean } | { error: 'MissingKeyError' | 'TypeMismatchError' };
}
interface GetterVectors {
  cases: GetterVectorCase[];
}

const vectors = loadVectors<GetterVectors>('getters.json');
const ERROR_CLASSES = { MissingKeyError, TypeMismatchError } as const;

describe('EnvpitClient typed getters — test-vectors/getters.json', () => {
  for (const c of vectors.cases) {
    it(c.name, async () => {
      const client = await EnvpitClient.load({
        apiKey: 'epk_test',
        pollIntervalMs: 0,
        fetchImpl: fakeFetch([() => jsonResponse(c.snapshot)]),
      });

      const call = (): string | number | boolean => {
        if (c.kind === 'string') return client.get(c.key, c.default as string | undefined);
        if (c.kind === 'int') return client.getInt(c.key, c.default as number | undefined);
        return client.getBoolean(c.key, c.default as boolean | undefined);
      };

      if ('error' in c.expected) {
        expect(call).toThrow(ERROR_CLASSES[c.expected.error]);
      } else {
        expect(call()).toBe(c.expected.value);
      }
    });
  }
});
