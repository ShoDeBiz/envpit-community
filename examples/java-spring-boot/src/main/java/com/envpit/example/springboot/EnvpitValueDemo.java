package com.envpit.example.springboot;

import jakarta.annotation.PostConstruct;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * The literal thing this whole example exists to demonstrate: an ordinary Spring {@code
 * @Value("${...}")} field, resolving a key that arrived through EnvPit — no {@code EnvpitClient}
 * reference anywhere in this class, no special API, just Spring's own placeholder resolution
 * reading whatever {@link ExampleEnvpitEnvironmentPostProcessor} contributed to the Environment.
 *
 * <p>Bound to {@code GREETING} — a real, non-secret key confirmed present in this production
 * environment by an actual run of this example BEFORE this field was written (README.md "Run 1"
 * output: "[envpit] resolved 4 config key(s) ...: [DB_URL, GREETING, HOMER_KEY, MOELSOE]" /
 * "[envpit] server-flagged secret key(s) ...: [HOMER_KEY]" — GREETING is in the first list and
 * not the second). Not a guess: this key name would not compile-safely bind to anything if it
 * didn't exist, and the fallback below makes that failure mode visible rather than silent.
 */
@Component
public class EnvpitValueDemo {

    @Value("${GREETING:__envpit_example_key_not_found__}")
    private String greeting;

    @PostConstruct
    void report() {
        boolean resolved = !"__envpit_example_key_not_found__".equals(greeting);
        System.out.println("[verify] @Value(\"${GREETING}\") resolved via Spring's own Environment: "
                + resolved + " (value redacted, length=" + (greeting != null ? greeting.length() : 0) + ")");
    }
}
