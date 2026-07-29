package com.envpit.example.springboot;

import com.envpit.EnvpitClient;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.context.config.ConfigDataEnvironmentPostProcessor;
import org.springframework.boot.env.EnvironmentPostProcessor;
import org.springframework.core.Ordered;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.StandardEnvironment;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * This project's OWN wiring of {@code com.envpit:envpit-sdk} into Spring's {@code Environment} —
 * NOT {@code com.envpit.spring.EnvpitEnvironmentPostProcessor} from
 * {@code com.envpit:envpit-spring-boot-starter}. That starter artifact was never published to
 * Maven Central (verified 404 on repo1.maven.org the day this example was written, while
 * {@code envpit-sdk:0.1.0} itself returns 200) so an example that depends on it would only build
 * after an undocumented {@code mvn install} of a local checkout — a trap for anyone who clones
 * this repo expecting "depend on Central, it builds." See README.md "Why (a), not (b)".
 *
 * <p>The shape below intentionally mirrors the unpublished starter's real
 * {@code EnvpitEnvironmentPostProcessor} (same repo, {@code sdks/java/envpit-spring-boot-starter})
 * as closely as a Central-only dependency allows: one boot-time, synchronous
 * {@link EnvpitClient#load()} call, one {@link MapPropertySource} contributed to the
 * {@link ConfigurableEnvironment}, secret-flagged keys excluded by default. It does NOT exercise
 * the starter's own class — this is example-local wiring against the public {@code EnvpitClient}
 * API only ({@link EnvpitClient#snapshot()}, {@link EnvpitClient#knownSecretKeys()}), both of
 * which are already public, documented surface on the published SDK.
 */
public final class ExampleEnvpitEnvironmentPostProcessor implements EnvironmentPostProcessor, Ordered {

    static final String PROPERTY_SOURCE_NAME = "envpitExampleConfig";

    @Override
    public int getOrder() {
        // Doesn't strictly need to run after application.yml/.properties (this example carries no
        // envpit.* configuration keys in any file — the API key is read straight from the OS
        // environment, never from a Spring-bound property, per the task's "never write the key
        // into any file in the repo" rule). Ordered the same way the real starter is anyway, for
        // parity: after Spring Boot's own ConfigData processing.
        return ConfigDataEnvironmentPostProcessor.ORDER + 1;
    }

    @Override
    public void postProcessEnvironment(ConfigurableEnvironment environment, SpringApplication application) {
        String apiKey = System.getenv("ENVPIT_API_KEY");
        if (apiKey == null || apiKey.isBlank()) {
            throw new IllegalStateException(
                    "envpit example: ENVPIT_API_KEY is not set. Run: set -a; . ~/.envpit-example.env; set +a");
        }
        String host = System.getenv("ENVPIT_HOST");

        EnvpitClient.Builder builder = EnvpitClient.builder()
                .apiKey(apiKey)
                // Boot-time snapshot only, same decision the real starter documents: nothing in
                // this example holds the client open past the one fetch, so there is no live
                // target for a background poll/SSE thread to refresh.
                .pollInterval(Duration.ZERO);
        if (host != null && !host.isBlank()) {
            builder.host(host);
        }

        // The one real network call this post-processor makes — a real production EnvPit server,
        // not a mock transport. load() throws an EnvpitException subtype on any failure (bad key,
        // unreachable host) and never returns a half-initialized client (INV-SDK-1) — propagating
        // it here fails Spring's own application-context startup fast, matching the SDK's
        // documented "a bad key fails the boot, fast" convention.
        EnvpitClient client = builder.load();
        try {
            Set<String> secretKeys = client.knownSecretKeys();
            Map<String, String> snapshot = client.snapshot();

            System.out.println("[envpit] resolved " + snapshot.size() + " config key(s) from "
                    + (host != null && !host.isBlank() ? host : "https://envpit.com") + " (key NAMES only): "
                    + snapshot.keySet());
            System.out.println("[envpit] server-flagged secret key(s) — excluded from Spring Environment by default: "
                    + secretKeys);

            Map<String, Object> nonSecretValues = new LinkedHashMap<>();
            for (Map.Entry<String, String> entry : snapshot.entrySet()) {
                String key = entry.getKey();
                String value = entry.getValue();
                if (value == null) {
                    continue; // unset in this environment — nothing to contribute
                }
                if (secretKeys.contains(key)) {
                    continue; // secret-flagged — never reaches the Environment from this path
                }
                nonSecretValues.put(key, value);
            }

            environment.getPropertySources().addAfter(
                    StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME,
                    new MapPropertySource(PROPERTY_SOURCE_NAME, nonSecretValues));

            System.out.println("[envpit] contributed " + nonSecretValues.size()
                    + " key(s) to Spring's Environment (property source '" + PROPERTY_SOURCE_NAME + "'): "
                    + nonSecretValues.keySet());
        } finally {
            client.close();
        }
    }
}
