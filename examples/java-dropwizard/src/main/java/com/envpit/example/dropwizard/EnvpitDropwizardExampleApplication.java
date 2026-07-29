package com.envpit.example.dropwizard;

import com.envpit.EnvpitClient;
import io.dropwizard.core.Application;
import io.dropwizard.core.setup.Bootstrap;
import io.dropwizard.core.setup.Environment;

import java.time.Duration;
import java.util.Map;
import java.util.Set;

/**
 * Runnable Dropwizard example consuming the PUBLISHED com.envpit:envpit-sdk from Maven Central
 * against a real EnvPit production API. See README.md for exact run commands and expected output.
 */
public class EnvpitDropwizardExampleApplication extends Application<EnvpitExampleConfiguration> {

    public static void main(String[] args) throws Exception {
        new EnvpitDropwizardExampleApplication().run(args);
    }

    @Override
    public String getName() {
        return "envpit-example-dropwizard";
    }

    @Override
    public void initialize(Bootstrap<EnvpitExampleConfiguration> bootstrap) {
        // No YAML substitution setup needed — the API key is read straight from the OS
        // environment (never bound through config.yml, per the task's "never write the key into
        // any file in the repo" rule) and EnvPit values are contributed programmatically below,
        // not via Dropwizard's YAML deserialization at all.
    }

    @Override
    public void run(EnvpitExampleConfiguration configuration, Environment environment) throws Exception {
        String apiKey = System.getenv("ENVPIT_API_KEY");
        if (apiKey == null || apiKey.isBlank()) {
            throw new IllegalStateException(
                    "envpit example: ENVPIT_API_KEY is not set. Run: set -a; . ~/.envpit-example.env; set +a");
        }
        String host = System.getenv("ENVPIT_HOST");

        EnvpitClient.Builder builder = EnvpitClient.builder().apiKey(apiKey).pollInterval(Duration.ZERO);
        if (host != null && !host.isBlank()) {
            builder.host(host);
        }

        // The one real network call at boot — a real production EnvPit server, not a mock
        // transport. load() throws an EnvpitException subtype on failure (INV-SDK-1) — propagating
        // it here fails Dropwizard's own run() fast, same "bad key fails the boot" convention the
        // SDK documents for every framework integration.
        EnvpitClient client = builder.load();
        try {
            Set<String> secretKeys = client.knownSecretKeys();
            Map<String, String> snapshot = client.snapshot();

            System.out.println("[envpit] resolved " + snapshot.size() + " config key(s) from "
                    + (host != null && !host.isBlank() ? host : "https://envpit.com") + " (key NAMES only): "
                    + snapshot.keySet());
            System.out.println("[envpit] server-flagged secret key(s) — excluded from the Configuration object by default: "
                    + secretKeys);

            Map<String, String> envpitConfig = configuration.getEnvpitConfig();
            for (Map.Entry<String, String> entry : snapshot.entrySet()) {
                String key = entry.getKey();
                String value = entry.getValue();
                if (value == null) {
                    continue; // unset in this environment — nothing to contribute
                }
                if (secretKeys.contains(key)) {
                    continue; // secret-flagged — never reaches the Configuration object from this path
                }
                envpitConfig.put(key, value);
            }

            System.out.println("[envpit] contributed " + envpitConfig.size()
                    + " key(s) to the Dropwizard Configuration object: " + envpitConfig.keySet());
        } finally {
            client.close();
        }

        environment.jersey().register(new ConfigKeysResource(configuration.getEnvpitConfig()));
        environment.healthChecks().register("envpit-secret-filter",
                new EnvpitSecretFilterHealthCheck(configuration.getEnvpitConfig(), apiKey, host));
    }
}
