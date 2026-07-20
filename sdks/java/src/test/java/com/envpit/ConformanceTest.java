package com.envpit;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

/**
 * One dedicated test per {@code test-vectors/CONFORMANCE.md} {@code INV-SDK-N} ID, with the ID
 * embedded in the test's own name — CONFORMANCE.md's rule: "Every language's test suite MUST
 * contain at least one test per {@code INV-SDK-N} ID... with the ID in the test's own name" (the
 * future CONFORMANCE-ID grep-gate CI job, Sara §5.3/§5.5, greps for exactly this pattern; matches
 * Go's {@code conformance_test.go} / Python's {@code test_conformance.py} naming convention).
 *
 * <p>Several invariants have MORE THOROUGH coverage elsewhere in this suite ({@link
 * ConnectionResetTest} for the bd:envpit-4dbm class touching INV-SDK-4/11, {@link
 * ListenerIsolationTest} for INV-SDK-6, {@link CloseCancelsScheduledTasksTest} for the
 * bd:envpit-tkvz class touching INV-SDK-10/11, {@link VectorsAdversarialPayloadsTest} for the
 * proposed INV-SDK-13) — this file's job is specifically the ID-grep-gate requirement, not to be
 * the ONLY place each invariant is proven.
 */
class ConformanceTest {

    // ---- INV-SDK-1 — load() sole entry point; first-load failure fatal; no half-init client -----

