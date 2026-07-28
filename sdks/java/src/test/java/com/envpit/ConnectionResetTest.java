package com.envpit;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.http.HttpClient;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

/**
 * bd:envpit-4dbm-class coverage — the carry-forward lesson from Python (originally re-carried
 * through Go, {@code sdks/go/envpit/connection_reset_test.go}): a mid-connection TCP reset/
 * disconnect (a rolling-deploy pod killed mid-request, an LB idle-timeout race, a NAT/firewall
 * RST — a server that accepted the connection, read the request, then closed with ZERO response
 * bytes) must be caught and mapped into this SDK's typed error taxonomy — never let it escape as
 * a raw, unwrapped {@code IOException}/{@code SocketException} — on BOTH the initial-load path
 * AND the background-refresh path, where specifically the {@code onError} listener must actually
 * fire (Python's original bug: this silently did NOT happen on the refresh path even after being
 * partially fixed on the load path).
 *
 * <p>{@code VectorsErrorMappingTest}'s vector-driven cases already prove {@link
 * Transport#isConnectionReset} against the vector suite's synthetic shapes; this file additionally
 * proves it EMPIRICALLY against a real raw TCP socket (same "verified empirically, not assumed"
 * methodology as Python's and Go's fixes) and proves the client-level consequences a pure unit
 * vector can't exercise.
 */
class ConnectionResetTest {

    /**
     * Opens a real TCP listener that accepts exactly the connections thrown at it and closes each
     * one immediately after accepting — zero response bytes, no HTTP framing at all. Runs its
     * accept loop on a daemon thread so a stray leftover doesn't hang the test JVM.
     */
    private static String startResetListener() throws IOException {
        ServerSocket serverSocket = new ServerSocket(0, 50, java.net.InetAddress.getByName("127.0.0.1"));
        Thread acceptLoop = new Thread(() -> {
            while (!serverSocket.isClosed()) {
                try {
                    Socket s = serverSocket.accept();
                    s.close(); // zero response bytes — the bd:envpit-4dbm shape
                } catch (IOException e) {
                    return; // listener closed — exit quietly
                }
            }
        }, "test-reset-listener");
        acceptLoop.setDaemon(true);
        acceptLoop.start();
        return "http://127.0.0.1:" + serverSocket.getLocalPort();
    }

    @Test
    void initialLoadAgainstAResetConnectionThrowsNetworkExceptionNotRaw() throws IOException {
        String resetHost = startResetListener();
        try {
            EnvpitClient.builder()
                    .apiKey("epk_test")
                    .host(resetHost)
                    .pollInterval(Duration.ZERO)
                    .timeout(Duration.ofSeconds(2))
                    .logger(null)
                    .load();
            fail("expected a NetworkException");
        } catch (NetworkException e) {
            // exactly the "except EnvpitError catch-all must actually catch it" contract —
            // NetworkException IS-A EnvpitException, verified structurally, not just by name.
            assertInstanceOf(EnvpitException.class, e);
            assertNotNull(e.getMessage());
            assertFalse(e.getMessage().contains("epk_test"), "message must never echo the API key");
        }
    }

    @Test
    void backgroundRefreshAgainstAResetConnectionRecordsNetworkExceptionNotRaw() throws IOException {
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            EnvpitClient client = TestSupport.newLoadedClient(server, "{\"values\":{\"K\":\"v0\"},\"secretKeys\":[]}");
            try {
                String resetHost = startResetListener();
                client.host = resetHost;
                client.httpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();

                client.doRefresh(ChangeTrigger.POLL); // hits the reset

                // Stale-while-revalidate (INV-SDK-4): the failure never propagates to a get() caller.
                assertEquals("v0", client.get("K"));

                EnvpitException lastError = client.cacheInfo().lastError();
                assertNotNull(lastError, "expected cacheInfo().lastError() to be set");
                assertInstanceOf(NetworkException.class, lastError,
                        "cacheInfo().lastError() must be a NetworkException, not a raw transport exception");
            } finally {
                client.close();
            }
        }
    }

    /**
     * The specific regression this carry-forward lesson calls out: Python's original bug was that
     * the error callback silently did NOT fire on the refresh path even after being partially
     * fixed on the initial-load path. Prove it fires here, in Java, from day one.
     */
    @Test
    void onErrorListenerFiresOnBackgroundRefreshReset() throws IOException, InterruptedException {
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            EnvpitClient client = TestSupport.newLoadedClient(server, "{\"values\":{\"K\":\"v0\"},\"secretKeys\":[]}");
            try {
                CountDownLatch latch = new CountDownLatch(1);
                AtomicReference<EnvpitException> captured = new AtomicReference<>();
                client.onError(err -> {
                    captured.set(err);
                    latch.countDown();
                });

                String resetHost = startResetListener();
                client.host = resetHost;
                client.httpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();

                client.doRefresh(ChangeTrigger.POLL); // hits the reset; doRefresh dispatches synchronously
                // on whatever thread calls it in this direct-call test, so the listener has already
                // run by the time doRefresh returns — the latch is a belt-and-braces wait, not a race.

                assertTrue(latch.await(2, TimeUnit.SECONDS),
                        "onError never fired for a mid-connection reset on the background-refresh path — "
                                + "this is exactly the Python bug this SDK must not rediscover");
                assertInstanceOf(NetworkException.class, captured.get());
            } finally {
                client.close();
            }
        }
    }

    @Test
    void selfHealsOnceTheConnectionStopsResetting() throws IOException {
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            EnvpitClient client = TestSupport.newLoadedClient(server, "{\"values\":{\"K\":\"v0\"},\"secretKeys\":[]}");
            try {
                String resetHost = startResetListener();
                client.host = resetHost;
                client.httpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
                client.doRefresh(ChangeTrigger.POLL);
                assertNotNull(client.cacheInfo().lastError(), "expected the reset to be recorded as a failure first");

                // Swap back to the healthy real server for recovery.
                server.configHandler = TestSupport.fixedResponse(200, "{\"values\":{\"K\":\"v_recovered\"},\"secretKeys\":[]}");
                client.host = server.baseUrl;
                client.httpClient = TestSupport.testHttpClient();
                client.doRefresh(ChangeTrigger.POLL);

                assertEquals("v_recovered", client.get("K"));
                assertNull(client.cacheInfo().lastError(), "expected lastError to clear after a successful refresh");
            } finally {
                client.close();
            }
        }
    }
}
