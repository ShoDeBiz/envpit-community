package com.envpit;

import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Consumes test-vectors/hashing.json — forward provision for bd:envpit-0t2z.6 (Feature Flags SDK
 * support), NOT yet build-gating for any language (test-vectors/README.md), but proves Java's
 * {@link Hashing#bucket} matches the exact canonical golden vectors from day one.
 */
class VectorsHashingTest {

    @TestFactory
    List<DynamicTest> vectors() {
        Map<String, Object> doc = TestSupport.loadVectorFile("hashing.json");
        String salt = (String) doc.get("salt");
        return TestSupport.cases(doc).stream().map(c -> {
            String key = (String) c.get("key");
            String name = key.isEmpty() ? "empty-string" : key;
            return DynamicTest.dynamicTest(name, () -> {
                int expected = ((Double) c.get("expectedBucket")).intValue();
                assertEquals(expected, Hashing.bucket(key, salt), "bucket(" + key + ", " + salt + ")");
            });
        }).collect(Collectors.toList());
    }
}
