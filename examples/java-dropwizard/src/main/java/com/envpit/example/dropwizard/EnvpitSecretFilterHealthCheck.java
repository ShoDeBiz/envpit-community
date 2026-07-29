package com.envpit.example.dropwizard;

import com.codahale.metrics.health.HealthCheck;
import com.envpit.EnvpitClient;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Asserts, against the REAL framework Configuration object ({@link
 * EnvpitExampleConfiguration#getEnvpitConfig()}), that no server-flagged secret key ever reached
 * it — the exact "asserted against the real config object rather than trusting a returned
 * summary" requirement from the task brief.
 *
 * <p>Deliberately does NOT reuse the secret-key set {@link EnvpitDropwizardExampleApplication#run}
 * already computed once at boot to decide what to exclude. Every time this check runs (Dropwizard
 * calls health checks repeatedly, both via {@code /healthcheck} and on its own schedule) it opens
 * a fresh {@link EnvpitClient} against the live server and re-derives {@link
 * EnvpitClient#knownSecretKeys()} from scratch — an independent, adversarial re-check, not a
 * cached bookkeeping trust.
 */
public class EnvpitSecretFilterHealthCheck extends HealthCheck {

    private final Map<String, String> envpitConfig;
    private final String apiKey;
    private final String host;

    public EnvpitSecretFilterHealthCheck(Map<String, String> envpitConfig, String apiKey, String host) {
        this.envpitConfig = envpitConfig;
        this.apiKey = apiKey;
        this.host = host;
    }

    @Override
    protected Result check() {
        EnvpitClient.Builder builder = EnvpitClient.builder().apiKey(apiKey).pollInterval(Duration.ZERO);
        if (host != null && !host.isBlank()) {
            builder.host(host);
        }

        try (EnvpitClient verifyClient = builder.load()) {
            Set<String> secretKeysGroundTruth = verifyClient.knownSecretKeys();

            List<String> leaked = new ArrayList<>();
            for (String secretKey : secretKeysGroundTruth) {
                if (envpitConfig.containsKey(secretKey)) {
                    leaked.add(secretKey);
                }
            }

            if (!leaked.isEmpty()) {
                return Result.unhealthy(
                        "secret-flagged key(s) present in the framework Configuration object: " + leaked);
            }

            if (secretKeysGroundTruth.isEmpty()) {
                return Result.healthy(
                        "no server-flagged secret keys in this environment right now — nothing to withhold "
                                + "(see README.md: this is the HOMER_KEY-unset case, absent is not the same as withheld)");
            }

            return Result.healthy("none of " + secretKeysGroundTruth.size()
                    + " independently re-fetched secret-flagged key(s) " + secretKeysGroundTruth
                    + " are present in the framework's Configuration object");
        } catch (Exception e) {
            return Result.unhealthy("could not independently re-verify against the live server: " + e.getMessage());
        }
    }
}
