# EnvPit — Java SDK

Official Java SDK for [EnvPit](https://envpit.com) — configuration & secrets management without
enterprise complexity.

## Quickstart

```xml
<dependency>
  <groupId>com.envpit</groupId>
  <artifactId>envpit-sdk</artifactId>
  <version>0.1.0</version>
</dependency>
```

```bash
export ENVPIT_API_KEY="epk_..."   # an environment-pinned key: Project → API Keys → New key
```

```java
EnvpitClient envpit = EnvpitClient.builder().load();   // fetches your environment's config once (blocking)
String dbUrl = envpit.get("DATABASE_URL");             // in-memory read — never a network call
```

Run it — you should see your value. That's it: every `get` after `load()` is an in-memory read;
the snapshot auto-refreshes on a background daemon thread.

### Using Spring Boot? `@Value` and `@ConfigurationProperties` just work

bd:envpit-yvyr — add the starter, set an API key, and existing `@Value("${DATABASE_URL}")` /
`@ConfigurationProperties` code works with **no special client object**:

```xml
<dependency>
  <groupId>com.envpit</groupId>
  <artifactId>envpit-spring-boot-starter</artifactId>
  <version>0.1.0</version>
</dependency>
```

```yaml
# application.yml
envpit:
  api-key: ${ENVPIT_API_KEY}   # optional here — falls back to the ENVPIT_API_KEY OS env var
                                 # (Spring's own relaxed binding on the "systemEnvironment"
                                 # source, not this SDK's fallback)
```

```java
@Component
class MyService {
    @Value("${DATABASE_URL}")
    String databaseUrl;   // resolved from EnvPit — no EnvpitClient in sight
}
```

`@ConfigurationProperties`-bound classes need no extra code at all: they bind against whatever is
in the Spring `Environment`, and EnvPit's values are just another `PropertySource` in it by the
time any bean is constructed.

**Module structure — a separate artifact on purpose.** `envpit-spring-boot-starter` is its own
Maven module/jar (`sdks/java/envpit-spring-boot-starter/`), depending on `envpit-sdk` (compile)
and `spring-boot`/`spring-context` (`provided` — your own Spring BOM supplies the real version at
runtime). `envpit-sdk` itself stays **zero-runtime-dependency**; an app that never adds the
starter gets zero Spring classes anywhere near the core SDK. This is the standard
`spring-boot-starter-*` convention (a separate artifact per integration), not a multi-module
Maven reactor — the two `pom.xml`s are independent, sibling, standalone POMs.

**Properties**

| Property | Default | Meaning |
|---|---|---|
| `envpit.api-key` | *(none — falls back to `ENVPIT_API_KEY` OS env var)* | Required to opt in. Absent everywhere → the starter is a **silent no-op**, not a boot failure (it may be on the classpath transitively without every app using EnvPit). Present but the fetch fails → **fails the boot, fast** (same documented convention as the manual-bean path below). |
| `envpit.enabled` | `true` | Explicit escape hatch — `false` disables even when an api-key resolves. |
| `envpit.host` | `https://envpit.com` | Override for self-hosted/local dev. |
| `envpit.timeout` | `5s` | The one synchronous boot-time fetch's own request timeout (`60s`/`PT5S`-style — `DurationStyle`). |
| `envpit.exclude-keys` | *(none)* | Comma-separated key names kept out of the `Environment` (e.g. `envpit.exclude-keys=DB_PASSWORD,JWT_SECRET`). |

**Not supported: `envpit.project` / `envpit.environment`.** These appear in the SDK design spec's
sample YAML (§12), but `EnvpitClient.Builder` has no `.project(...)`/`.environment(...)` — project
and environment are inferred server-side from the API key itself (INV-SDK-12). Adding these
properties would silently do nothing, so they were deliberately left out rather than shipped as
dead configuration — flagged back to the design docs as a spec-vs-implementation gap.

**Precedence (a deploy-time override always wins over EnvPit):**

```
command-line args  >  System properties  >  OS environment variables  >  ENVPIT  >
application-{profile}.yml/properties  >  application.yml/properties  >  @PropertySource  >
SpringApplication#setDefaultProperties
```

EnvPit is added via `environment.getPropertySources().addAfter("systemEnvironment", ...)` — Spring
Boot's own default source ordering (verified against the actual `spring-boot-3.1.3.jar`) means
this places EnvPit *below* command-line args/System properties/OS env vars and *above* your
packaged `application.yml`/`.properties` — the product story only makes sense if EnvPit outranks
the static files it's meant to replace, while deploy-time overrides (Kubernetes env vars, CI
variables, `-D`/`--` flags) still always win.

