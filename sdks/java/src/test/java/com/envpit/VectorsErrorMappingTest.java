package com.envpit;

import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

import java.net.ServerSocket;
import java.net.Socket;
import java.net.http.HttpClient;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.fail;

/**
 * Consumes test-vectors/error-mapping.json — including the bd:envpit-4dbm-class
 * "connection-reset-mid-request-with-zero-response-bytes" row, which THIS vector file's own
 * {@code notes} field calls out as the row Java's own implementation brief must carry forward.
 * {@link ConnectionResetTest} additionally proves this empirically against a real TCP socket
 * (this file also does, for that one row — see {@link #connectionReset}).
 */
class VectorsErrorMappingTest {

    @TestFactory
    List<DynamicTest> vectors() {
        Map<String, Object> doc = TestSupport.loadVectorFile("error-mapping.json");
        return TestSupport.cases(doc).stream().map(c -> DynamicTest.dynamicTest((String) c.get("name"), () -> runCase(c)))
                .collect(Collectors.toList());
    }

    @SuppressWarnings("unchecked")
    private void runCase(Map<String, Object> c) throws Exception {
        String name = (String) c.get("name");
        Map<String, Object> condition = (Map<String, Object>) c.get("condition");
        String expected = (String) c.get("expectedError");

        if (condition.containsKey("status")) {
            int status = ((Double) condition.get("status")).intValue();
            httpStatus(name, status, expected);
            return;
        }

        String failure = (String) condition.get("transportFailure");
        switch (failure) {
            case "timeout" -> timeout(name, expected);
            case "connection-refused" -> connectionRefused(name, expected);
            case "invalid-json-body" -> invalidJsonBody(name, expected);
            case "connection-reset" -> connectionReset(name, expected);
            default -> fail("unhandled transportFailure " + failure);
        }
    }

    private void httpStatus(String name, int status, String expected) {
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            server.configHandler = TestSupport.fixedResponse(status, "{}");
            EnvpitException ex = fetchAndExpectError(server.baseUrl, TestSupport.testHttpClient());
            assertErrorType(name, expected, ex);
        }
    }

    private void invalidJsonBody(String name, String expected) {
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            server.configHandler = TestSupport.fixedResponse(200, "{not valid json!!");
            EnvpitException ex = fetchAndExpectError(server.baseUrl, TestSupport.testHttpClient());
            assertErrorType(name, expected, ex);
        }
    }

    private void timeout(String name, String expected) {
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            server.configHandler = TestSupport.hangForever();
            HttpClient shortTimeoutClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
            EnvpitException ex = assertThrows(EnvpitException.class,
                    () -> Transport.fetchConfig(shortTimeoutClient, server.baseUrl, "epk_test", Duration.ofMillis(300)), name);
            assertErrorType(name, expected, ex);
        }
    }

    private void connectionRefused(String name, String expected) throws Exception {
        // Bind and immediately close a local port — guarantees ECONNREFUSED on connect (nobody's
        // listening there), a genuinely empirical pre-connect failure, not a synthetic one.
        int port;
        try (ServerSocket probe = new ServerSocket(0)) {
            port = probe.getLocalPort();
        }
        EnvpitException ex = fetchAndExpectError("http://127.0.0.1:" + port, TestSupport.testHttpClient());
        assertErrorType(name, expected, ex);
    }

    /** bd:envpit-4dbm class — a server that accepts the connection, reads nothing, then closes with zero response bytes. */
    private void connectionReset(String name, String expected) throws Exception {
        try (ServerSocket serverSocket = new ServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress())) {
            CountDownLatch accepted = new CountDownLatch(1);
            Thread acceptor = new Thread(() -> {
                try (Socket s = serverSocket.accept()) {
                    accepted.countDown();
                    // read nothing, write nothing — just close, forcing a mid-request reset/EOF
                } catch (Exception ignored) {
                }
            }, "test-reset-listener");
            acceptor.setDaemon(true);
            acceptor.start();

            String url = "http://127.0.0.1:" + serverSocket.getLocalPort();
            EnvpitException ex = fetchAndExpectError(url, TestSupport.testHttpClient());
            assertErrorType(name, expected, ex);
            assertInstanceOf(NetworkException.class, ex, name + ": a mid-connection reset must map to NetworkException, never escape raw");
        }
    }

    private EnvpitException fetchAndExpectError(String host, HttpClient client) {
        return assertThrows(EnvpitException.class,
                () -> Transport.fetchConfig(client, host, "epk_test", Duration.ofSeconds(3)));
    }

    private void assertErrorType(String name, String expected, EnvpitException ex) {
        String actual = ex.getClass().getSimpleName().replace("Exception", "Error");
        assertEquals(expected, actual, name + ": " + ex.getMessage());
    }
}
