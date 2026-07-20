package com.envpit;

import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

/**
 * Consumes test-vectors/error-messages.json's {@code java} column — Uma's AC-UX3-03 copy-parity
 * requirement made CI-enforced. Per the file's own {@code languages} restriction, the
 * {@code go-or-family-type-mismatch-value-free} case is Go-only and skipped here.
 */
class VectorsErrorMessagesTest {

    @TestFactory
    List<DynamicTest> vectors() {
        Map<String, Object> doc = TestSupport.loadVectorFile("error-messages.json");
        return TestSupport.cases(doc).stream().map(c -> DynamicTest.dynamicTest((String) c.get("name"), () -> runCase(c)))
                .collect(Collectors.toList());
    }

    @SuppressWarnings("unchecked")
    private void runCase(Map<String, Object> c) {
        String name = (String) c.get("name");

        List<String> languages = (List<String>) (List<?>) c.get("languages");
        if (languages != null && !languages.contains("java")) {
            return; // restricted to other languages (e.g. the Go-only Or-family case)
        }

        Map<String, Object> messages = (Map<String, Object>) c.get("messages");
        Map<String, Object> javaEntry = (Map<String, Object>) messages.get("java");
        if (javaEntry == null) {
            fail(name + ": no java entry in messages");
        }
        String wantMessageTemplate = (String) javaEntry.get("message");
        boolean valueFreeCarveOut = Boolean.TRUE.equals(c.get("valueFreeCarveOut"));

        // real-local-server substitution (see class doc comment): every vector's expected message
        // is authored against the literal placeholder host `https://example.test` (there is no
        // fake-transport seam in java.net.http.HttpClient to inject that literal string directly —
        // TestSupport.TestServer is a REAL local HttpServer bound to an ephemeral 127.0.0.1 port,
        // so the vector's placeholder must be substituted with THIS run's actual base URL before
        // comparison, every time a case's expected message embeds the config-fetch URL).
        Result result = switch (name) {
            case "no-api-key-found" -> Result.hostless(noApiKeyFound());
            case "api-key-rejected-401" -> apiKeyRejected401();
            case "could-not-reach-server-timeout" -> couldNotReachServerTimeout();
            case "non-2xx-response" -> non2xxResponse();
            case "invalid-json-response" -> invalidJsonResponse();
            case "missing-key" -> Result.hostless(missingKey(c));
            case "type-mismatch-integer" -> Result.hostless(typeMismatchInteger(c, valueFreeCarveOut));
            case "background-refresh-failed-http-500" -> backgroundRefreshFailedHttp500();
            default -> {
                fail(name + ": unhandled case — a case was added to error-messages.json that this test doesn't drive yet");
                yield null;
            }
        };

        String wantMessage = result.host() != null
                ? wantMessageTemplate.replace("https://example.test", result.host())
                : wantMessageTemplate;

        assertEquals(wantMessage, result.message(), name);
        if (!valueFreeCarveOut) {
            assertNoConfigValueLeak(name, result.message());
        }
    }

    /**
     * A produced message paired with the real local server base URL (e.g. {@code
     * http://127.0.0.1:54321}) that was substituted for the vector's {@code https://example.test}
     * placeholder host, or {@code null} when the case never talks to a server (no host to
     * substitute — the expected template is compared verbatim).
     */
    private record Result(String message, String host) {
        static Result hostless(String message) {
            return new Result(message, null);
        }
    }

    private String noApiKeyFound() {
        String old = System.getenv("ENVPIT_API_KEY");
        // Cannot unset a real env var from within the JVM portably; instead call the builder with
        // an explicit empty apiKey AND rely on this test JVM not having ENVPIT_API_KEY set (CI/dev
        // convention for this suite — asserted defensively below rather than silently assumed).
        assertTrue(old == null || old.isBlank(),
                "this test requires ENVPIT_API_KEY to be unset in the test environment; found: " + old);
        try {
            EnvpitClient.builder().load();
            fail("expected an AuthenticationException");
            return null;
        } catch (AuthenticationException e) {
            return e.getMessage();
        }
    }

