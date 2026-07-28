package com.envpit.spring;

import com.envpit.EnvpitClient;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.context.config.ConfigDataEnvironmentPostProcessor;
import org.springframework.boot.convert.DurationStyle;
import org.springframework.boot.env.EnvironmentPostProcessor;
import org.springframework.core.Ordered;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.StandardEnvironment;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

/**
 * bd:envpit-yvyr (owner directive 2026-07-27: {@code @Value("${DATABASE_URL}")} and {@code
 * @ConfigurationProperties} should work with no special client object). Contributes a single
 * {@link MapPropertySource} named {@value #PROPERTY_SOURCE_NAME}, built once from a one-shot
 * {@link EnvpitClient#snapshot()} fetched at boot — after that, EVERY key in it resolves through
 * the normal Spring {@code Environment}/property-placeholder machinery exactly like any other
 * property source; {@code @ConfigurationProperties} binding needs no extra code here at all
 * because it binds against whatever is in the {@code Environment}, not against this class.
 *
 * <h2>Properties</h2>
 * <pre>{@code
 * envpit:
 *   api-key: ${ENVPIT_API_KEY}   # optional in application.yml — falls back to the ENVPIT_API_KEY
 *                                 # OS env var via Spring's own relaxed binding on the
 *                                 # "systemEnvironment" property source (proven directly in
 *                                 # EnvpitEnvironmentPostProcessorTest#springRelaxedBindingMaps...)
 *   enabled: true                 # default true — set false to disable even if an api-key resolves
 *   host: https://envpit.com      # default shown; override for self-hosted/local dev
 *   timeout: 5s                   # default 5s — the ONE synchronous boot-time fetch's own timeout
 *   exclude-keys: DB_PASSWORD,JWT_SECRET   # comma-separated; kept out of the Environment
 *   include-secrets: false        # default false — set true to deliberately let server-flagged
 *                                   # secret keys (EnvpitClient#knownSecretKeys()) into the
 *                                   # Environment; see "Secrets" below before enabling
 * }</pre>
 *
 * <p><b>Deliberately NOT supported: {@code envpit.project} / {@code envpit.environment}</b> —
 * despite appearing in the sample YAML at {@code EnvPit_SDK_Design_Specification.md} §12 (a
 * forward-looking design doc — see this repo's own CLAUDE.md: "draft — Phase 2+ forward-looking,
 * not yet built, do not pull forward without discussion"), the ACTUAL {@link EnvpitClient.Builder}
 * has no {@code .project(...)}/{@code .environment(...)} method at all: project + environment are
 * inferred server-side from the API key itself (INV-SDK-12 — see {@code Transport.java}'s own doc
 * comment, and the server route this SDK calls, {@code GET /api/v1/config} = {@code
 * ApiKeyScopedConfigResolveController} in the main {@code envpit} repo, which derives both from
 * {@code req.apiKey}, never from caller input). Adding these properties here would silently do
 * nothing — flagged back to the owner as a real spec-vs-implementation gap, not implemented as
 * dead configuration.
 *
 * <p><b>Deliberately NOT supported: {@code envpit.poll-interval}</b> — see decision #3 below;
 * there is no live target for a background refresh to update once values are copied into
 * {@code Environment}, so exposing a property that implies otherwise would be actively
 * misleading.
 *
 * <h2>Precedence (decision #2, owner-settled — Spring's own default-source ordering)</h2>
 * Added via {@code environment.getPropertySources().addAfter(
 * StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME, ...)}. Spring's own default
 * {@code ConfigurableEnvironment} source order (highest precedence first — {@code
 * SpringApplication.configurePropertySources} adds {@code commandLineArgs} via {@code addFirst}
 * before {@code EnvironmentPostProcessor}s ever run; {@code systemProperties}/{@code
 * systemEnvironment} are added by {@link StandardEnvironment}'s own constructor, earlier still)
 * means the resulting order is:
 * <pre>
 *   command-line args  &gt;  System properties  &gt;  OS environment variables  &gt;  ENVPIT  &gt;
 *   application-{profile}.yml/properties  &gt;  application.yml/properties  &gt;  @PropertySource  &gt;
 *   SpringApplication#setDefaultProperties
 * </pre>
 * i.e. a deploy-time override (Kubernetes env var, {@code -D}/{@code --} flag, CI variable)
 * ALWAYS wins over EnvPit; EnvPit wins over whatever static {@code application.yml}/{@code
 * .properties} file is packaged in the jar — the product story this SDK is built around
 * ("replaces scattered {@code .env} files", CLAUDE.md) only makes sense if EnvPit sits above the
 * static files it's meant to replace.
 *
 * <h2>Boot-time snapshot only (decision #3, owner-settled)</h2>
 * {@code @Value} resolves this {@link MapPropertySource}'s content exactly ONCE, at the moment
 * this post-processor runs (before the {@code ApplicationContext} is even created — {@link
 * EnvironmentPostProcessor} has no {@code ApplicationContext}/bean to hold a live subscription
 * against in the first place). EnvPit's realtime refresh (SSE, M17/bd:envpit-a9d) CANNOT reach a
 * value already copied into the {@code Environment} this way — plain {@code @Value} has no
 * equivalent of Spring Cloud's {@code @RefreshScope}, and this module deliberately does NOT add a
 * {@code spring-cloud-context} dependency to bridge that gap (owner instruction: propose first,
 * never add the dependency unasked). An application that needs guaranteed-live values should
 * construct and hold its own {@code EnvpitClient} bean (see {@code ../../../README.md}, "Using
 * Spring? Register it as a bean") and read through {@code get()}/{@code onChange()} instead of
 * {@code @Value} for those specific keys.
 *
 * <h2>Secrets (decision #1, owner-settled — see {@link EnvpitClient#knownSecretKeys()})</h2>
 * bd:envpit-durd closed the protocol gap {@link EnvpitClient#knownSecretKeys()} used to be a
 * placeholder for: it now returns the real, server-reported set of secret-flagged key names for
 * this environment. By default (matching every language's identical default —
 * test-vectors/env-merge.json's {@code includeSecrets} defaults to {@code false}) this starter
 * folds that set into the excluded-key set, alongside {@code envpit.exclude-keys}, so secrets
 * NEVER reach {@code @Value}/{@code @ConfigurationProperties} unless a deployment deliberately
 * opts in with {@code envpit.include-secrets=true}. Naming that property at the call site IS the
 * acknowledgment (same posture Node's {@code includeSecrets: true} call-site argument takes) —
 * there is no second flag. Opting in writes decrypted secret values into the Spring {@code
 * Environment}, from which they are readable by {@code @Value}, actuator {@code /env} (if
 * exposed), and anything else that walks {@code Environment} property sources — know your
 * exposure before setting it.
 */
