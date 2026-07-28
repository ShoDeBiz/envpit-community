/**
 * New (bd:envpit-0t2z.3 Slice 0) — `diffSnapshots` in `client.ts` is a private, unexported
 * function (correctly so: it's an internal implementation detail, not public API), so this
 * cannot import and unit-test it directly without changing `src/` — out of Slice 0's scope
 * (test-infrastructure extraction only, no runtime/API-surface changes). Instead this drives the
 * REAL `EnvpitClient` through two successive poll-triggered fetches (`before` then `after`) and
 * observes `diffSnapshots`'s result the same way any real caller would: via the `change` event's
 * `changedKeys`. This is additive coverage alongside the existing scenario tests in
 * `realtime-adversarial.test.ts` (which combine the diff with push/etag semantics) — those stay;
 * this file isolates the pure diff algorithm against `test-vectors/snapshot-diff.json`.
 */
import { describe, expect, it, vi } from 'vitest';
import { EnvpitClient } from '../../src/client.js';
import type { ChangeEvent, ConfigValues } from '../../src/types.js';
import { jsonResponse, routedFetch } from '../test-utils.js';
import { loadVectors } from '../vector-loader.js';

interface SnapshotDiffVectorCase {
  name: string;
  before: ConfigValues;
  after: ConfigValues;
  expectedChangedKeys: string[];
}
interface SnapshotDiffVectors {
  cases: SnapshotDiffVectorCase[];
}

const vectors = loadVectors<SnapshotDiffVectors>('snapshot-diff.json');

describe('EnvpitClient — diffSnapshots (via change event) — test-vectors/snapshot-diff.json', () => {
  for (const c of vectors.cases) {
    it(c.name, async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const changes: ChangeEvent[] = [];
        const client = await EnvpitClient.load({
          apiKey: 'epk_test',
          pollIntervalMs: 1_000,
          fetchImpl: routedFetch({ config: [() => jsonResponse(c.before), () => jsonResponse(c.after)] }),
        });
        client.on('change', (e) => changes.push(e));

        await vi.advanceTimersByTimeAsync(1_000); // triggers the poll refresh: before -> after

        if (c.expectedChangedKeys.length === 0) {
          expect(changes).toHaveLength(0);
        } else {
          expect(changes).toHaveLength(1);
          expect(changes[0]?.changedKeys).toEqual(c.expectedChangedKeys);
        }

        client.close();
      } finally {
        vi.useRealTimers();
      }
    });
  }
});
