package com.envpit;

import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Consumes test-vectors/env-merge.json against {@link NativeEnvMerge} — the pure, fully-general
 * implementation of the shared native-environment-merge algorithm (see that class's own doc
 * comment for exactly which subset of it {@code envpit-spring-boot-starter}'s real {@code
 * EnvpitEnvironmentPostProcessor} wires into production, and why {@code existing}/{@code
 * override} aren't both meaningfully exercised there — Spring's own {@code PropertySource}
 * precedence ordering already supplies that half structurally). Every case in the vector file is
 * consumed here, against real code, exactly like the other three languages' equivalent
 * merge-function test.
 */
class VectorsEnvMergeTest {

    @TestFactory
    List<DynamicTest> vectors() {
        Map<String, Object> doc = TestSupport.loadVectorFile("env-merge.json");
        return TestSupport.cases(doc).stream()
                .map(c -> DynamicTest.dynamicTest((String) c.get("name"), () -> runCase(c)))
                .collect(Collectors.toList());
    }

    @SuppressWarnings("unchecked")
    private void runCase(Map<String, Object> c) {
        String name = (String) c.get("name");

        Map<String, Object> snapshot = (Map<String, Object>) c.get("snapshot");
        Map<String, String> values = TestSupport.asStringMap(snapshot.get("values"));
        List<String> secretKeysList = (List<String>) (List<?>) snapshot.get("secretKeys");
        Set<String> secretKeys = Set.copyOf(secretKeysList);

        Map<String, String> existing = TestSupport.asStringMap(c.get("existing"));

        Map<String, Object> options = (Map<String, Object>) c.get("options");
        boolean includeSecrets = Boolean.TRUE.equals(options.get("includeSecrets"));
        boolean override = Boolean.TRUE.equals(options.get("override"));

        Map<String, Object> expected = (Map<String, Object>) c.get("expected");
        List<String> expectedMerged = (List<String>) (List<?>) expected.get("merged");
        List<String> expectedSkippedExisting = (List<String>) (List<?>) expected.get("skippedExisting");
        List<String> expectedSkippedSecrets = (List<String>) (List<?>) expected.get("skippedSecrets");

        NativeEnvMerge.MergeResult result = NativeEnvMerge.merge(values, secretKeys, existing, includeSecrets, override);

        assertEquals(expectedMerged, result.merged(), name + ": merged");
        assertEquals(expectedSkippedExisting, result.skippedExisting(), name + ": skippedExisting");
        assertEquals(expectedSkippedSecrets, result.skippedSecrets(), name + ": skippedSecrets");
    }
}
