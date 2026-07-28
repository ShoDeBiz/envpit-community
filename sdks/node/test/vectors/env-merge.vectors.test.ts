/**
 * bd:envpit-durd / bd:envpit-yvyr — consumes `test-vectors/env-merge.json`: the shared
 * native-environment-merge semantics behind `mergeSnapshotIntoEnv`. Exercises the pure core
 * directly (same precedent as `merge-into-process-env.test.ts`'s "pure core" describe block) —
 * `EnvpitClient#mergeIntoProcessEnv` is a thin wrapper over this that swaps in the real
 * `process.env`, covered separately.
 */
import { describe, expect, it } from 'vitest';
import { mergeSnapshotIntoEnv, type MergeIntoProcessEnvOptions } from '../../src/process-env-merge.js';
import type { ConfigSnapshot } from '../../src/types.js';
import { loadVectors } from '../vector-loader.js';

interface EnvMergeVectorCase {
  name: string;
  snapshot: ConfigSnapshot;
  existing: Record<string, string>;
  options: MergeIntoProcessEnvOptions;
  expected: { merged: string[]; skippedExisting: string[]; skippedSecrets: string[] };
  why?: string;
}
interface EnvMergeVectors {
  cases: EnvMergeVectorCase[];
}

const vectors = loadVectors<EnvMergeVectors>('env-merge.json');

describe('mergeSnapshotIntoEnv — test-vectors/env-merge.json', () => {
  for (const c of vectors.cases) {
    it(c.name, () => {
      const target: Record<string, string | undefined> = { ...c.existing };
      const result = mergeSnapshotIntoEnv(c.snapshot, target, c.options);

      expect(result.merged).toEqual(c.expected.merged);
      expect(result.skippedExisting).toEqual(c.expected.skippedExisting);
      expect(result.skippedSecrets).toEqual(c.expected.skippedSecrets);
    });
  }
});
