package com.envpit.spring;

import com.envpit.EnvpitClient;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.MutablePropertySources;
import org.springframework.core.env.StandardEnvironment;

import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * bd:envpit-yvyr (Java Spring leg). Every "end to end" test here goes through the REAL activation
 * path — {@code SpringApplicationBuilder(...).run(...)}, with {@code
 * EnvpitEnvironmentPostProcessor} discovered via {@code META-INF/spring.factories} on this
 * module's own test classpath (main resources are on the test classpath by Maven convention) —
 * not a direct call to {@code postProcessEnvironment(...)}. This is deliberate: the whole point of
 * bd:envpit-yvyr is "{@code @Value} should just work with the SDK on the classpath", so the tests
 * prove exactly that path, the same way `envpit-spring-boot-starter` real consumers will use it.
 */
class EnvpitEnvironmentPostProcessorTest {

    private ConfigurableApplicationContext context;
    private SpringTestSupport.TestServer server;

    @AfterEach
    void tearDown() {
        if (context != null) {
            context.close();
        }
        if (server != null) {
            server.close();
        }
    }

    @Configuration
    static class TestConfig {
        @Bean
        Probe probe() {
            return new Probe();
        }
    }

    static class Probe {
        @Value("${DATABASE_URL:#{null}}")
        String databaseUrl;
    }

    private ConfigurableApplicationContext boot(String... args) {
        context = new SpringApplicationBuilder(TestConfig.class)
                .web(WebApplicationType.NONE)
                .run(args);
        return context;
    }

    // ---------------------------------------------------------------------------------------
    // Core happy path — the literal bd:envpit-yvyr ask
    // ---------------------------------------------------------------------------------------

    @Test
    void atValueAnnotationResolvesFromEnvpitWithNoSpecialClientObject() {
        server = SpringTestSupport.TestServer.serving(
                SpringTestSupport.toJson(Map.of("DATABASE_URL", "postgres://from-envpit")));
        ConfigurableApplicationContext ctx = boot(
                "--envpit.api-key=epk_test", "--envpit.host=" + server.baseUrl);

        Probe probe = ctx.getBean(Probe.class);
        assertEquals("postgres://from-envpit", probe.databaseUrl);
    }

    // ---------------------------------------------------------------------------------------
    // Precedence (decision #2 — OS env / command-line win over EnvPit)
    // ---------------------------------------------------------------------------------------

    @Test
    void commandLineArgsWinOverEnvpit() {
        server = SpringTestSupport.TestServer.serving(
                SpringTestSupport.toJson(Map.of("DATABASE_URL", "postgres://from-envpit")));
        ConfigurableApplicationContext ctx = boot(
                "--envpit.api-key=epk_test", "--envpit.host=" + server.baseUrl,
                "--DATABASE_URL=postgres://from-cli");

        Probe probe = ctx.getBean(Probe.class);
        assertEquals("postgres://from-cli", probe.databaseUrl);
    }

    @Test
    void systemEnvironmentNamedPropertySourceWinsOverEnvpit() {
        // Unit-level (not a real SpringApplication boot): StandardEnvironment already carries a
        // REAL "systemEnvironment" source built from actual OS env vars, which this test process
        // cannot safely mutate — replacing it with a controlled fake proves the precedence
        // decision (envpit added via addAfter(SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME, ...)
        // structurally cannot outrank whatever occupies that exact source name) without needing
        // real env var mutation.
        ConfigurableEnvironment env = new StandardEnvironment();
        MutablePropertySources sources = env.getPropertySources();
        sources.replace(StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME,
                new MapPropertySource(StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME,
                        Map.of("DATABASE_URL", "postgres://from-os-env", "envpit.api-key", "epk_test")));

        server = SpringTestSupport.TestServer.serving(
                SpringTestSupport.toJson(Map.of("DATABASE_URL", "postgres://from-envpit")));
        sources.addLast(new MapPropertySource("test-host-override", Map.of("envpit.host", server.baseUrl)));

        new EnvpitEnvironmentPostProcessor().postProcessEnvironment(env, null);

        assertEquals("postgres://from-os-env", env.getProperty("DATABASE_URL"));
    }

    @Test
    void envpitWinsOverApplicationPropertiesPackagedFile() {
        // src/test/resources/application.properties (on this module's own test classpath) sets
        // DATABASE_URL=from-packaged-file — a real ConfigData-loaded file, not a stand-in.
        server = SpringTestSupport.TestServer.serving(
                SpringTestSupport.toJson(Map.of("DATABASE_URL", "postgres://from-envpit")));
        ConfigurableApplicationContext ctx = boot(
                "--envpit.api-key=epk_test", "--envpit.host=" + server.baseUrl);

        Probe probe = ctx.getBean(Probe.class);
        assertEquals("postgres://from-envpit", probe.databaseUrl);
    }