    private Result apiKeyRejected401() {
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            server.configHandler = TestSupport.fixedResponse(401, "{}");
            try {
                Transport.fetchConfig(TestSupport.testHttpClient(), server.baseUrl, "epk_test", Duration.ofSeconds(2));
                fail("expected an exception");
                return null;
            } catch (EnvpitException e) {
                return new Result(e.getMessage(), server.baseUrl);
            }
        }
    }

    private Result couldNotReachServerTimeout() {
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            server.configHandler = TestSupport.hangForever();
            try {
                Transport.fetchConfig(TestSupport.testHttpClient(), server.baseUrl, "epk_test", Duration.ofMillis(300));
                fail("expected an exception");
                return null;
            } catch (EnvpitException e) {
                return new Result(e.getMessage(), server.baseUrl);
            }
        }
    }

    private Result non2xxResponse() {
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            server.configHandler = TestSupport.fixedResponse(500, "{}");
            try {
                Transport.fetchConfig(TestSupport.testHttpClient(), server.baseUrl, "epk_test", Duration.ofSeconds(2));
                fail("expected an exception");
                return null;
            } catch (EnvpitException e) {
                return new Result(e.getMessage(), server.baseUrl);
            }
        }
    }

    private Result invalidJsonResponse() {
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            server.configHandler = TestSupport.fixedResponse(200, "{not valid json!!");
            try {
                Transport.fetchConfig(TestSupport.testHttpClient(), server.baseUrl, "epk_test", Duration.ofSeconds(2));
                fail("expected an exception");
                return null;
            } catch (EnvpitException e) {
                return new Result(e.getMessage(), server.baseUrl);
            }
        }
    }

    @SuppressWarnings("unchecked")
    private String missingKey(Map<String, Object> c) {
        Map<String, Object> getter = (Map<String, Object>) c.get("getter");
        Map<String, String> snapshot = TestSupport.asStringMap(getter.get("snapshot"));
        String key = (String) getter.get("key");
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            EnvpitClient client = TestSupport.newLoadedClient(server, TestSupport.toJson(snapshot));
            try {
                client.get(key);
                fail("expected MissingKeyException");
                return null;
            } catch (MissingKeyException e) {
                return e.getMessage();
            } finally {
                client.close();
            }
        }
    }

    @SuppressWarnings("unchecked")
    private String typeMismatchInteger(Map<String, Object> c, boolean valueFreeCarveOut) {
        Map<String, Object> getter = (Map<String, Object>) c.get("getter");
        Map<String, String> snapshot = TestSupport.asStringMap(getter.get("snapshot"));
        String key = (String) getter.get("key");
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            EnvpitClient client = TestSupport.newLoadedClient(server, TestSupport.toJson(snapshot));
            try {
                client.getInt(key);
                fail("expected TypeMismatchException");
                return null;
            } catch (TypeMismatchException e) {
                assertTrue(valueFreeCarveOut, "type-mismatch-integer must be the documented value-echo carve-out");
                assertTrue(e.getMessage().contains("abc"), "carve-out case must echo the raw value, got: " + e.getMessage());
                return e.getMessage();
            } finally {
                client.close();
            }
        }
    }

    private Result backgroundRefreshFailedHttp500() {
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            TestSupport.CapturingLogger logger = new TestSupport.CapturingLogger();
            server.configHandler = TestSupport.fixedResponse(200, "{\"K\":\"v0\"}");
            EnvpitClient client = EnvpitClient.builder()
                    .apiKey("epk_test").host(server.baseUrl).pollInterval(Duration.ZERO)
                    .httpClient(TestSupport.testHttpClient()).logger(logger).load();
            try {
                server.configHandler = TestSupport.fixedResponse(500, "{}");
                client.doRefresh(ChangeTrigger.POLL);
                return new Result(logger.lastWarn(), server.baseUrl);
            } finally {
                client.close();
            }
        }
    }

    private void assertNoConfigValueLeak(String name, String message) {
        for (String forbidden : List.of("epk_test", "v0")) {
            assertFalse(message.contains(forbidden), name + ": message unexpectedly contains fixture value '" + forbidden + "': " + message);
        }
    }
}
