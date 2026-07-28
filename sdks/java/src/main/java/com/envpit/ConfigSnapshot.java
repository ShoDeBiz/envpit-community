package com.envpit;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * One environment's resolved config — key -&gt; value map, secret-flagged keys already decrypted
 * server-side. A missing key and a key present with a {@code null} value are treated identically
 * ("unset") by every getter and by {@link SnapshotDiff} — the null≡absent rule (INV-SDK-7).
 *
 * <p><b>AC-SEC-SDK3-1 (THREATMODEL-envpit-0t2z-3.md F1):</b> a plain {@code Map<String,String>}
 * held on {@link EnvpitClient} would leak every config value (including decrypted secrets) the
 * moment anything calls {@code toString()} on it — {@link java.util.AbstractMap#toString()}
 * happily prints every entry. This wrapper is the deliberate redaction boundary: it never exposes
 * its backing map, and its own {@link #toString()} is explicitly redacting.
 *
 * <p><b>bd:envpit-durd:</b> also carries {@code secretKeys} — the NAMES (never values) of keys the
 * server flagged {@code is_secret=true} for this environment (test-vectors/resolve-body.json).
 * {@link SnapshotDiff} and every getter deliberately keep reading only {@link #get}/{@link
 * #rawForDiffOnly()} (the values map) — a secretKeys-only change between two fetches is NOT a
 * config change (out of scope for this bd, see {@code EnvpitClient#knownSecretKeys()}'s own doc
 * comment for why the filtering seam lives elsewhere, not here).
 */
final class ConfigSnapshot {

    private final Map<String, String> values;
    private final Set<String> secretKeys;

    ConfigSnapshot(Map<String, String> values) {
        this(values, Set.of());
    }

    ConfigSnapshot(Map<String, String> values, Set<String> secretKeys) {
        // Collections.unmodifiableMap (not Map.copyOf) — Map.copyOf/Map.of reject null VALUES,
        // and null-valued entries are a real, contractual shape here (null≡absent).
        this.values = Collections.unmodifiableMap(new LinkedHashMap<>(values));
        this.secretKeys = Collections.unmodifiableSet(new java.util.LinkedHashSet<>(secretKeys));
    }

    static ConfigSnapshot empty() {
        return new ConfigSnapshot(Map.of(), Set.of());
    }

    /** Raw string value, or {@code null} if the key is absent OR present-with-null. */
    String get(String key) {
        return values.get(key);
    }

    int size() {
        return values.size();
    }

    Set<String> keySet() {
        return values.keySet();
    }

    /**
     * Key NAMES only (never values) the server flagged {@code is_secret=true} for this
     * environment — already unmodifiable, safe to hand out directly (matches {@link #keySet()}'s
     * own no-copy-needed posture: both are read-only views over immutable state).
     */
    Set<String> secretKeys() {
        return secretKeys;
    }

    /** Package-visible escape hatch for {@link SnapshotDiff} only — never exposed publicly. */
    Map<String, String> rawForDiffOnly() {
        return values;
    }

    /**
     * Deliberately redacting — AC-SEC-SDK3-1. Never call code that would print the actual values
     * (no {@code values.toString()}, no iteration into the message).
     */
    @Override
    public String toString() {
        return "ConfigSnapshot(keys=" + values.size() + ", values=<redacted>)";
    }
}
