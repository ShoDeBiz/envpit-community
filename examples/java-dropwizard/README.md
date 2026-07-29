# EnvPit + Dropwizard example

Consumes the **published** `com.envpit:envpit-sdk:0.1.0` from Maven Central and resolves config
from a real EnvPit production API, exposing the resolved key **names** via a Jersey resource and a
Dropwizard `HealthCheck` — with server-flagged secret keys verified absent from the framework's
own `Configuration` object.

## Why the shape is different from the Spring example

Dropwizard has no Spring-style relaxed-binding `Environment`/property-source merge system — config
normally comes *only* from YAML deserialized into a `Configuration` subclass. There is no
equivalent of `@Value`/`Environment` to point at, so "the framework's configuration" here means
Dropwizard's own [`Configuration`](https://www.dropwizard.io/en/stable/manual/core.html#configuration)
object — the one instance `run(Configuration, Environment)` receives and Dropwizard keeps for the
life of the app.

[`EnvpitExampleConfiguration`](src/main/java/com/envpit/example/dropwizard/EnvpitExampleConfiguration.java)
carries a `Map<String, String> envpitConfig` field that is **never** deserialized from YAML (no
mapping for it exists in `config.yml`, and the API key is never written into any file — read
straight from `ENVPIT_API_KEY`/`ENVPIT_HOST` OS env vars). It is populated **programmatically**,
once, in [`EnvpitDropwizardExampleApplication#run`](src/main/java/com/envpit/example/dropwizard/EnvpitDropwizardExampleApplication.java),
from a real `EnvpitClient` snapshot fetched against the live server.

## Run

```bash
set -a; . ~/.envpit-example.env; set +a
cd examples/java-dropwizard
mvn -DskipTests package
java -jar target/envpit-example-dropwizard-1.0.0.jar server config.yml
```

In another terminal:

```bash
curl -s http://localhost:18080/config-keys
curl -s http://localhost:18081/healthcheck
```

Stop with `Ctrl-C` (or `pkill -f envpit-example-dropwizard-1.0.0.jar`).

## What correct output looks like

Startup log:

```
[envpit] resolved 4 config key(s) from https://envpit.com (key NAMES only): [DB_URL, GREETING, HOMER_KEY, MOELSOE]
[envpit] server-flagged secret key(s) — excluded from the Configuration object by default: [HOMER_KEY]
[envpit] contributed 3 key(s) to the Dropwizard Configuration object: [DB_URL, GREETING, MOELSOE]
INFO  [...] io.dropwizard.core.server.ServerFactory: Starting envpit-example-dropwizard
...
INFO  [...] io.dropwizard.jersey.DropwizardResourceConfig: The following paths were found for the configured resources:

    GET     /config-keys (com.envpit.example.dropwizard.ConfigKeysResource)

...
INFO  [...] org.eclipse.jetty.server.Server: Started Server@...[11.0.26,sto=30000] @1224ms
```

`GET /config-keys` (port `18080`):

```json
["DB_URL","GREETING","MOELSOE"]
```

`GET /healthcheck` (admin port `18081`):

```json
{
  "deadlocks": {"healthy": true, ...},
  "envpit-secret-filter": {
    "healthy": true,
    "message": "none of 1 independently re-fetched secret-flagged key(s) [HOMER_KEY] are present in the framework's Configuration object",
    ...
  }
}
```

### Reading this output

- **`HOMER_KEY`** never appears in `/config-keys` — it's the one server-flagged secret key in this
  environment.
- **`envpit-secret-filter: healthy`** is not trusting the exclusion the app already did at boot —
  see below.
- **A secret with no value in the environment is "absent," not "withheld."** If a secret-flagged
  key currently has no value, it never enters the snapshot at all, so it can't be "withheld"
  either — the health check reports that case explicitly instead of implying the filter failed.
- Every line prints key *names* only — never a config value, never the API key.

## How the secret-filter check works (and why it's not "just trust the summary")

[`EnvpitSecretFilterHealthCheck`](src/main/java/com/envpit/example/dropwizard/EnvpitSecretFilterHealthCheck.java)
does **not** reuse the excluded-key set `EnvpitDropwizardExampleApplication#run` already computed
once at boot. Every time Dropwizard runs this health check (on-demand via `/healthcheck`, or on its
own internal schedule) it opens a **fresh, independent** `EnvpitClient` against the live server,
re-derives `knownSecretKeys()` from scratch, and checks each one directly against
`configuration.getEnvpitConfig().containsKey(...)` — the real Dropwizard `Configuration` object the
app is actually running with, not a returned merge-summary string.

## Files

| File | Role |
|---|---|
| `pom.xml` | Depends on `com.envpit:envpit-sdk:0.1.0` (Central) + `dropwizard-core` 4.0.17; builds a shaded jar |
| `config.yml` | Minimal server config — no API key, no EnvPit values, no database |
| `EnvpitExampleConfiguration.java` | The framework's `Configuration` object, carrying the programmatically-populated `envpitConfig` map |
| `EnvpitDropwizardExampleApplication.java` | Boot-time `EnvpitClient.load()` + wiring |
| `ConfigKeysResource.java` | `GET /config-keys` — key names only |
| `EnvpitSecretFilterHealthCheck.java` | Independent re-verification against the real `Configuration` object |

## What I could not verify

- Long-running realtime/poll behavior — this example uses `pollInterval(Duration.ZERO)` (a
  boot-time snapshot only, matching the Spring example's posture and Dropwizard's own
  request/response lifecycle, which has no natural place to hold a live subscription open the way
  the SDK's `onChange()` callback needs). A config change made after boot will not appear until the
  process is restarted.