    // ---------------------------------------------------------------------------------------
    // Opt-in / opt-out posture
    // ---------------------------------------------------------------------------------------

    @Test
    void envpitEnabledFalseNeverAddsThePropertySource() {
        server = SpringTestSupport.TestServer.serving(
                SpringTestSupport.toJson(Map.of("DATABASE_URL", "postgres://from-envpit")));
        ConfigurableApplicationContext ctx = boot(
                "--envpit.api-key=epk_test", "--envpit.host=" + server.baseUrl, "--envpit.enabled=false");

        // src/test/resources/application.properties (a real, always-on-classpath file for every
        // test in this class) sets DATABASE_URL=postgres://from-packaged-file — resolving to THAT
        // value (never "postgres://from-envpit") proves the EnvPit PropertySource was never added
        // at all, a stronger assertion than merely checking for null.
        Probe probe = ctx.getBean(Probe.class);
        assertEquals("postgres://from-packaged-file", probe.databaseUrl);
    }

    @Test
    void noApiKeyConfiguredAnywhereIsASilentNoOpNotABootFailure() {
        ConfigurableApplicationContext ctx = boot(); // no envpit.api-key property, no server needed
        Probe probe = ctx.getBean(Probe.class);
        // Same reasoning as envpitEnabledFalseNeverAddsThePropertySource above: falls through to
        // the packaged application.properties file, proving no EnvPit source was added (boot
        // still succeeded — this is the "silent no-op" this test's name asserts).
        assertEquals("postgres://from-packaged-file", probe.databaseUrl);
    }

    @Test
    void aConfiguredButUnreachableApiKeyFailsBootFast() {
        // Matches the core SDK's own documented convention (README.md: "a bad key fails the boot,
        // fast") — decision to propagate rather than silently skip once the caller HAS opted in
        // by configuring envpit.api-key.
        assertThrows(Exception.class, () -> boot(
                "--envpit.api-key=epk_test", "--envpit.host=http://127.0.0.1:1", "--envpit.timeout=1s"));
    }

    @Test
    void excludeKeysPropertyKeepsNamedKeysOutOfTheEnvironment() {
        server = SpringTestSupport.TestServer.serving(
                SpringTestSupport.toJson(Map.of("DB_PASSWORD", "hunter2", "API_URL", "https://x")));
        ConfigurableApplicationContext ctx = boot(
                "--envpit.api-key=epk_test", "--envpit.host=" + server.baseUrl,
                "--envpit.exclude-keys=DB_PASSWORD");

        ConfigurableEnvironment env = ctx.getEnvironment();
        assertNull(env.getProperty("DB_PASSWORD"));
        assertEquals("https://x", env.getProperty("API_URL"));
    }

    // ---------------------------------------------------------------------------------------
    // bd:envpit-durd — server-flagged secrets, end to end (real client, real server response;
    // NOT assumed from #knownSecretKeys() being wired unconditionally — verified directly).
    // ---------------------------------------------------------------------------------------

    @Test
    void serverFlaggedSecretKeysAreExcludedFromTheEnvironmentByDefault() {
        server = SpringTestSupport.TestServer.serving(SpringTestSupport.toEnvelopeJson(
                Map.of("DB_PASSWORD", "hunter2", "API_URL", "https://x"), Set.of("DB_PASSWORD")));
        ConfigurableApplicationContext ctx = boot(
                "--envpit.api-key=epk_test", "--envpit.host=" + server.baseUrl);

        ConfigurableEnvironment env = ctx.getEnvironment();
        assertNull(env.getProperty("DB_PASSWORD"), "a server-flagged secret must be excluded by default");
        assertEquals("https://x", env.getProperty("API_URL"), "a non-secret key must still resolve normally");
    }

    @Test
    void includeSecretsTruePropertyDeliberatelyLetsServerFlaggedSecretsIntoTheEnvironment() {
        server = SpringTestSupport.TestServer.serving(SpringTestSupport.toEnvelopeJson(
                Map.of("DB_PASSWORD", "hunter2", "API_URL", "https://x"), Set.of("DB_PASSWORD")));
        ConfigurableApplicationContext ctx = boot(
                "--envpit.api-key=epk_test", "--envpit.host=" + server.baseUrl,
                "--envpit.include-secrets=true");

        ConfigurableEnvironment env = ctx.getEnvironment();
        assertEquals("hunter2", env.getProperty("DB_PASSWORD"),
                "envpit.include-secrets=true must deliberately let the flagged secret through");
        assertEquals("https://x", env.getProperty("API_URL"));
    }

