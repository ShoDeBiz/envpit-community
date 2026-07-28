# envpit-spring-boot-starter

Spring Boot integration for the [EnvPit](https://envpit.com) Java SDK — bd:envpit-yvyr. A separate
Maven artifact from `envpit-sdk` (this module's sibling `../pom.xml`), so the core SDK stays
zero-runtime-dependency; see that module's own README, "Using Spring Boot? `@Value` and
`@ConfigurationProperties` just work", for the full properties table, precedence rules, and
documented limitations (boot-time-snapshot-only, no automatic secret exclusion yet).

```xml
<dependency>
  <groupId>com.envpit</groupId>
  <artifactId>envpit-spring-boot-starter</artifactId>
  <version>0.1.0</version>
</dependency>
```

```yaml
envpit:
  api-key: ${ENVPIT_API_KEY}
```

That's it — existing `@Value("${SOME_KEY}")` and `@ConfigurationProperties` code starts resolving
against EnvPit, alongside every other Spring property source, with the precedence documented in
the main SDK README.

## What's in this module

- `com.envpit.spring.EnvpitEnvironmentPostProcessor` — an `org.springframework.boot.env.EnvironmentPostProcessor`,
  discovered via `META-INF/spring.factories` (still the correct SPI mechanism for
  `EnvironmentPostProcessor` in Spring Boot 3.x — only `@AutoConfiguration` moved to
  `...AutoConfiguration.imports`; verified against the actual `spring-boot-3.1.3.jar`'s own
  `META-INF/spring.factories`). Runs once per boot, fetches one snapshot via
  `EnvpitClient.builder()...load()`, contributes a single `MapPropertySource`, then closes the
  client — see the class's own Javadoc for the full precedence/boot-snapshot/secrets rationale.

## What's deliberately NOT in this module (this round)

- **`envpit.project` / `envpit.environment` properties** — the underlying `EnvpitClient.Builder`
  has no such concept (project/environment are inferred from the API key server-side); adding
  these properties would be dead configuration.
- **`envpit.poll-interval`** — there is no live target for a background refresh to update once
  values are copied into the `Environment`; exposing this property would be misleading.
- **Actuator health/info contribution** — spec §12 lists it, but it wasn't built here: flagged
  back rather than built just because the spec says so. A health indicator needs a *live*
  `EnvpitClient` to report against, which cuts against this module's boot-time-snapshot-then-close
  design. Candidate for a follow-up bd once there's an actual consumer need.
- **`@RefreshScope` support** — would require adding a `spring-cloud-context` dependency; not
  added without the owner's explicit go-ahead (asked for, not assumed).
- **An auto-registered `EnvpitClient` bean** — kept out to avoid ambiguity with the existing
  manual-`@Bean` pattern (main README, "Prefer a live, injectable client instead?") over
  lifecycle/`destroyMethod` ownership.

## Build

Depends on `com.envpit:envpit-sdk:0.1.0` being resolvable (install `../pom.xml` first — this
module is a standalone sibling POM, not part of a multi-module reactor with the core SDK).
