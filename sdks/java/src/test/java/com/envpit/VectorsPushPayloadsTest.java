package com.envpit;

import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

import java.net.http.HttpClient;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

/** Consumes test-vectors/push-payloads.json — drives RealtimeTransport.handleFrame directly. */
class VectorsPushPayloadsTest {

    @TestFactory
    List<DynamicTest> vectors() {
        Map<String, Object> doc = TestSupport.loadVectorFile("push-payloads.json");
        return TestSupport.cases(doc).stream().map(c -> DynamicTest.dynamicTest((String) c.get("name"), () -> runCase(c)))
                .collect(Collectors.toList());
    }

    private void runCase(Map<String, Object> c) {
        String name = (String) c.get("name");
        String event = (String) c.get("event");
        String data = (String) c.get("data");
        String expectedBehavior = (String) c.get("expectedBehavior");

        List<String> signaled = new ArrayList<>();
        var executor = java.util.concurrent.Executors.newSingleThreadScheduledExecutor();
        try {
            RealtimeTransport transport = new RealtimeTransport(
                    "https://example.test", "epk_test", HttpClient.newHttpClient(), Duration.ofMinutes(1),
                    SseFrameParser.DEFAULT_MAX_LINE_BYTES,
                    signaled::add,
                    (mode, reason, since) -> {
                    },
                    (level, message) -> {
                    },
                    executor);

            transport.handleFrame(new SseFrame(event, data));

            switch (expectedBehavior) {
                case "refetch" -> {
                    String expectedEtag = (String) c.get("expectedEtag");
                    assertEquals(1, signaled.size(), name);
                    assertEquals(expectedEtag, signaled.get(0), name);
                }
                case "ignore" -> assertTrue(signaled.isEmpty(), name + ": expected no refetch signal, got " + signaled);
                default -> fail("unhandled expectedBehavior " + expectedBehavior);
            }
        } finally {
            executor.shutdownNow();
        }
    }
}