    @Test
    void excludeKeysAndServerFlaggedSecretsCombineRatherThanOverride() {
        // envpit.exclude-keys (explicit, user-named) and knownSecretKeys() (server-flagged) are
        // two independent mechanisms that UNION — setting envpit.include-secrets=true opts
        // server-flagged secrets back in, but must never resurrect a key the caller explicitly
        // named in envpit.exclude-keys.
        server = SpringTestSupport.TestServer.serving(SpringTestSupport.toEnvelopeJson(
                Map.of("DB_PASSWORD", "hunter2", "OTHER_SECRET_LIKE_KEY", "x", "API_URL", "https://x"),
                Set.of("DB_PASSWORD")));
        ConfigurableApplicationContext ctx = boot(
                "--envpit.api-key=epk_test", "--envpit.host=" + server.baseUrl,
                "--envpit.include-secrets=true", "--envpit.exclude-keys=OTHER_SECRET_LIKE_KEY");

        ConfigurableEnvironment env = ctx.getEnvironment();
        assertEquals("hunter2", env.getProperty("DB_PASSWORD"), "opted-in server-flagged secret must resolve");
        assertNull(env.getProperty("OTHER_SECRET_LIKE_KEY"), "explicit envpit.exclude-keys must still apply");
        assertEquals("https://x", env.getProperty("API_URL"));
    }

    // ---------------------------------------------------------------------------------------
    // Assumption check (NO MAGIC) — Spring's relaxed binding, not this module's own code
    // ---------------------------------------------------------------------------------------

    @Test
    void springRelaxedBindingMapsDottedPropertyNameToUppercaseEnvVarName() {
        // Proves the assumption `EnvpitEnvironmentPostProcessor` relies on: reading
        // environment.getProperty("envpit.api-key") ALSO sees an OS env var literally named
        // ENVPIT_API_KEY, once it lives on a source named exactly "systemEnvironment"
        // (SystemEnvironmentPropertySource's own relaxed-binding behavior — Spring's, not ours).
        ConfigurableEnvironment env = new StandardEnvironment();
        env.getPropertySources().replace(StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME,
                new org.springframework.core.env.SystemEnvironmentPropertySource(
                        StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME,
                        Map.of("ENVPIT_API_KEY", "epk_from_os_env")));

        assertEquals("epk_from_os_env", env.getProperty("envpit.api-key"));
    }

    // ---------------------------------------------------------------------------------------
    // Pure filter-merge helper — proves the secret-key-socket wiring without needing to override
    // a method on a `final` EnvpitClient (Java has no Python-style monkeypatch seam here).
    // ---------------------------------------------------------------------------------------

    @Test
    void filterSnapshotDropsNullValuedAndExcludedKeys() {
        Map<String, String> snapshot = new LinkedHashMap<>();
        snapshot.put("API_URL", "https://x");
        snapshot.put("UNSET_KEY", null);
        snapshot.put("DB_PASSWORD", "hunter2");

        Set<String> excludeKeys = new LinkedHashSet<>(Set.of("DB_PASSWORD"));
        Map<String, Object> result = EnvpitEnvironmentPostProcessor.filterSnapshot(snapshot, excludeKeys);

        assertEquals(Map.of("API_URL", "https://x"), result);
    }

    @Test
    void filterSnapshotExcludesTheCombinedExcludeSetBuiltFromARealClientsKnownSecretKeys() {
        // bd:envpit-durd closed the protocol gap this test used to simulate with a hand-built
        // stand-in set ("the future is now" — rewritten per that bd's own instruction). This is a
        // REAL client, loaded against a real local server whose envelope response flags two real
        // secret key names — client.knownSecretKeys() below is the actual server-reported set,
        // not a simulation, proving the exclude-set UNION mechanics `postProcessEnvironment`
        // relies on against real end-to-end behavior.
        server = SpringTestSupport.TestServer.serving(SpringTestSupport.toEnvelopeJson(
                Map.of("DB_PASSWORD", "hunter2", "JWT_SECRET", "s3cr3t", "API_URL", "https://x"),
                Set.of("DB_PASSWORD", "JWT_SECRET")));

        EnvpitClient client = EnvpitClient.builder()
                .apiKey("epk_test").host(server.baseUrl).pollInterval(java.time.Duration.ZERO).load();
        try {
            Set<String> explicitExclude = Set.of(); // caller passed no envpit.exclude-keys
            assertEquals(Set.of("DB_PASSWORD", "JWT_SECRET"), client.knownSecretKeys(),
                    "test precondition: the real client must report the real server-flagged secret set");

            Set<String> combined = new LinkedHashSet<>(explicitExclude);
            combined.addAll(client.knownSecretKeys());
            Map<String, Object> result = EnvpitEnvironmentPostProcessor.filterSnapshot(client.snapshot(), combined);

            assertFalse(result.containsKey("DB_PASSWORD"));
            assertFalse(result.containsKey("JWT_SECRET"));
            assertTrue(result.containsKey("API_URL"));
        } finally {
            client.close();
        }
    }
}