    @Test
    void test_INV_SDK_1_first_load_failure_is_fatal_no_client_object_ever_escapes() throws Exception {
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            server.configHandler = TestSupport.fixedResponse(500, "{}");
            assertThrows(NetworkException.class, () -> EnvpitClient.builder()
                    .apiKey("epk_test").host(server.baseUrl).pollInterval(Duration.ZERO)
                    .httpClient(TestSupport.testHttpClient()).logger(null).load());
        }
    }

    @Test
    void test_INV_SDK_1_load_itself_never_fires_a_change_event() throws Exception {
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            EnvpitClient client = TestSupport.newLoadedClient(server, "{\"A\":\"1\"}");
            try {
                AtomicInteger fired = new AtomicInteger(0);
                client.onChange(e -> fired.incrementAndGet());
                Thread.sleep(50);
                assertEquals(0, fired.get(), "load() itself must never fire a change event");
            } finally {
                client.close();
            }
        }
    }

    // ---- INV-SDK-2 — every get*() after load is synchronous, in-memory; never a network call ----

    @Test
    void test_INV_SDK_2_getters_after_load_never_trigger_a_network_call() throws Exception {
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            EnvpitClient client = TestSupport.newLoadedClient(server, "{\"K\":\"v\"}"); // the ONE allowed fetch
            try {
                // Install a call-counting handler AFTER load() — anything it observes from here on
                // would have to come from a getter, which must never happen.
                AtomicInteger callsAfterLoad = new AtomicInteger(0);
                server.configHandler = ex -> {
                    callsAfterLoad.incrementAndGet();
                    TestSupport.respond(ex, 200, "{\"K\":\"v\"}", null);
                    return null;
                };

                for (int i = 0; i < 5; i++) {
                    assertEquals("v", client.get("K"));
                }
                assertEquals(0, callsAfterLoad.get(), "getters must NEVER trigger a network call");
            } finally {
                client.close();
            }
        }
    }

    // ---- INV-SDK-3 — memory-only cache, never persisted to disk (GAP-documented convention: -----
    // enforced by a grep gate + code review, not a positive runtime assertion, per CONFORMANCE.md).

    @Test
    void test_INV_SDK_3_runtime_source_contains_no_file_write_api_no_disk_persistence() throws IOException {
        // AC-SEC-SDK3-4: "each SDK's runtime source passes a no-file-write grep/lint gate (...
        // Files.write/FileOutputStream/File.createTempFile (Java))". Implemented directly as a
        // real, CI-enforceable positive assertion (not left as a review-only note) — scans every
        // compiled-from src/main/java source file (test sources are deliberately excluded: this
        // SDK's OWN test harness legitimately reads test-vectors/*.json from disk, which is not
        // the concern here).
        Path mainSrcRoot = Path.of("src/main/java/com/envpit");
        assertTrue(Files.isDirectory(mainSrcRoot), "test precondition: " + mainSrcRoot.toAbsolutePath() + " must exist");

        List<String> forbidden = List.of(
                "FileOutputStream", "FileWriter", "Files.write", "Files.newOutputStream",
                "Files.newBufferedWriter", "File.createTempFile", "RandomAccessFile", "FileChannel");

        try (Stream<Path> files = Files.walk(mainSrcRoot)) {
            List<Path> javaFiles = files.filter(p -> p.toString().endsWith(".java")).toList();
            assertTrue(javaFiles.size() > 10, "sanity check: expected to find this SDK's main source files");

            for (Path file : javaFiles) {
                String content = Files.readString(file);
                for (String api : forbidden) {
                    assertFalse(content.contains(api),
                            "INV-SDK-3 violation: " + file + " references '" + api + "' — this SDK must never write to disk");
                }
            }
        }

        // Positive control for the cap's own reasoning (Sara §2.3 / CONFORMANCE.md INV-SDK-3):
        // java.net.http.HttpClient has no disk response cache by construction (unlike OkHttp,
        // which Sara rejected partly for this reason) — nothing to configure or disable.
    }

    // ---- INV-SDK-4 — stale-while-revalidate: refresh failure keeps last good snapshot -----------

    @Test
    void test_INV_SDK_4_stale_while_revalidate_keeps_last_good_snapshot_on_refresh_failure() throws Exception {
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            EnvpitClient client = TestSupport.newLoadedClient(server, "{\"K\":\"v0\"}");
            try {
                server.configHandler = TestSupport.fixedResponse(500, "{}");
                client.doRefresh(ChangeTrigger.POLL); // must not throw/propagate

                assertEquals("v0", client.get("K"));
                assertInstanceOf(NetworkException.class, client.cacheInfo().lastError());
            } finally {
                client.close();
            }
        }
    }

    // ---- INV-SDK-5 — generation guard: superseded outcomes never clobber fresher state ----------
    // (Java mechanism: single-executor funnel — see EnvpitClient.requestRefresh's own doc comment
    // for why this makes out-of-order resolution impossible BY CONSTRUCTION rather than guarded;
    // this test asserts the OBSERVABLE invariant per Sara's note, not the counter mechanism.)

    @Test
    void test_INV_SDK_5_rapid_concurrent_refresh_triggers_converge_to_the_freshest_server_state() throws Exception {
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            server.configHandler = TestSupport.fixedResponse(200, "{\"K\":\"v0\"}");
            // handlePushSignal only funnels through the dispatch executor when it exists, i.e.
            // pollInterval > 0 (INV-SDK-8's OFF mode has none) — a hung realtime connect keeps the
            // BACKGROUND transport out of this test's way entirely (never itself calls back), so
            // only this test's own manually-driven triggers touch the executor.
            server.eventsHandler = TestSupport.hangForever();
            EnvpitClient client = EnvpitClient.builder()
                    .apiKey("epk_test").host(server.baseUrl).pollInterval(Duration.ofMinutes(10))
                    .httpClient(TestSupport.testHttpClient()).logger(null).load();
            try {
                server.configHandler = TestSupport.fixedResponse(200, "{\"K\":\"v_final\"}");

                // Fire a burst of overlapping refresh triggers (push signals with distinct etags,
                // so none is deduped) — all funnel through the SAME single dispatch executor
                // thread, so at most one doRefresh() is ever running; every trigger's outcome
                // observes the current server state, which never regresses during this burst.
                for (int i = 0; i < 20; i++) {
                    client.handlePushSignal("etag-burst-" + i);
                }

                assertTrue(TestSupport.waitUntil(Duration.ofSeconds(2), () -> "v_final".equals(client.readRaw("K"))),
                        "expected the served value to converge to the freshest server state");
                assertNull(client.cacheInfo().lastError(), "a burst of successful refreshes must never leave a stale error recorded");
            } finally {
                client.close();
            }
        }
    }

    // ---- INV-SDK-6 — safe listener dispatch: a throwing listener never blocks/crashes -----------
    // (see ListenerIsolationTest for the fuller multi-listener proof; this is the ID-tagged anchor)

    @Test
    void test_INV_SDK_6_a_throwing_change_listener_never_blocks_delivery_to_other_listeners() throws Exception {
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            TestSupport.CapturingLogger logger = new TestSupport.CapturingLogger();
            server.configHandler = TestSupport.fixedResponse(200, "{\"K\":\"v0\"}");
            EnvpitClient client = EnvpitClient.builder()
                    .apiKey("epk_test").host(server.baseUrl).pollInterval(Duration.ZERO)
                    .httpClient(TestSupport.testHttpClient()).logger(logger).load();
            try {
                AtomicInteger healthyRan = new AtomicInteger(0);
                client.onChange(e -> {
                    throw new RuntimeException("boom");
                });
                client.onChange(e -> healthyRan.incrementAndGet());

                server.configHandler = TestSupport.fixedResponse(200, "{\"K\":\"v1\"}");
                client.doRefresh(ChangeTrigger.POLL); // must not throw out of this call

                assertEquals(1, healthyRan.get());
                assertTrue(logger.warns.stream().anyMatch(m -> m.contains("a config event listener threw")));
            } finally {
                client.close();
            }
        }
    }

    // ---- INV-SDK-7 — change = key NAMES only (sorted), null≡absent, no-op, consistent read ------

    @Test
    void test_INV_SDK_7_change_payload_is_key_names_only_sorted_and_snapshot_applied_before_delivery() throws Exception {
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            EnvpitClient client = TestSupport.newLoadedClient(server, "{\"A\":\"before\"}");
            try {
                CountDownLatch latch = new CountDownLatch(1);
                AtomicReference<ChangeEvent> received = new AtomicReference<>();
                AtomicReference<String> readInsideListener = new AtomicReference<>();
                client.onChange(e -> {
                    received.set(e);
                    readInsideListener.set(client.get("A")); // must already be the NEW value
                    latch.countDown();
                });

                server.configHandler = TestSupport.fixedResponse(200, "{\"A\":\"after\",\"B\":\"new\"}");
                client.doRefresh(ChangeTrigger.POLL);

                assertTrue(latch.await(2, TimeUnit.SECONDS));
                assertEquals(List.of("A", "B"), received.get().changedKeys(), "expected sorted key names only");
                assertEquals("after", readInsideListener.get(), "the new snapshot must already be readable INSIDE the listener");
                assertFalse(received.get().toString().contains("after"), "the event payload itself must never carry a value");
            } finally {
                client.close();
            }
        }
    }

    @Test
    void test_INV_SDK_7_no_change_event_fires_when_nothing_differs() throws Exception {
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            EnvpitClient client = TestSupport.newLoadedClient(server, "{\"A\":\"1\"}");
            try {
                AtomicInteger fired = new AtomicInteger(0);
                client.onChange(e -> fired.incrementAndGet());

                server.configHandler = TestSupport.fixedResponse(200, "{\"A\":\"1\"}"); // byte-identical content
                client.doRefresh(ChangeTrigger.POLL);

                assertEquals(0, fired.get());
            } finally {
                client.close();
            }
        }
    }

    // ---- INV-SDK-8 — poll is the correctness backstop; interval 0 disables ALL background refresh

    @Test
    void test_INV_SDK_8_poll_interval_zero_disables_all_background_refresh_including_realtime() throws Exception {
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            EnvpitClient client = TestSupport.newLoadedClient(server, "{\"K\":\"v\"}"); // pollInterval = ZERO
            try {
                assertEquals(RefreshMode.OFF, client.cacheInfo().refreshMode());
                assertNull(client.realtimeTransport, "expected no realtime transport at all when poll interval is 0");
            } finally {
                client.close();
            }
        }
    }

    // ---- INV-SDK-9 — etag dedup on push; catch-up refetch on every reconnect except the first ----

    @Test
    void test_INV_SDK_9_etag_dedup_on_push_with_same_etag_does_not_trigger_a_refetch() throws Exception {
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            AtomicInteger calls = new AtomicInteger(0);
            server.configHandler = ex -> {
                calls.incrementAndGet();
                TestSupport.respond(ex, 200, "{\"K\":\"v0\"}", "same-etag");
                return null;
            };
            // pollInterval > 0 (a live dispatch executor) so this is a MEANINGFUL negative
            // assertion — with pollInterval 0 (no executor at all) requestRefresh() is ALSO a
            // no-op regardless of the dedup check, which would make "0 calls" prove nothing.
            server.eventsHandler = TestSupport.hangForever();
            EnvpitClient client = EnvpitClient.builder()
                    .apiKey("epk_test").host(server.baseUrl).pollInterval(Duration.ofMinutes(10))
                    .httpClient(TestSupport.testHttpClient()).logger(null).load(); // captures etag = "same-etag", calls=1
            try {
                calls.set(0);

                client.handlePushSignal("same-etag"); // dedup — must not schedule a refetch
                Thread.sleep(150);
                assertEquals(0, calls.get(), "expected no refetch for a duplicate etag");

                // Positive control: a DIFFERENT etag on the same live executor DOES trigger a
                // refetch — proves the 0-calls result above is the dedup check actually firing,
                // not merely "nothing here ever calls the server".
                client.handlePushSignal("different-etag");
                assertTrue(TestSupport.waitUntil(Duration.ofSeconds(2), () -> calls.get() == 1),
                        "expected a non-matching etag to trigger exactly one refetch");
            } finally {
                client.close();
            }
        }
    }

    @Test
    void test_INV_SDK_9_reconnect_after_first_connect_triggers_catch_up_refetch_not_on_first_connect() throws Exception {
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            AtomicInteger calls = new AtomicInteger(0);
            server.configHandler = ex -> {
                int n = calls.incrementAndGet();
                TestSupport.respond(ex, 200, n == 1 ? "{\"K\":\"v0\"}" : "{\"K\":\"v1\"}", null);
                return null;
            };
            // pollInterval > 0 so a dispatch executor exists at all (handleConnectionModeChange is
            // a no-op with none, per INV-SDK-8); hangForever keeps the REAL background realtime
            // transport out of this test's way — every mode transition below is manually driven.
            server.eventsHandler = TestSupport.hangForever();
            EnvpitClient client = EnvpitClient.builder()
                    .apiKey("epk_test").host(server.baseUrl).pollInterval(Duration.ofMinutes(10))
                    .httpClient(TestSupport.testHttpClient()).logger(null).load(); // consumes call #1
            try {
                // First realtime connect right after load: NO catch-up refetch expected.
                client.handleConnectionModeChange(ConnectionMode.REALTIME, ConnectionReason.CONNECTED, java.time.Instant.now());
                Thread.sleep(150);
                assertEquals(1, calls.get(), "the FIRST post-load realtime connect must not trigger a catch-up refetch");

                // A later reconnect (mode flips to POLLING then back to REALTIME): catch-up refetch expected.
                client.handleConnectionModeChange(ConnectionMode.POLLING, ConnectionReason.NETWORK, java.time.Instant.now());
                client.handleConnectionModeChange(ConnectionMode.REALTIME, ConnectionReason.CONNECTED, java.time.Instant.now());

                assertTrue(TestSupport.waitUntil(Duration.ofSeconds(2), () -> "v1".equals(client.readRaw("K"))),
                        "expected the later reconnect to trigger a catch-up refetch");
            } finally {
                client.close();
            }
        }
    }

    // ---- INV-SDK-10 — quiet-retry/degraded diagnostics cadence: never per-attempt noise ----------

    @Test
    void test_INV_SDK_10_a_single_disconnect_gets_one_silent_retry_before_any_log_line_or_event() throws Exception {
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            server.configHandler = TestSupport.fixedResponse(200, "{\"K\":\"v0\"}");
            server.eventsHandler = TestSupport.fixedResponse(500, "");
            TestSupport.CapturingLogger logger = new TestSupport.CapturingLogger();
            EnvpitClient client = EnvpitClient.builder()
                    .apiKey("epk_test").host(server.baseUrl).pollInterval(Duration.ofSeconds(60))
                    .httpClient(TestSupport.testHttpClient()).logger(logger).load();
            try {
                // The very first failed connect attempt (quiet retry) must log nothing yet.
                Thread.sleep(50);
                assertTrue(logger.infos.isEmpty() && logger.warns.isEmpty(),
                        "the FIRST retry must be silent — got infos=" + logger.infos + " warns=" + logger.warns);

                // After the quiet retry ALSO fails, exactly one degraded-mode info line follows.
                assertTrue(TestSupport.waitUntil(Duration.ofSeconds(2), () -> !logger.infos.isEmpty()),
                        "expected exactly one degraded-mode info line after the quiet retry also failed");
                assertTrue(logger.infos.stream().anyMatch(m -> m.contains("falling back to polling")));
                assertTrue(logger.warns.isEmpty(), "no warn line before the 5-minute threshold");
            } finally {
                client.close();
            }
        }
    }

    // ---- INV-SDK-11 — no config value / API key ever in a message or log line; non-blocking ------

    @Test
    void test_INV_SDK_11_no_api_key_or_config_value_ever_appears_in_a_thrown_error_message() throws Exception {
        String adversarialApiKey = "epk_conformance_secret_7d2a";
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            server.configHandler = TestSupport.fixedResponse(401, "{}");
            try {
                EnvpitClient.builder().apiKey(adversarialApiKey).host(server.baseUrl)
                        .pollInterval(Duration.ZERO).httpClient(TestSupport.testHttpClient()).logger(null).load();
                fail("expected AuthenticationException");
            } catch (AuthenticationException e) {
                assertFalse(e.getMessage().contains(adversarialApiKey));
            }
        }
    }

    @Test
    void test_INV_SDK_11_background_work_runs_on_daemon_threads_and_never_blocks_process_exit() throws Exception {
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            server.configHandler = TestSupport.fixedResponse(200, "{\"K\":\"v0\"}");
            server.eventsHandler = TestSupport.fixedResponse(500, "");
            EnvpitClient client = EnvpitClient.builder()
                    .apiKey("epk_test").host(server.baseUrl).pollInterval(Duration.ofSeconds(30))
                    .httpClient(TestSupport.testHttpClient()).logger(null).load();
            try {
                boolean anyEnvpitThread = false;
                for (Thread t : Thread.getAllStackTraces().keySet()) {
                    if (t.getName().startsWith("envpit-")) {
                        anyEnvpitThread = true;
                        assertTrue(t.isDaemon(), "thread '" + t.getName() + "' must be a daemon thread (INV-SDK-11)");
                    }
                }
                assertTrue(anyEnvpitThread, "test precondition: expected at least one envpit- background thread while the client is open");
            } finally {
                client.close();
            }
        }
    }

    // ---- INV-SDK-12 — ENVPIT_API_KEY auto-detect, explicit wins; X-Api-Key header, never Authorization

    @Test
    void test_INV_SDK_12_explicit_api_key_wins_over_env_var_when_both_are_set() throws Exception {
        // The env var can't be unset/overridden from within this JVM portably; this asserts the
        // OTHER, always-testable half of the same rule: an explicitly-passed key is what's
        // actually sent, regardless of ENVPIT_API_KEY's value in this environment.
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            AtomicReference<String> seenApiKeyHeader = new AtomicReference<>();
            server.configHandler = ex -> {
                seenApiKeyHeader.set(ex.getRequestHeaders().getFirst("X-Api-Key"));
                TestSupport.respond(ex, 200, "{}", null);
                return null;
            };
            EnvpitClient client = EnvpitClient.builder()
                    .apiKey("epk_explicit_wins").host(server.baseUrl).pollInterval(Duration.ZERO)
                    .httpClient(TestSupport.testHttpClient()).logger(null).load();
            client.close();
            assertEquals("epk_explicit_wins", seenApiKeyHeader.get());
        }
    }

    @Test
    void test_INV_SDK_12_no_api_key_anywhere_raises_authentication_exception() {
        String old = System.getenv("ENVPIT_API_KEY");
        assertTrue(old == null || old.isBlank(),
                "this test requires ENVPIT_API_KEY unset in the test environment; found: " + old);
        assertThrows(AuthenticationException.class, () -> EnvpitClient.builder().load());
    }

    @Test
    void test_INV_SDK_12_config_fetch_sends_x_api_key_header_and_never_authorization() throws Exception {
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            AtomicReference<String> xApiKey = new AtomicReference<>();
            AtomicReference<String> authorization = new AtomicReference<>();
            server.configHandler = ex -> {
                xApiKey.set(ex.getRequestHeaders().getFirst("X-Api-Key"));
                authorization.set(ex.getRequestHeaders().getFirst("Authorization"));
                TestSupport.respond(ex, 200, "{}", null);
                return null;
            };
            EnvpitClient client = EnvpitClient.builder()
                    .apiKey("epk_test").host(server.baseUrl).pollInterval(Duration.ZERO)
                    .httpClient(TestSupport.testHttpClient()).logger(null).load();
            client.close();
            assertEquals("epk_test", xApiKey.get());
            assertNull(authorization.get(), "must never send an Authorization header (ADR-M5-03)");
        }
    }
}
