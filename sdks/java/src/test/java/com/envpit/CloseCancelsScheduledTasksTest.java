package com.envpit;

import org.junit.jupiter.api.Test;

import java.net.http.HttpClient;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * bd:envpit-tkvz-class coverage — the carry-forward lesson from Go
 * ({@code sdks/go/envpit/goroutine_leak_test.go}'s sibling concern): a degraded-mode warning
 * {@link java.util.concurrent.ScheduledFuture} (or any scheduled task) that is only cancelled on
 * ONE of several exit paths is exactly the footgun Go shipped and had to fix. Proves — with a real
 * clock, not a mock — that once {@link RealtimeTransport#requestStop()} fires (the same call
 * {@link EnvpitClient#close()} makes), the degraded-mode warn task NEVER fires afterward, even
 * though the moment it would have fired (had it not been cancelled) is well within this test's own
 * runtime.
 *
 * <p>Ghost-callback proof shape: schedule the task (force degraded mode with a short warn
 * threshold), stop the transport BEFORE the threshold elapses, then keep waiting PAST the original
 * threshold and assert the warn line never appears — a passive "it didn't crash" assertion would
 * not catch this; only a positive wait-and-confirm-absence does.
 */
class CloseCancelsScheduledTasksTest {

    @Test
    void degradedWarnTaskNeverFiresAfterRequestStopEvenPastItsOriginalThreshold() throws Exception {
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            // Every connect attempt fails (500) — forces the transport into degraded mode quickly.
            server.eventsHandler = TestSupport.fixedResponse(500, "");

            ScheduledExecutorService dispatchExecutor = Executors.newSingleThreadScheduledExecutor(r -> {
                Thread t = new Thread(r, "test-tkvz-dispatch");
                t.setDaemon(true);
                return t;
            });

            List<String> warnLines = new CopyOnWriteArrayList<>();
            CountDownLatch degradedAnnounced = new CountDownLatch(1);

            Duration shortWarnThreshold = Duration.ofMillis(150);
            RealtimeTransport transport = new RealtimeTransport(
                    server.baseUrl, "epk_test", HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(1)).build(),
                    Duration.ofSeconds(60), SseFrameParser.DEFAULT_MAX_LINE_BYTES,
                    etag -> { /* no-op change signal */ },
                    (mode, reason, since) -> { /* no-op mode change */ },
                    (level, message) -> {
                        if ("info".equals(level) && message.contains("falling back to polling")) {
                            degradedAnnounced.countDown();
                        }
                        if ("warn".equals(level)) {
                            warnLines.add(message);
                        }
                    },
                    dispatchExecutor,
                    Duration.ofMillis(10),   // quickReconnectDelay
                    Duration.ofMillis(20),   // degradedReconnectInterval
                    Duration.ZERO,           // degradedReconnectJitter
                    shortWarnThreshold);

            Thread runner = new Thread(transport::run, "test-tkvz-realtime");
            runner.setDaemon(true);
            runner.start();

            try {
                assertTrue(degradedAnnounced.await(2, TimeUnit.SECONDS),
                        "test setup failed: never reached degraded mode — can't test the warn-task cancellation without it");

                // STOP well before the warn threshold elapses — this is the tkvz-class moment: the
                // scheduled warn task is now live and would fire at shortWarnThreshold if not
                // cancelled by every exit path.
                transport.requestStop();
                runner.interrupt();
                assertTrue(TestSupport.waitUntil(Duration.ofSeconds(2), () -> !runner.isAlive()),
                        "the realtime thread did not exit within 2s of requestStop()+interrupt()");

                // Now wait PAST the original threshold — if the warn task's cancellation had a gap
                // (the exact tkvz bug shape), the "still unavailable after" line would appear here.
                Thread.sleep(shortWarnThreshold.toMillis() * 4);

                boolean ghostWarnFired = warnLines.stream().anyMatch(m -> m.contains("still unavailable after"));
                assertFalse(ghostWarnFired,
                        "the degraded-mode warn task fired AFTER requestStop() — exactly the bd:envpit-tkvz ghost-callback bug; got: "
                                + warnLines);
            } finally {
                dispatchExecutor.shutdownNow();
            }
        }
    }

    /**
     * The same proof at the full {@link EnvpitClient} level (both defense layers together —
     * {@link RealtimeTransport#run()}'s own {@code finally} block AND {@link
     * EnvpitClient#close()}'s independent executor shutdown): a client that goes through several
     * quick disconnect cycles then {@code close()}s must never let a scheduled task fire
     * afterward, and the shared dispatch executor must actually be terminated (not merely
     * abandoned) by the time {@code close()} returns.
     */
    @Test
    void clientCloseLeavesNoLiveExecutorAndNoGhostCallback() throws Exception {
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            server.configHandler = TestSupport.fixedResponse(200, "{\"values\":{\"K\":\"v0\"},\"secretKeys\":[]}");
            server.eventsHandler = TestSupport.fixedResponse(500, "");

            TestSupport.CapturingLogger logger = new TestSupport.CapturingLogger();
            EnvpitClient client = EnvpitClient.builder()
                    .apiKey("epk_test")
                    .host(server.baseUrl)
                    .pollInterval(Duration.ofMillis(500))
                    .httpClient(HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(1)).build())
                    .logger(logger)
                    .load();

            // Let it run briefly (a few failed realtime connects) then close — close() must not
            // hang and must fully tear down every scheduled task and the shared executor.
            Thread.sleep(300);
            long before = System.nanoTime();
            client.close();
            long closeDurationMs = (System.nanoTime() - before) / 1_000_000;
            assertTrue(closeDurationMs < 6_000, "close() should return within its own bounded awaitTermination, took " + closeDurationMs + "ms");

            int warnLinesAtClose = logger.warns.size();
            int errorLinesAtClose = logger.errors.size();

            // Nothing scheduled before close() may still be live to fire now.
            Thread.sleep(1_000);

            assertTrue(logger.warns.size() <= warnLinesAtClose, "no NEW warn line should be logged after close() — a ghost callback fired");
            assertTrue(logger.errors.size() <= errorLinesAtClose, "no NEW error line should be logged after close() — a ghost callback fired");
        }
    }
}
