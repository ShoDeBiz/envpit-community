package com.envpit;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Native-environment merge semantics (bd:envpit-yvyr + bd:envpit-durd, test-vectors/env-merge.json)
 * — the shared core behind Node's {@code mergeSnapshotIntoEnv}, Go's {@code MergeIntoEnv}, Python's
 * {@code populate_environ}, and the Java Spring Boot starter's EnvPit {@code PropertySource}. Given
 * a resolved snapshot ({@code values} + {@code secretKeys}, exactly as {@link Transport#fetchConfig}
 * unwraps it) an {@code existing} map standing in for whatever already holds a value for a key, and
 * options, produces three SORTED, values-free key-NAME lists: {@code merged}, {@code
 * skippedExisting}, {@code skippedSecrets} — safe to log verbatim by construction (same rule
 * {@link ChangeEvent#changedKeys()} follows).
 *
 * <p><b>Check order per key (exact — asserted by the vector suite):</b>
 * <ol>
 *   <li>a {@code null} value is absent — never written, never counted in ANY list;</li>
 *   <li>a key in {@code secretKeys} is skipped unless {@code includeSecrets} is true;</li>
 *   <li>a key already present in {@code existing} is skipped unless {@code override} is true;</li>
 *   <li>otherwise it is written.</li>
 * </ol>
 * The secret check runs BEFORE the existing-key check: a secret already present in {@code
 * existing} is reported as {@code skippedSecrets}, not {@code skippedExisting} — reporting it the
 * other way would tell the caller "set this yourself and EnvPit will stop skipping it", which is
 * the opposite of what {@code override} actually does (it never smuggles a secret through without
 * {@code includeSecrets} also being true).
 *
 * <p><b>Java-specific note:</b> this is a pure, standalone function — Java has no portable public
 * API to mutate the REAL OS process environment the way Node's {@code process.env}/Go's {@code
 * os.Setenv}/Python's {@code os.environ} do, which is exactly why this SDK's actual production
 * consumer of this algorithm ({@code envpit-spring-boot-starter}'s {@code
 * EnvpitEnvironmentPostProcessor}) builds a Spring {@code PropertySource} instead of mutating a
 * map like this one. That starter only exercises the null-drop + secret-skip/{@code
 * includeSecrets} half of this algorithm in production: Spring's own {@code PropertySource}
 * precedence ordering (command-line/system properties/OS env always outrank the EnvPit source)
 * already supplies the "existing value wins unless overridden" behavior structurally, at the
 * framework level — wiring a redundant {@code existing}/{@code override} check into a
 * lower-precedence {@code PropertySource} would be dead configuration, the same reasoning this
 * SDK's own README gives for why {@code envpit.project}/{@code envpit.environment} were left out.
 * This class exists so the FULL shared algorithm — including {@code existing}/{@code override} —
 * is still implemented once, correctly, and 100% vector-tested against every case in
 * test-vectors/env-merge.json, exactly like the other three languages' equivalent function.
 */
final class NativeEnvMerge {

    private NativeEnvMerge() {
    }

    record MergeResult(List<String> merged, List<String> skippedExisting, List<String> skippedSecrets) {
    }

    static MergeResult merge(Map<String, String> values, Set<String> secretKeys, Map<String, String> existing,
                              boolean includeSecrets, boolean override) {
        List<String> merged = new ArrayList<>();
        List<String> skippedExisting = new ArrayList<>();
        List<String> skippedSecrets = new ArrayList<>();

        for (Map.Entry<String, String> entry : values.entrySet()) {
            String key = entry.getKey();
            String value = entry.getValue();

            if (value == null) {
                continue; // absent — never written, never counted in ANY list
            }
            if (secretKeys.contains(key) && !includeSecrets) {
                skippedSecrets.add(key); // secret check BEFORE the existing check — see class doc
                continue;
            }
            if (existing.containsKey(key) && !override) {
                skippedExisting.add(key);
                continue;
            }
            merged.add(key);
        }

        Collections.sort(merged);
        Collections.sort(skippedExisting);
        Collections.sort(skippedSecrets);
        return new MergeResult(merged, skippedExisting, skippedSecrets);
    }
}
