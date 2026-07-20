package com.envpit;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.fail;

/** Consumes test-vectors/getters.json — shared across Node/Python/Go/Java. */
class VectorsGettersTest {

    private static TestSupport.TestServer server;

    @BeforeAll
    static void startServer() {
        server = TestSupport.TestServer.start();
    }

    @AfterAll
    static void stopServer() {
        server.close();
    }

    @TestFactory
    List<DynamicTest> vectors() {
        Map<String, Object> doc = TestSupport.loadVectorFile("getters.json");
        List<Map<String, Object>> cases = TestSupport.cases(doc);
        return cases.stream()
                .map(c -> DynamicTest.dynamicTest((String) c.get("name"), () -> runCase(c)))
                .collect(Collectors.toList());
    }

    @SuppressWarnings("unchecked")
    private void runCase(Map<String, Object> c) {
        String name = (String) c.get("name");
        Map<String, String> snapshot = TestSupport.asStringMap(c.get("snapshot"));
        String kind = (String) c.get("kind");
        String key = (String) c.get("key");
        boolean hasDefault = c.containsKey("default");
        Map<String, Object> expected = (Map<String, Object>) c.get("expected");

        String snapshotJson = TestSupport.toJson(snapshot);
        EnvpitClient client = TestSupport.newLoadedClient(server, snapshotJson);
        try {
            switch (kind) {
                case "string" -> {
                    if (hasDefault) {
                        String def = (String) c.get("default");
                        String want = (String) expected.get("value");
                        assertEquals(want, client.get(key, def), name);
                    } else {
                        assertOutcome(name, expected, () -> client.get(key), v -> assertEquals(expected.get("value"), v, name));
                    }
                }
                case "int" -> {
                    if (hasDefault) {
                        int def = ((Double) c.get("default")).intValue();
                        int want = ((Double) expected.get("value")).intValue();
                        assertEquals(want, client.getInt(key, def), name);
                    } else {
                        assertOutcome(name, expected, () -> client.getInt(key),
                                v -> assertEquals(((Double) expected.get("value")).intValue(), v, name));
                    }
                }
                case "boolean" -> {
                    if (hasDefault) {
                        boolean def = (Boolean) c.get("default");
                        boolean want = (Boolean) expected.get("value");
                        assertEquals(want, client.getBoolean(key, def), name);
                    } else {
                        assertOutcome(name, expected, () -> client.getBoolean(key),
                                v -> assertEquals(expected.get("value"), v, name));
                    }
                }
                default -> fail("unhandled kind " + kind);
            }
        } finally {
            client.close();
        }
    }

    private void assertOutcome(String name, Map<String, Object> expected, java.util.function.Supplier<Object> call,
                                java.util.function.Consumer<Object> checkValue) {
        String wantError = (String) expected.get("error");
        if (wantError != null) {
            EnvpitException ex = assertThrows(EnvpitException.class, call::get, name);
            assertEquals(wantError, ex.getClass().getSimpleName().replace("Exception", "Error"), name);
        } else {
            checkValue.accept(call.get());
        }
    }

}
