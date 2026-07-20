package com.envpit;

import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;

/** Consumes test-vectors/snapshot-diff.json. */
class VectorsSnapshotDiffTest {

    @TestFactory
    @SuppressWarnings("unchecked")
    List<DynamicTest> vectors() {
        Map<String, Object> doc = TestSupport.loadVectorFile("snapshot-diff.json");
        return TestSupport.cases(doc).stream().map(c -> DynamicTest.dynamicTest((String) c.get("name"), () -> {
            Map<String, String> before = TestSupport.asStringMap(c.get("before"));
            Map<String, String> after = TestSupport.asStringMap(c.get("after"));
            List<String> expected = (List<String>) (List<?>) c.get("expectedChangedKeys");

            ConfigSnapshot beforeSnap = new ConfigSnapshot(before);
            ConfigSnapshot afterSnap = new ConfigSnapshot(after);
            List<String> got = SnapshotDiff.diff(beforeSnap, afterSnap);
            assertEquals(expected, got, (String) c.get("name"));
        })).collect(Collectors.toList());
    }
}
