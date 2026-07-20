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

### Using Spring? Register it as a bean

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
normal lifecycle (`close()` runs on context shutdown via `destroyMethod`).

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