public final class EnvpitEnvironmentPostProcessor implements EnvironmentPostProcessor, Ordered {

    static final String PROPERTY_SOURCE_NAME = "envpitPropertySource";

    private static final String PREFIX = "envpit.";
    private static final String PROP_ENABLED = PREFIX + "enabled";
    private static final String PROP_API_KEY = PREFIX + "api-key";
    private static final String PROP_HOST = PREFIX + "host";
    private static final String PROP_TIMEOUT = PREFIX + "timeout";
    private static final String PROP_EXCLUDE_KEYS = PREFIX + "exclude-keys";
    private static final String PROP_INCLUDE_SECRETS = PREFIX + "include-secrets";

    @Override
    public int getOrder() {
        // Must run AFTER application.yml/.properties are loaded (so envpit.api-key set THERE is
        // visible here) — ConfigDataEnvironmentPostProcessor.ORDER is Spring Boot's own public
        // constant for exactly this ordering need (verified against the actual 3.1.3 jar: `javap
        // org.springframework.boot.context.config.ConfigDataEnvironmentPostProcessor`).
        return ConfigDataEnvironmentPostProcessor.ORDER + 1;
    }

    @Override
    public void postProcessEnvironment(ConfigurableEnvironment environment, SpringApplication application) {
        if (!isEnabled(environment)) {
            return;
        }

        String apiKey = environment.getProperty(PROP_API_KEY);
        if (apiKey == null || apiKey.isBlank()) {
            // Not opted in anywhere (no envpit.api-key property, and Spring's relaxed binding
            // found no ENVPIT_API_KEY OS env var either — see
            // #springRelaxedBindingMapsDottedPropertyNameToUppercaseEnvVarName). A silent no-op,
            // not a boot failure: this starter may be on the classpath transitively without every
            // consuming app actually using EnvPit.
            return;
        }

        EnvpitClient client = loadClient(environment, apiKey);
        try {
            Set<String> excludeKeys = new LinkedHashSet<>(resolveExcludeKeys(environment));
            if (!resolveIncludeSecrets(environment)) {
                // Default (and every language's identical default, test-vectors/env-merge.json):
                // secrets are excluded unless a deployment deliberately opts in.
                excludeKeys.addAll(client.knownSecretKeys());
            }

            Map<String, Object> values = filterSnapshot(client.snapshot(), excludeKeys);
            environment.getPropertySources().addAfter(
                    StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME,
                    new MapPropertySource(PROPERTY_SOURCE_NAME, values));
        } finally {
            // Boot-time snapshot only (decision #3) — nothing further is ever read from this
            // client, so its background poll/SSE machinery (already disabled below via
            // pollInterval(ZERO), but closed here too for AutoCloseable hygiene/symmetry) serves
            // no purpose kept open.
            client.close();
        }
    }

