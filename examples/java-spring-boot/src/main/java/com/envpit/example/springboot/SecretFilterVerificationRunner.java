package com.envpit.example.springboot;

import com.envpit.EnvpitClient;

import org.springframework.boot.CommandLineRunner;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.EnumerablePropertySource;
import org.springframework.core.env.PropertySource;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * Two things this runner proves, both against the REAL Spring {@link ConfigurableEnvironment}
 * object (never against a returned summary):
 *
 * <ol>
 *   <li>Ordinary EnvPit config really is readable through Spring's own resolution machinery —
 *       it reads a sample key straight off {@link ConfigurableEnvironment#getProperty(String)},
 *       the exact resolver {@code @Value("${...}")} uses underneath (see
 *       {@link EnvpitValueDemo} for the literal {@code @Value} form, added after this run
 *       confirmed a real key name — README.md "Run 1").
 *   <li>Secret-flagged keys do NOT reach that Environment. This does NOT trust {@link
 *       ExampleEnvpitEnvironmentPostProcessor}'s own excluded-key bookkeeping — it opens a
 *       SECOND, independent {@link EnvpitClient} against the live server, asks it fresh for
 *       {@link EnvpitClient#knownSecretKeys()}, and checks each one directly against {@code
 *       environment.containsProperty(...)}. If the post-processor's filter had a bug, this
 *       independent re-derivation would still catch it.
 * </ol>
 */
@Component
public class SecretFilterVerificationRunner implements CommandLineRunner {

    private final ConfigurableEnvironment environment;

    public SecretFilterVerificationRunner(ConfigurableEnvironment environment) {
        this.environment = environment;
    }

    @Override
    public void run(String... args) throws Exception {
        System.out.println();
        PropertySource<?> ours = environment.getPropertySources()
                .get(ExampleEnvpitEnvironmentPostProcessor.PROPERTY_SOURCE_NAME);
        if (ours instanceof EnumerablePropertySource<?> enumerable && enumerable.getPropertyNames().length > 0) {
            String sampleName = enumerable.getPropertyNames()[0];
            boolean resolved = environment.getProperty(sampleName) != null;
            System.out.println("[verify] sample non-secret key '" + sampleName
                    + "' resolves via environment.getProperty(...): " + resolved + " (value redacted)");
        } else {
            System.out.println("[verify] no non-secret keys were contributed to the Environment this run");
        }

        String apiKey = System.getenv("ENVPIT_API_KEY");
        String host = System.getenv("ENVPIT_HOST");
        EnvpitClient.Builder builder = EnvpitClient.builder().apiKey(apiKey).pollInterval(Duration.ZERO);
        if (host != null && !host.isBlank()) {
            builder.host(host);
        }

        // Independent, fresh call — ground truth re-derived from the live server, not reused from
        // the post-processor's own bookkeeping.
        try (EnvpitClient verifyClient = builder.load()) {
            Set<String> secretKeysGroundTruth = verifyClient.knownSecretKeys();
            System.out.println("[verify] re-fetched secret-flagged key set independently from the live server: "
                    + secretKeysGroundTruth);

            List<String> leaked = new ArrayList<>();
            for (String secretKey : secretKeysGroundTruth) {
                if (environment.containsProperty(secretKey)) {
                    leaked.add(secretKey);
                }
            }

            if (!leaked.isEmpty()) {
                System.err.println("[verify] FAIL — secret-flagged key(s) present in Spring's Environment: " + leaked);
                System.exit(1);
            }

            if (secretKeysGroundTruth.isEmpty()) {
                System.out.println(
                        "[verify] the live environment currently has no server-flagged secret keys — nothing to withhold "
                                + "here. See README.md: HOMER_KEY is secret-flagged but currently has no value, so it "
                                + "never enters the config snapshot at all (absent, not withheld) and cannot appear in "
                                + "this set either. This is NOT evidence the filter is broken.");
            } else {
                System.out.println("[verify] OK — none of the " + secretKeysGroundTruth.size()
                        + " server-flagged secret key(s) are present in environment.containsProperty(...)");
            }
        }
    }
}
