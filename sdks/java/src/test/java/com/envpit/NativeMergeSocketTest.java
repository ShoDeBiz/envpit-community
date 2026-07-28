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
 *   <li>{@link EnvpitClient#knownSecretKeys()} — the "prepared socket" Oliver asked for
 *       (2026-07-28 correction on bd:envpit-yvyr) once the wire protocol adds per-key secret
 *       metadata. ALWAYS empty today: {@code GET /api/v1/config} ({@link Transport}) returns a
 *       flat {@code key -> value} map with no {@code is_secret} field at all — independently
 *       verified against {@code apps/api/src/config-management/config-resolve.controller.ts}'s
 *       documented response schema ({@code additionalProperties: {type: 'string', nullable:
 *       true}}) and {@code ConfigService.resolveEnvironmentSecretsInternal}'s {@code
 *       Record<string, string | null>} return type in the main {@code envpit} repo — the exact
 *       same evidence chain Python's {@code client.py:_known_secret_keys()} and Node's {@code
 *       process-env-merge.ts} independently cite. NOT a placeholder for a key-name heuristic
 *       (e.g. matching {@code SECRET}/{@code PASSWORD}/{@code TOKEN}) — a heuristic is wrong in
 *       both directions: {@code DATABASE_URL} commonly embeds a password and would slip straight
 *       past any such pattern. The day the wire protocol ships {@code secretKeys}, only this
 *       method's body changes; every caller in {@code envpit-spring-boot-starter} already folds
 *       its result into the excluded-keys set unconditionally (mirrors Python's
 *       {@code populate_environ}/{@code integrations/flask.py}/{@code integrations/django.py}
 *       call sites).</li>
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
    void knownSecretKeysIsAlwaysEmptyTodayProtocolGap() {
        EnvpitClient client = TestSupport.newLoadedClient(server, TestSupport.toJson(Map.of("DB_PASSWORD", "hunter2")));
        try {
            Set<String> secretKeys = client.knownSecretKeys();
            assertTrue(secretKeys.isEmpty(), "no per-key is_secret signal exists on the wire yet");
        } finally {
            client.close();
        }
    }
}