    private static boolean isEnabled(ConfigurableEnvironment environment) {
        String raw = environment.getProperty(PROP_ENABLED);
        return raw == null || Boolean.parseBoolean(raw);
    }

    private static boolean resolveIncludeSecrets(ConfigurableEnvironment environment) {
        String raw = environment.getProperty(PROP_INCLUDE_SECRETS);
        return raw != null && Boolean.parseBoolean(raw);
    }

    private static EnvpitClient loadClient(ConfigurableEnvironment environment, String apiKey) {
        EnvpitClient.Builder builder = EnvpitClient.builder()
                .apiKey(apiKey)
                .pollInterval(Duration.ZERO); // boot-time snapshot only (decision #3) — never start
                                               // background poll/SSE threads for values we are
                                               // about to copy out and immediately close over.

        String host = environment.getProperty(PROP_HOST);
        if (host != null && !host.isBlank()) {
            builder.host(host);
        }
        String timeoutRaw = environment.getProperty(PROP_TIMEOUT);
        if (timeoutRaw != null && !timeoutRaw.isBlank()) {
            builder.timeout(DurationStyle.detectAndParse(timeoutRaw));
        }

        // load() throws an EnvpitException subtype on failure and never returns a half-initialized
        // client (INV-SDK-1) — propagating it here fails application-context startup fast, the
        // SAME documented convention the core SDK's own README already states for the manual-bean
        // path ("a bad key fails the boot, fast"). A caller who configured envpit.api-key has
        // opted in; a broken key/host at that point is a real misconfiguration, not something to
        // paper over with a silent skip.
        return builder.load();
    }

    private static Set<String> resolveExcludeKeys(ConfigurableEnvironment environment) {
        String raw = environment.getProperty(PROP_EXCLUDE_KEYS);
        if (raw == null || raw.isBlank()) {
            return Set.of();
        }
        Set<String> result = new LinkedHashSet<>();
        for (String part : raw.split(",")) {
            String trimmed = part.strip();
            if (!trimmed.isEmpty()) {
                result.add(trimmed);
            }
        }
        return result;
    }

    /**
     * Pure — package-visible so {@code EnvpitEnvironmentPostProcessorTest} can exercise the
     * exclude-set UNION mechanics directly with a simulated non-empty "future
     * knownSecretKeys()" set, without needing a seam on {@code final class EnvpitClient} (Java has
     * no monkeypatch equivalent to Python's {@code client._known_secret_keys = lambda: ...}).
     * Drops a {@code null}-valued key (an unset EnvPit variable — nothing to write) exactly like
     * every other language's merge helper (Python's {@code merge_snapshot}, Node's {@code
     * mergeSnapshotIntoEnv}).
     */
    static Map<String, Object> filterSnapshot(Map<String, String> snapshot, Set<String> excludeKeys) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (Map.Entry<String, String> entry : snapshot.entrySet()) {
            if (entry.getValue() == null) {
                continue;
            }
            if (excludeKeys.contains(entry.getKey())) {
                continue;
            }
            result.put(entry.getKey(), entry.getValue());
        }
        return result;
    }
}
