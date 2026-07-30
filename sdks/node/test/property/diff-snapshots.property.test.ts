/**
 * Property-based tests for `diffSnapshots` (bd:envpit-jf7i) — `client.ts`'s private, unexported
 * pure function. Per the precedent already established in
 * `test/vectors/snapshot-diff.vectors.test.ts`'s header comment ("this cannot import and
 * unit-test it directly without changing src/ — out of scope"), this stays unexported and gets
 * driven through the real public surface: two successive poll-triggered fetches on a real
 * `EnvpitClient`, observed via the `change` event's `changedKeys` — exactly the fixed-vector
 * file's own pattern, generalized to arbitrary inputs.
 *
 * These are genuine PROPERTIES of the diff (its documented contract, not a re-implementation of
 * its algorithm re-asserted as "the test"): completeness, soundness against the raw
 * before/after maps, reflexivity (no self-diff), and symmetry. None of the four requires
 * reproducing the private function's code to check.
 */
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { EnvpitClient } from '../../src/client.js';
import type { ChangeEvent, ConfigValues } from '../../src/types.js';
import { jsonResponse, routedFetch } from '../test-utils.js';

// Small, overlapping key universe — deliberately not "any string" — so most generated
// before/after pairs actually share SOME keys (added/removed/unchanged/changed all get
// exercised), rather than fast-check spending its budget on disjoint maps that only ever add.
const KEY_UNIVERSE = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
const valueArb = fc.option(fc.string({ maxLength: 5 }), { nil: null });
const configValuesArb: fc.Arbitrary<ConfigValues> = fc.dictionary(fc.constantFrom(...KEY_UNIVERSE), valueArb, { maxKeys: KEY_UNIVERSE.length });

/** Drives a real `EnvpitClient` through `before` -> (poll refresh) -> `after` and returns the
 *  resulting `change` event's `changedKeys`, or `[]` if no `change` fired. */
async function observedDiff(before: ConfigValues, after: ConfigValues): Promise<string[]> {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const changes: ChangeEvent[] = [];
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 1_000,
      fetchImpl: routedFetch({ config: [() => jsonResponse(before), () => jsonResponse(after)] }),
    });
    client.on('change', (e) => changes.push(e));
    await vi.advanceTimersByTimeAsync(1_000);
    client.close();
    return changes[0]?.changedKeys ?? [];
  } finally {
    vi.useRealTimers();
  }
}

function normalized(values: ConfigValues, key: string): string | null {
  return values[key] ?? null;
}

describe('diffSnapshots (via EnvpitClient change events) — properties (bd:envpit-jf7i)', () => {
  it('completeness: every changed key name is a key of `before` or `after` (never invented)', async () => {
    await fc.assert(
      fc.asyncProperty(configValuesArb, configValuesArb, async (before, after) => {
        const changedKeys = await observedDiff(before, after);
        const validKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
        for (const key of changedKeys) {
          expect(validKeys.has(key)).toBe(true);
        }
      }),
      { numRuns: 30 },
    );
  });

  it('soundness: a reported changed key ALWAYS has a different normalized value; an unreported key NEVER does', async () => {
    await fc.assert(
      fc.asyncProperty(configValuesArb, configValuesArb, async (before, after) => {
        const changedKeys = await observedDiff(before, after);
        const changedSet = new Set(changedKeys);
        const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

        for (const key of allKeys) {
          const differs = normalized(before, key) !== normalized(after, key);
          expect(changedSet.has(key)).toBe(differs);
        }
      }),
      { numRuns: 30 },
    );
  });

  it('reflexivity: diffing a snapshot against an identical copy of itself never fires `change`', async () => {
    await fc.assert(
      fc.asyncProperty(configValuesArb, async (snapshot) => {
        const changedKeys = await observedDiff(snapshot, { ...snapshot });
        expect(changedKeys).toEqual([]);
      }),
      { numRuns: 20 },
    );
  });

  it('symmetry: the SET of changed keys is the same regardless of which snapshot is "before" and which is "after"', async () => {
    await fc.assert(
      fc.asyncProperty(configValuesArb, configValuesArb, async (a, b) => {
        const forward = await observedDiff(a, b);
        const backward = await observedDiff(b, a);
        expect(new Set(forward)).toEqual(new Set(backward));
      }),
      { numRuns: 20 },
    );
  });

  it('a key present in only one snapshot with a non-null value is always reported (missing-vs-null equivalence: absence = null)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...KEY_UNIVERSE), fc.string({ minLength: 1, maxLength: 5 }), async (key, value) => {
        const before: ConfigValues = {};
        const after: ConfigValues = { [key]: value };
        const changedKeys = await observedDiff(before, after);
        expect(changedKeys).toEqual([key]);
      }),
      { numRuns: 15 },
    );
  });
});
