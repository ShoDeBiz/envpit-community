package com.envpit;

import org.junit.jupiter.api.Test;

import java.net.http.HttpClient;
import java.time.Duration;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Thread/executor-leak check (task brief item), the Java sibling of Go's {@code
 * TestGoroutineLeak_CreateSubscribeCloseCyclesReturnToBaseline}: N cycles of create-&gt;subscribe-&gt;
 * close must return to the SAME set of SDK-owned threads every time — not just "doesn't grow
 * unbounded" over N cycles, but an exact per-cycle return to zero, which is the stronger claim
 * {@link EnvpitClient#close()}'s doc comment makes (every scheduled task cancelled, every executor
 * cleanly shut down).
 *
 * <p>Scoped to SDK-owned thread NAMES (the {@code envpit-dispatch}/{@code envpit-realtime} daemon
 * threads {@link EnvpitClient}'s constructor creates) rather than a raw {@code
 * Thread.activeCount()} delta — {@code java.net.http.HttpClient} (JDK 17; it gained {@code
 * AutoCloseable} only in JDK 21) has its own internal selector-manager thread whose teardown
 * timing is a JDK implementation detail this SDK does not control and must not assert on. A single
 * shared {@link HttpClient} instance is injected across every cycle specifically so that detail
 * never enters this test's signal at all.
 */
class ThreadLeakTest {

    private static Set<String> envpitOwnedThreadNames() {
        return Thread.getAllStackTraces().keySet().stream()
                .map(Thread::getName)
                .filter(name -> name.startsWith("envpit-"))
                .collect(Collectors.toSet());
    }

    @Test
    void createSubscribeCloseCyclesLeaveNoEnvpitOwnedThreadBehindEveryTime() throws Exception {
        HttpClient sharedHttpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();

        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            server.configHandler = TestSupport.fixedResponse(200, "{\"K\":\"v0\"}");
            server.eventsHandler = TestSupport.fixedResponse(500, "");

            Set<String> baseline = envpitOwnedThreadNames();
            assertTrue(baseline.isEmpty(), "test precondition: no envpit- threads should exist before the first client is created; found: " + baseline);

            final int cycles = 15;
            for (int i = 0; i < cycles; i++) {
                EnvpitClient client = EnvpitClient.builder()
                        .apiKey("epk_test")
                        .host(server.baseUrl)
                        .pollInterval(Duration.ofMillis(50))
                        .httpClient(sharedHttpClient)
                        .logger(null)
                        .load();

                Subscription s1 = client.onChange(e -> { });
                Subscription s2 = client.onConnection(e -> { });
                Subscription s3 = client.onError(e -> { });

                // At least the dispatch thread must be observably alive mid-lifecycle — otherwise
                // this test would trivially "pass" by never having created anything to leak.
                Set<String> midLifecycle = envpitOwnedThreadNames();
                assertTrue(midLifecycle.stream().anyMatch(n -> n.equals("envpit-dispatch")),
                        "cycle " + i + ": expected an envpit-dispatch thread while the client is open; found: " + midLifecycle);

                s1.close();
                s2.close();
                s3.close();
                client.close();

                // close()'s own awaitTermination/join calls already block until the executor and
                // realtime thread are done — this short poll only absorbs the benign, well-known
                // ThreadPoolExecutor race where a worker thread signals termination a few
                // microseconds before Thread.getAllStackTraces() stops enumerating it (same reason
                // Go's goroutine-leak test polls to a "stable" count rather than sampling once).
                boolean settled = TestSupport.waitUntil(Duration.ofMillis(500), () -> envpitOwnedThreadNames().isEmpty());
                Set<String> afterClose = envpitOwnedThreadNames();
                assertTrue(settled, "cycle " + i + ": envpit-owned threads leaked past close(): " + afterClose);
            }
        }
    }

    @Test
    void pollDisabledClientCreatesNoBackgroundThreadsAtAll() throws Exception {
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            EnvpitClient client = TestSupport.newLoadedClient(server, "{\"K\":\"v0\"}"); // pollInterval = ZERO
            try {
                // INV-SDK-8: pollIntervalMs 0 = no background refresh of any kind, including realtime.
                Set<String> names = envpitOwnedThreadNames();
                assertTrue(names.isEmpty(), "a poll-disabled client must spawn zero background threads; found: " + names);
            } finally {
                client.close();
            }
        }
    }
}
