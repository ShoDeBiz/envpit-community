# EnvPit + Spring Boot example

Consumes the **published** `com.envpit:envpit-sdk:0.1.0` from Maven Central and resolves config
from a real EnvPit production API, making it available through Spring's own `Environment` /
`@Value` — with server-flagged secret keys verified absent from that same `Environment`.

## Why (a), not (b)

`com.envpit:envpit-sdk:0.1.0` **is** on Maven Central (verified: `curl` against
`repo1.maven.org/maven2/com/envpit/envpit-sdk/0.1.0/envpit-sdk-0.1.0.jar` → `200`).
`com.envpit:envpit-spring-boot-starter` is **not** (same check → `404`; it was never published).

So this example does **not** depend on the starter. It wires `EnvpitClient` into Spring's
`Environment` itself — [`ExampleEnvpitEnvironmentPostProcessor`](src/main/java/com/envpit/example/springboot/ExampleEnvpitEnvironmentPostProcessor.java)
mirrors the unpublished starter's real `EnvpitEnvironmentPostProcessor`
(`sdks/java/envpit-spring-boot-starter`) as closely as a Central-only dependency allows — one
boot-time `EnvpitClient.load()`, one `MapPropertySource`, secrets excluded by default — but it is
example-local code, not the starter's own class.

This was chosen over installing the starter locally (`mvn install` into `~/.m2`) because an
example that only builds after an undocumented local-install step is a trap for anyone who clones
this repo expecting "depend on Central, it builds." The trade-off, stated plainly: this does
**not** exercise `com.envpit.spring.EnvpitEnvironmentPostProcessor` itself against a live server —
only this repo's own equivalent wiring, built from the same public `EnvpitClient` API
(`snapshot()`, `knownSecretKeys()`) the starter also uses.

## Run

```bash
set -a; . ~/.envpit-example.env; set +a
cd examples/java-spring-boot
mvn spring-boot:run
```

(Or `mvn -DskipTests package && java -jar target/envpit-example-spring-boot-1.0.0.jar`.)

## What correct output looks like

```
[envpit] resolved 4 config key(s) from https://envpit.com (key NAMES only): [DB_URL, GREETING, HOMER_KEY, MOELSOE]
[envpit] server-flagged secret key(s) — excluded from Spring Environment by default: [HOMER_KEY]
[envpit] contributed 3 key(s) to Spring's Environment (property source 'envpitExampleConfig'): [DB_URL, GREETING, MOELSOE]

  .   ____          _            __ _ _
 ...
:: Spring Boot ::                (v3.1.3)

... Starting EnvpitExampleApplication ...
[verify] @Value("${GREETING}") resolved via Spring's own Environment: true (value redacted, length=10)
... Started EnvpitExampleApplication in 0.63 seconds ...

[verify] sample non-secret key 'DB_URL' resolves via environment.getProperty(...): true (value redacted)
[verify] re-fetched secret-flagged key set independently from the live server: [HOMER_KEY]
[verify] OK — none of the 1 server-flagged secret key(s) are present in environment.containsProperty(...)
```

Then the process exits on its own (no web server, no non-daemon threads left — the
`EnvpitClient` uses `pollInterval(Duration.ZERO)` and is always closed).

### Reading this output

- **`@Value("${GREETING}") resolved: true`** — this is the feature: an ordinary Spring `@Value`
  field, resolving a key that arrived via EnvPit, with zero `EnvpitClient` reference in that class.
- **`HOMER_KEY`** is the one server-flagged secret key in this environment and is absent from every
  list Spring's `Environment` produces.
- **A secret with no value in the environment is "absent," not "withheld."** If `HOMER_KEY` (or
  any other secret-flagged key) currently has no value set, it never enters the config snapshot at
  all — so it can't show up in a "withheld" list either. `[verify]` prints an explicit note for
  this case instead of a bare empty list, so it doesn't read like the filter silently did nothing.
- **Never a config value, never the API key** — every line above prints key *names* only.

## How the secret-filter check works (and why it's not "just trust the summary")

[`SecretFilterVerificationRunner`](src/main/java/com/envpit/example/springboot/SecretFilterVerificationRunner.java)
does **not** reuse the excluded-key bookkeeping the `EnvironmentPostProcessor` already computed at
boot. It opens a **second, independent** `EnvpitClient` against the live server, asks it fresh for
`knownSecretKeys()`, and checks each one directly with
`environment.containsProperty(secretKey)` — against the real `ConfigurableEnvironment` object
Spring is actually using, not a returned merge-summary string.

## Files

| File | Role |
|---|---|
| `pom.xml` | Depends on `com.envpit:envpit-sdk:0.1.0` (Central) + `spring-boot-starter` (no web) |
| `ExampleEnvpitEnvironmentPostProcessor.java` | Boot-time EnvPit → Spring `Environment` wiring |
| `META-INF/spring.factories` | Registers the post-processor (SPI, still `spring.factories`-based in Boot 3.1.x) |
| `EnvpitExampleApplication.java` | `@SpringBootApplication` entry point |
| `EnvpitValueDemo.java` | The literal `@Value("${GREETING}")` demo |
| `SecretFilterVerificationRunner.java` | Independent re-verification against the real `Environment` |

## What I could not verify

- The *actual* `com.envpit.spring.EnvpitEnvironmentPostProcessor` class (the unpublished starter)
  has still never run against this live server — this example proves the wire contract works
  end-to-end through the SDK's public API, not that specific class's own code path. Exercising
  that class for real requires option (b): `mvn install` the starter module locally first.
