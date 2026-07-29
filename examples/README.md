# examples/

Nine runnable apps across four languages and seven frameworks. Every one of them depends on the
**published** package from its real registry — npm, PyPI, the Go module proxy, Maven Central — and
makes a real HTTP call to a real EnvPit server. None uses a workspace link, a `replace` directive,
a `file:` dependency or `pip install -e ../..`.

That constraint is the whole point. Every SDK test in this repository mocks the transport, which
proves the client behaves as designed but says nothing about whether the design matches the
server. Those two diverged once already, when the config-resolve body changed from a bare
`{key: value}` map to `{ values, secretKeys }`. These examples are the cheapest thing that
catches that class of bug, and they found several the day they were written.

| Directory | Language | Framework | Integration point |
|---|---|---|---|
| `node/` | Node | none | `mergeIntoProcessEnv()` |
| `node-express/` | Node | Express | merge before `express()` |
| `node-nestjs/` | Node | NestJS | merge before `app.module` is imported — see its README |
| `python-fastapi/` | Python | FastAPI | `EnvpitSettingsSource` (a real `PydanticBaseSettingsSource`) |
| `python-flask/` | Python | Flask | `init_app()` → `app.config` |
| `python-django/` | Python | Django | `load_into_settings(globals())` in `settings.py` |
| `go-gin/` | Go | Gin | `MergeIntoEnv()` before the router |
| `go-echo/` | Go | Echo | `MergeIntoEnv()` before the router |
| `java-spring-boot/` | Java | Spring Boot | `EnvironmentPostProcessor` → `@Value` / `Environment` |
| `java-dropwizard/` | Java | Dropwizard | populate the framework's own `Configuration` |

## Running any of them

Each directory has its own README with exact commands. All of them read the same two variables:

```bash
export ENVPIT_API_KEY=...          # from Project → API Keys in the dashboard
export ENVPIT_HOST=https://envpit.com   # only if you self-host
```

Keep the key **outside this repository**. A credential inside a working tree eventually gets
committed by someone in a hurry; `.gitignore` covers `.env*` as a backstop, not as permission.

**Use a key scoped to a throwaway environment with fake values.** An EnvPit API key resolves
config *including decrypted secrets*. Every example here prints key NAMES and never values,
precisely because that output ends up in terminals, CI logs and screenshots — hold the same line
in anything you copy from them.

## What each example proves

1. The published package installs and imports.
2. A real resolve call against a real server returns the `{ values, secretKeys }` envelope.
3. Ordinary config reaches the framework's native config surface (`process.env`, `os.Getenv`,
   `app.config`, `django.conf.settings`, Spring's `Environment`) so existing code needs no
   changes — the actual selling point.
4. Secret-flagged keys do **not** reach it, asserted against the live config object rather than
   trusting the SDK's own summary of what it did.

## A caveat you will see in every README

"absent" and "withheld" are different states, and the output has to distinguish them. The merge
checks for a null value *before* it checks the secret flag, so a secret-flagged key with **no
value set in this environment** is skipped as absent and never appears in the skipped-secrets
list. If the environment you point these at has such a key, you will see it named as
secret-flagged and simultaneously see an empty withheld list. That is correct, and it is not the
filter failing — but it reads like failure, which is why every example says so out loud.

It also means: if the only secret in your environment has no value, these examples cannot prove
the filter works. Give it a value first.