**Boot-time snapshot only — not a live subscription.** `@Value` resolves this `PropertySource`'s
content exactly once, at boot, before the `ApplicationContext` even exists. EnvPit's realtime
refresh (SSE) **cannot** reach a value already copied into the `Environment` this way — plain
`@Value` has no equivalent of Spring Cloud's `@RefreshScope`, and this starter deliberately does
**not** add a `spring-cloud-context` dependency to bridge that gap. If you need guaranteed-live
values for specific keys, keep using the manual-bean approach below and read through
`get()`/`onChange()` for those keys.

**Secrets are not auto-excluded — today.** `GET /api/v1/config` (the endpoint every SDK language
calls) returns a flat `key -> value` map with no `is_secret` flag on the wire — verified against
`apps/api/src/config-management/config-resolve.controller.ts`'s response schema in the main
`envpit` repo. There is currently no signal to filter secrets out of `@Value`/`@ConfigurationProperties`
automatically; use `envpit.exclude-keys` for any key you know is sensitive. `EnvpitClient.knownSecretKeys()`
is a prepared extension point for once the server ships this metadata — until then it's always
empty, by design, not approximated with a key-name heuristic (a heuristic is wrong in both
directions: `DATABASE_URL` commonly embeds a password and wouldn't match one).

**Actuator health/info contribution:** not implemented in this round, on purpose — flagged rather
than built just because the design spec (§12) lists it. Reassess as a follow-up once there's an
actual consumer need (a health check needs a live `EnvpitClient` to report against, which cuts
against the boot-time-snapshot-then-close design above).

### Prefer a live, injectable client instead? Register it as a bean

Still the right choice if you need `onChange()`, `cacheInfo()`, or any value guaranteed fresh past
boot time — the starter above never keeps a client alive past the one snapshot fetch.

```java
@Configuration
class EnvpitConfig {

  @Bean(destroyMethod = "close")
  EnvpitClient envpit() {
    return EnvpitClient.builder().load();   // blocks during context startup — a bad key fails the boot, fast
  }
}
```

Inject `EnvpitClient` anywhere. There is no static singleton — the client is a normal bean with a
normal lifecycle (`close()` runs on context shutdown via `destroyMethod`). This works with or
without `envpit-spring-boot-starter` on the classpath — the two approaches don't conflict (the
starter never registers an `EnvpitClient` bean itself).

## API

```java
EnvpitClient envpit = EnvpitClient.builder()
    .apiKey(...)                      // optional — falls back to the ENVPIT_API_KEY environment variable
    .host("https://envpit.com")       // default shown; override for self-hosted/local dev
    .pollInterval(Duration.ofSeconds(60))  // 0 disables ALL background refresh, including realtime
    .timeout(Duration.ofSeconds(5))
    .httpClient(myHttpClient)         // optional — override java.net.http.HttpClient (test/injection seam)
    .logger(myEnvpitLogger)           // optional — default: JulEnvpitLogger (java.util.logging, visible on stderr)
    .load();                          // TERMINAL — the only way to obtain a client; no public build()

String dbUrl = envpit.get("DATABASE_URL");             // throws MissingKeyException if absent
String dbUrl2 = envpit.get("DATABASE_URL", "postgres://local"); // with a default — never throws
int port = envpit.getInt("PORT", 8080);                // throws TypeMismatchException if unparsable
boolean m = envpit.getBoolean("MAINTENANCE_MODE", false); // true/1/yes/on, false/0/no/off (case-insensitive)

Subscription sub = envpit.onChange(event -> ...);      // ChangeListener — key names only, sorted
envpit.onConnection(event -> ...);                      // ConnectionListener
envpit.onError(event -> ...);                           // ErrorListener — always a typed EnvpitException

CacheInfo info = envpit.cacheInfo();                    // fetchedAt / age / lastError / etag / refreshMode / ...
sub.close();                                            // Subscription extends AutoCloseable
envpit.close();                                         // EnvpitClient extends AutoCloseable — stops all background work
```

