package com.envpit;

import org.junit.jupiter.api.Test;

import java.time.Duration;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * AC-SEC-SDK3-1 (THREATMODEL-envpit-0t2z-3.md F1): every type that transitively holds the API key
 * or the config snapshot MUST implement an explicit redacting {@code toString()} — a careless
 * {@code System.out.println(client)} / error-reporter object dump / debugger watch expression must
 * never leak a secret. Shipped Node does NOT redact ({@code util.inspect} prints every field) —
 * this SDK deliberately does not repeat that gap (Sentinel's F1 finding).
 *
 * <p>Adversarial per the threat model's own framing: the injected API key and config values below
 * are deliberately distinctive, high-entropy strings unlikely to appear by accident in any other
 * part of a formatted object (host, class name, field labels), so a false "pass" from a
 * coincidental substring match is not possible.
 */
class ToStringRedactionTest {

    private static final String ADVERSARIAL_API_KEY = "epk_REDACT_ME_9f3e7c1a2b6d";
    private static final String ADVERSARIAL_SECRET_VALUE = "SEKRIT_CONFIG_VALUE_4b8f21";

    @Test
    void clientToStringNeverContainsTheApiKeyOrAnyConfigValue() throws Exception {
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            server.configHandler = TestSupport.fixedResponse(200,
                    "{\"DATABASE_URL\":\"" + ADVERSARIAL_SECRET_VALUE + "\",\"PORT\":\"8080\"}");
            EnvpitClient client = EnvpitClient.builder()
                    .apiKey(ADVERSARIAL_API_KEY)
                    .host(server.baseUrl)
                    .pollInterval(Duration.ZERO)
                    .httpClient(TestSupport.testHttpClient())
                    .logger(null)
                    .load();
            try {
                String printed = client.toString();

                assertFalse(printed.contains(ADVERSARIAL_API_KEY), "toString() leaked the API key: " + printed);
                assertFalse(printed.contains(ADVERSARIAL_SECRET_VALUE), "toString() leaked a config value: " + printed);
                assertTrue(printed.contains("<redacted>"), "toString() should explicitly say the API key is redacted: " + printed);
                assertTrue(printed.contains("keys=2"), "toString() should still report the (safe) key COUNT: " + printed);
            } finally {
                client.close();
            }
        }
    }

    @Test
    void realtimeTransportToStringNeverContainsTheApiKey() throws Exception {
        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            server.configHandler = TestSupport.fixedResponse(200, "{\"K\":\"v0\"}");
            // pollInterval > 0 so a RealtimeTransport instance is actually constructed.
            server.eventsHandler = TestSupport.fixedResponse(500, "");
            EnvpitClient client = EnvpitClient.builder()
                    .apiKey(ADVERSARIAL_API_KEY)
                    .host(server.baseUrl)
                    .pollInterval(Duration.ofMinutes(10))
                    .httpClient(TestSupport.testHttpClient())
                    .logger(null)
                    .load();
            try {
                String printed = client.realtimeTransport.toString();
                assertFalse(printed.contains(ADVERSARIAL_API_KEY), "RealtimeTransport.toString() leaked the API key: " + printed);
                assertTrue(printed.contains("<redacted>"), "RealtimeTransport.toString() should say the API key is redacted: " + printed);
            } finally {
                client.close();
            }
        }
    }

    @Test
    void configSnapshotToStringNeverContainsValuesEvenDirectly() {
        ConfigSnapshot snapshot = new ConfigSnapshot(java.util.Map.of("K", ADVERSARIAL_SECRET_VALUE));
        String printed = snapshot.toString();
        assertFalse(printed.contains(ADVERSARIAL_SECRET_VALUE), "ConfigSnapshot.toString() leaked a value: " + printed);
        assertTrue(printed.contains("<redacted>"));
    }

    @Test
    void builderDefaultObjectToStringDoesNotLeakTheApiKeyEitherEvenBeforeLoad() {
        // AC-SEC-SDK3-1 covers "options/builder" too. Builder has no toString() override, which is
        // SAFE here only because Object's default toString() (ClassName@hashCode) never enumerates
        // fields — verified by evidence, not assumed, per Sentinel's F1 "Java — safe default"
        // ranking (unlike Go's fmt.Printf("%+v", ...), which WOULD print unexported struct fields
        // via reflection).
        EnvpitClient.Builder builder = EnvpitClient.builder().apiKey(ADVERSARIAL_API_KEY);
        String printed = builder.toString();
        assertFalse(printed.contains(ADVERSARIAL_API_KEY), "Builder's default toString() leaked the API key: " + printed);
    }
}
