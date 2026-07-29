package com.envpit.example.springboot;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * No web server on purpose (see pom.xml — spring-boot-starter, not -starter-web): a startup log
 * plus a CommandLineRunner is enough to prove the integration (task brief: "A single endpoint or
 * a startup log is enough"). The app exits naturally once {@link SecretFilterVerificationRunner}
 * returns — no non-daemon threads are left running because {@link
 * ExampleEnvpitEnvironmentPostProcessor} uses {@code pollInterval(Duration.ZERO)} (no background
 * poll/SSE threads) and every {@code EnvpitClient} this example opens is closed.
 */
@SpringBootApplication
public class EnvpitExampleApplication {
    public static void main(String[] args) {
        SpringApplication.run(EnvpitExampleApplication.class, args);
    }
}