The builder's terminal method is `load()` — there is deliberately no public `build()`. This means
there is no reachable state where you hold a client that hasn't completed its first fetch: `load()`
either returns a fully-ready client or throws.

Listener invocation happens on a single shared daemon dispatch thread — keep listeners fast; hand
off heavy work to your own executor. A throwing listener is caught, logged, and never prevents any
other registered listener from running (and never crashes your application) — but this SDK
deliberately does **not** catch `Error` (e.g. `OutOfMemoryError`, `StackOverflowError`): only
`Exception` subtypes are safety-wrapped, so a genuinely fatal JVM condition still propagates.

## Errors

Every SDK exception extends `com.envpit.EnvpitException` (unchecked — `RuntimeException`):

| Class | When |
|---|---|
| `AuthenticationException` | No API key found, or the server rejected it (HTTP 401/403) |
| `NetworkException` | DNS/connect/timeout, a connection reset, a non-2xx response, or an invalid/oversized response |
| `MissingKeyException` | `get*()` called for a key that isn't set and no default was given (`getKey()`) |
| `TypeMismatchException` | `getInt`/`getBoolean` couldn't parse the stored value (`getKey()`, `getExpectedType()`, `getRawValue()`) |

```java
try {
    int port = envpit.getInt("PORT");
} catch (MissingKeyException e) {
    ...
} catch (EnvpitException e) {   // catch-all
    ...
}
```

No config value or API key ever appears in an error message or log line (one narrow, documented
exception: `TypeMismatchException` echoes the offending raw value itself via `getRawValue()`, e.g.
`got "abc"` in the message — that value is what you passed to a typed getter, never a secret by
construction of the typed-getter path).

## Caching & resilience

- Memory-only. Nothing is ever written to disk — no cache file, no temp file. `java.net.http.HttpClient`
  has no disk response cache by construction.
- Stale-while-revalidate: a background refresh failure never throws from `get*()` — the last good
  snapshot keeps serving reads, and the failure is recorded on `cacheInfo()` and reported to
  `onError` listeners.
- Realtime push (SSE) is an optimization; the poll-interval timer is always the correctness
  backstop, independent of the realtime channel's health. `pollInterval` of zero (or negative)
  disables ALL background refresh, including realtime.
- A single daemon dispatch thread (poll ticks, refresh coalescing, and listener delivery all funnel
  through it) plus one daemon realtime-connection thread — neither keeps your JVM alive.
  `close()` cancels every scheduled task and cleanly shuts down the dispatch executor
  (bounded `awaitTermination`, falling back to `shutdownNow()`) before returning.

## Security notes

- Auth is sent as `X-Api-Key`, never `Authorization` — a separate trust boundary from any session
  auth your app has.
- No SDK option exists to skip TLS verification. `java.net.http.HttpClient` verifies certificates
  by default; this SDK never disables that. (If you inject your own `HttpClient` via `.httpClient(...)`,
  its TLS posture is entirely your own responsibility.)
- `toString()` on `EnvpitClient`, `RealtimeTransport`, and the internal config snapshot never
  includes the API key or any config value — both are always shown redacted
  (`apiKey=<redacted>`, `values=<redacted>`).
- Response bodies are byte-capped (5 MiB default) and realtime stream lines are byte-capped
  (64 KiB default) so a misbehaving or compromised server can't exhaust client memory.
- The hand-rolled internal JSON parser enforces an explicit nesting-depth cap (32 levels) — it is a
  recursive-descent parser and, unlike this SDK's other-language JSON engines, is
  recursion-vulnerable by construction without that cap.

## Requirements

Java 17+. Zero runtime dependencies — `java.net.http.HttpClient` + a small internal JSON parser
only. JUnit 5 is a test-scope-only dependency; it is never part of the published artifact.
