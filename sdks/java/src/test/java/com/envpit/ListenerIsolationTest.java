package com.envpit;

import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * AC-SDK-05c / INV-SDK-6 (bd:envpit-r59g class), the Java client-level instance: a registered
 * {@code change} listener that throws must be caught and reported through the logger, and every
 * OTHER registered listener for the same event must still run — a throwing listener can never
 * prevent another listener from being invoked, and can never crash the SDK/host.
 * {@link ListenerRegistry}'s {@link java.util.concurrent.CopyOnWriteArrayList}-backed iteration is
 * what makes this true structurally; this test exercises it through the public {@link
 * EnvpitClient#onChange} surface, not the internals directly.
 */
class ListenerIsolationTest {

    @Test
    void aThrowingChangeListenerDoesNotPreventTheNextListenerFromRunningAndIsLogged() throws Exception {
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            TestSupport.CapturingLogger logger = new TestSupport.CapturingLogger();
            server.configHandler = TestSupport.fixedResponse(200, "{\"values\":{\"K\":\"v0\"},\"secretKeys\":[]}");
            EnvpitClient client = EnvpitClient.builder()
                    .apiKey("epk_test").host(server.baseUrl).pollInterval(Duration.ZERO)
                    .httpClient(TestSupport.testHttpClient()).logger(logger).load();
            try {
                AtomicInteger secondListenerCalls = new AtomicInteger(0);
                AtomicInteger thirdListenerCalls = new AtomicInteger(0);

                client.onChange(e -> {
                    throw new RuntimeException("listener-one deliberately throws");
                });
                client.onChange(e -> secondListenerCalls.incrementAndGet());
                client.onChange(e -> thirdListenerCalls.incrementAndGet());

                server.configHandler = TestSupport.fixedResponse(200, "{\"values\":{\"K\":\"v1\"},\"secretKeys\":[]}");
                client.doRefresh(ChangeTrigger.POLL);

                assertEquals(1, secondListenerCalls.get(), "the second listener must still run after the first threw");
                assertEquals(1, thirdListenerCalls.get(), "the third listener must still run after the first threw");

                boolean loggedTheThrow = logger.warns.stream()
                        .anyMatch(m -> m.contains("a config event listener threw") && m.contains("event: change"));
                assertTrue(loggedTheThrow, "expected the throwing listener to be reported via the logger; got: " + logger.warns);
            } finally {
                client.close();
            }
        }
    }

    @Test
    void multipleThrowingListenersEachGetLoggedAndTheHealthyOneStillRuns() throws Exception {
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            TestSupport.CapturingLogger logger = new TestSupport.CapturingLogger();
            server.configHandler = TestSupport.fixedResponse(200, "{\"values\":{\"K\":\"v0\"},\"secretKeys\":[]}");
            EnvpitClient client = EnvpitClient.builder()
                    .apiKey("epk_test").host(server.baseUrl).pollInterval(Duration.ZERO)
                    .httpClient(TestSupport.testHttpClient()).logger(logger).load();
            try {
                AtomicInteger healthyCalls = new AtomicInteger(0);
                client.onChange(e -> {
                    throw new RuntimeException("first");
                });
                client.onChange(e -> healthyCalls.incrementAndGet());
                client.onChange(e -> {
                    throw new RuntimeException("third");
                });

                server.configHandler = TestSupport.fixedResponse(200, "{\"values\":{\"K\":\"v1\"},\"secretKeys\":[]}");
                client.doRefresh(ChangeTrigger.POLL);

                assertEquals(1, healthyCalls.get());
                long throwLogLines = logger.warns.stream().filter(m -> m.contains("a config event listener threw")).count();
                assertEquals(2, throwLogLines, "both throwing listeners must each be reported; got: " + logger.warns);
            } finally {
                client.close();
            }
        }
    }
}
