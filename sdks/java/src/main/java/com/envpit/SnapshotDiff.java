package com.envpit;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Computes changed key NAMES between two in-memory snapshots — never sent over the wire, never
 * includes values (log-safe by construction, INV-SDK-7). A key absent from a snapshot and a key
 * present-with-null are treated identically ("unset"), matching {@link ConfigSnapshot#get}'s own
 * missing-vs-null equivalence. Ground truth: sdks/node/src/client.ts (diffSnapshots), consumed by
 * every {@code change} event.
 */
final class SnapshotDiff {

    private SnapshotDiff() {
    }

    static List<String> diff(ConfigSnapshot previous, ConfigSnapshot next) {
        Map<String, String> before = previous.rawForDiffOnly();
        Map<String, String> after = next.rawForDiffOnly();

        Set<String> allKeys = new HashSet<>(before.keySet());
        allKeys.addAll(after.keySet());

        List<String> changed = new ArrayList<>();
        for (String key : allKeys) {
            String pv = before.get(key);
            String nv = after.get(key);
            boolean pMissing = pv == null;
            boolean nMissing = nv == null;
            if (pMissing && nMissing) {
                continue; // both unset — no change
            }
            if (pMissing != nMissing) {
                changed.add(key);
                continue;
            }
            if (!pv.equals(nv)) {
                changed.add(key);
            }
        }
        Collections.sort(changed);
        return changed;
    }
}
