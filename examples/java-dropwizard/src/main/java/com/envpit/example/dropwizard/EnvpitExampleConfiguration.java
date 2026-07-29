package com.envpit.example.dropwizard;

import io.dropwizard.core.Configuration;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Dropwizard has no Spring-style relaxed-binding Environment/property-source merge system —
 * config normally comes ONLY from YAML deserialization into a {@link Configuration} subclass.
 * This one is deliberately never deserialized with EnvPit data (the {@code envpitConfig} field
 * below carries no YAML mapping and is absent from {@code config.yml} entirely) — it is populated
 * PROGRAMMATICALLY, once, in {@link EnvpitDropwizardExampleApplication#run}, straight from a real
 * {@code EnvpitClient} snapshot fetched against the live production API.
 *
 * <p>This instance — the actual {@link Configuration} object Dropwizard hands to {@code run()}
 * and keeps for the life of the application — is "the framework's configuration object" the task
 * brief's secret-filter demonstration must assert against ({@link EnvpitSecretFilterHealthCheck}
 * reads {@link #getEnvpitConfig()} directly, not a returned merge summary).
 */
public class EnvpitExampleConfiguration extends Configuration {

    // Never annotated with @JsonProperty on purpose — nothing about this map is meant to come
    // from config.yml. Mutated exactly once, at boot, by EnvpitDropwizardExampleApplication#run.
    private final Map<String, String> envpitConfig = new LinkedHashMap<>();

    public Map<String, String> getEnvpitConfig() {
        return envpitConfig;
    }
}
