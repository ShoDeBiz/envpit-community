package com.envpit;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * bd:envpit-yvyr (Java core leg) — the two pieces {@code envpit-spring-boot-starter} (a
 * SEPARATE Maven module, own package {@code com.envpit.spring}) needs from this core module to
 * build a Spring {@code PropertySource} at all:
 *
 * <ol>
 *   <li>{@link EnvpitClient#snapshot()} — a public, defensive-copy view of every key -&gt; value
 *       pair currently held. Nothing like this existed before this bd: {@link ConfigSnapshot}
 *       (this package's internal wrapper) is package-private BY DESIGN (its own doc comment:
 *       "never exposes its backing map") and {@link EnvpitClient#state} is package-private too —
 *       neither is reachable from {@code com.envpit.spring}. This IS the Java equivalent of
 *       Python's {@code EnvpitClient.snapshot()} (client.py, same bd), added for the identical
 *       reason.</li>
 *   <li>{@link EnvpitClient#knownSecretKeys()} — bd:envpit-durd closed the protocol gap this
 *       method used to be a placeholder for: {@code GET /api/v1/config} ({@link Transport}) now
 *       returns an envelope, {@code {values, secretKeys}} (test-vectors/resolve-body.json), and
 *       this method returns the real, server-reported {@code secretKeys} set from the last fetch
 *       — independently verified against {@code
 *       apps/api/src/config-management/config-resolve.controller.ts}'s current {@code
 *       @ApiResponse} schema in the main {@code envpit} repo. Same wire contract Python's {@code
 *       client.py:_known_secret_keys()} and Node's {@code process-env-merge.ts} read. NOT a
 *       key-name heuristic (e.g. matching {@code SECRET}/{@code PASSWORD}/{@code TOKEN}) — this is
 *       the real, server-reported flag. Every caller in {@code envpit-spring-boot-starter} already
 *       folds its result into the excluded-keys set (unless a deployment opts in via
 *       {@code envpit.include-secrets}), mirroring Python's {@code populate_environ}/{@code
 *       integrations/flask.py}/{@code integrations/django.py} call sites.</li>
 * </ol>
 */
class NativeMergeSocketTest {

    private static TestSupport.TestServer server;

    @BeforeAll
    static void startServer() {
        server = TestSupport.TestServer.start();
    }

    @AfterAll
    static void stopServer() {
        server.close();
    }

    @Test
    void snapshotReturnsEveryKeyIncludingNullValuedOnes() {
        Map<String, String> body = new java.util.LinkedHashMap<>();
        body.put("DATABASE_URL", "postgres://x");
        body.put("PORT", "9090");
        body.put("UNSET_KEY", null);
        EnvpitClient client = TestSupport.newLoadedClient(server, TestSupport.toJson(body));
        try {
            Map<String, String> snap = client.snapshot();
            assertEquals("postgres://x", snap.get("DATABASE_URL"));
            assertEquals("9090", snap.get("PORT"));
            assertTrue(snap.containsKey("UNSET_KEY"));
            assertEquals(null, snap.get("UNSET_KEY"));
            assertEquals(3, snap.size());
        } finally {
            client.close();
        }
    }

    @Test
    void snapshotIsADefensiveCopyMutatingItNeverAffectsTheClient() {
        EnvpitClient client = TestSupport.newLoadedClient(server, TestSupport.toJson(Map.of("A", "1")));
        try {
            Map<String, String> snap = client.snapshot();
            snap.put("A", "mutated");
            snap.put("NEW_KEY", "injected");
            assertEquals("1", client.get("A")); // client's own state untouched
        } finally {
            client.close();
        }
    }

    @Test
    void snapshotReturnsAnUnmodifiableOrFreshCopyEachCall() {
        EnvpitClient client = TestSupport.newLoadedClient(server, TestSupport.toJson(Map.of("A", "1")));
        try {
            Map<String, String> first = client.snapshot();
            Map<String, String> second = client.snapshot();
            first.put("A", "tampered-in-first-copy-only");
            assertEquals("1", second.get("A")); // second call unaffected by mutation of the first
        } finally {
            client.close();
        }
    }

    @Test
    void knownSecretKeysReturnsTheRealServerProvidedSecretKeySet() {
        Map<String, String> body = new java.util.LinkedHashMap<>();
        body.put("DB_PASSWORD", "hunter2");
        body.put("API_URL", "https://api.example.com");
        String json = TestSupport.toEnvelopeJson(body, Set.of("DB_PASSWORD"));
        EnvpitClient client = TestSupport.newLoadedClient(server, json);
        try {
            Set<String> secretKeys = client.knownSecretKeys();
            assertEquals(Set.of("DB_PASSWORD"), secretKeys);
            // knownSecretKeys() is a NAMES-only signal — the getters are unchanged and still
            // return the secret's real value by key.
            assertEquals("hunter2", client.get("DB_PASSWORD"));
        } finally {
            client.close();
        }
    }

    @Test
    void knownSecretKeysIsEmptyWhenTheEnvironmentHasNoSecrets() {
        EnvpitClient client = TestSupport.newLoadedClient(server, TestSupport.toJson(Map.of("API_URL", "https://api.example.com")));
        try {
            assertTrue(client.knownSecretKeys().isEmpty(), "no secretKeys reported by the server for this environment");
        } finally {
            client.close();
        }
    }

    @Test
    void knownSecretKeysStillListsAnUnsetSecretByName() {
        // resolve-body.json's "unset-secret-is-still-listed": the flag is key-level, not
        // value-level — a secret key with a null value in this environment still appears here.
        Map<String, String> body = new java.util.LinkedHashMap<>();
        body.put("DB_PASSWORD", null);
        String json = TestSupport.toEnvelopeJson(body, Set.of("DB_PASSWORD"));
        EnvpitClient client = TestSupport.newLoadedClient(server, json);
        try {
            assertEquals(Set.of("DB_PASSWORD"), client.knownSecretKeys());
        } finally {
            client.close();
        }
    }

    @Test
    void knownSecretKeysUpdatesAfterABackgroundRefreshChangesTheSecretSet() {
        Map<String, String> initial = new java.util.LinkedHashMap<>();
        initial.put("DB_PASSWORD", "hunter2");
        server.configHandler = TestSupport.fixedResponse(200, TestSupport.toEnvelopeJson(initial, Set.of("DB_PASSWORD")));
        EnvpitClient client = EnvpitClient.builder()
                .apiKey("epk_test").host(server.baseUrl).pollInterval(java.time.Duration.ZERO)
                .httpClient(TestSupport.testHttpClient()).logger(null).load();
        try {
            assertEquals(Set.of("DB_PASSWORD"), client.knownSecretKeys());

            Map<String, String> rotated = new java.util.LinkedHashMap<>();
            rotated.put("DB_PASSWORD", "hunter2");
            rotated.put("JWT_SECRET", "s3cr3t");
            server.configHandler = TestSupport.fixedResponse(200,
                    TestSupport.toEnvelopeJson(rotated, Set.of("DB_PASSWORD", "JWT_SECRET")));
            client.doRefresh(ChangeTrigger.POLL);

            assertEquals(Set.of("DB_PASSWORD", "JWT_SECRET"), client.knownSecretKeys());
        } finally {
            client.close();
        }
    }
}
