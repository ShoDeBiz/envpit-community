# EnvPit — Python SDK

Official Python SDK for [EnvPit](https://envpit.com) — configuration & secrets management
without enterprise complexity.

## Quickstart

The fastest way in: make your EXISTING `os.environ`-reading code work untouched — no client
object, no new API to learn.

```bash
pip install envpit
export ENVPIT_API_KEY="epk_..."   # an environment-pinned key: Project → API Keys → New key
```

```python
import envpit
import os

envpit.load().populate_environ()        # fetch once, merge into os.environ (opt-in, explicit)
print(os.environ["DATABASE_URL"])        # your existing os.environ-reading code, unmodified
```

`populate_environ()` never overwrites a variable your platform already set (same precedence as
`python-dotenv`) — pass `override=True` if EnvPit values should win instead. It's a **one-shot,
boot-time snapshot**: EnvPit's realtime refresh updates the client's own in-memory values
immediately, but can't retroactively update `os.environ` (nothing can — this is true of
`os.environ`/Spring `@Value` in every language, not an EnvPit limitation). Code that needs
guaranteed-live values should read through the client instead — see "Client API" below.

**Secrets are excluded by default.** The server labels each config key `is_secret=true`/`false`
(bd:envpit-durd); `populate_environ()` reads that flag and skips every secret-flagged key unless
you pass `include_secrets=True` — the zero-argument call is the safe one. Env vars are inherited
by every child process, are often serialized into crash dumps/APM/`/proc/<pid>/environ`, and are
logged by some startup scripts, so opting a whole environment's secrets into `os.environ` is a
real exposure — naming `include_secrets=True` at the call site is the acknowledgment of that.
`only=`/`exclude=` additionally narrow the merge by name (an allowlist/denylist, mirroring the Go
SDK's `WithOnly`/`WithExclude`) — neither can pull a secret through without `include_secrets=True`
also being set.

```python
result = envpit.load().populate_environ(
    override=False,          # default: existing os.environ values always win
    include_secrets=False,   # default: server-flagged secret keys are never merged
    exclude={"LEGACY_KEY"},  # keep specific non-secret keys out too, by name
)
result.merged            # sorted tuple of key NAMES actually written
result.skipped_existing  # sorted tuple of key NAMES left alone (already present, no override)
result.skipped_secrets   # sorted tuple of key NAMES excluded because they're secret-flagged
```

### Client API (in-memory reads, no `os.environ`)

```python
import envpit

client = envpit.load()                  # fetches your environment's config once (blocking)
print(client.get("DATABASE_URL"))       # in-memory read — never a network call
```

Run it — you should see your value printed. That's it: `client.get()` reads from memory; the
snapshot auto-refreshes in the background.

Using FastAPI or another asyncio app? `load()` only blocks once, at startup — call it in your
lifespan/startup hook, or use `await asyncio.to_thread(envpit.load)` if you'd rather not block
the loop even there. Every read after that is a plain in-memory lookup.

### Framework integrations

Each framework gets the mechanism its own developers actually expect (bd:envpit-yvyr) — not one
generic API forced onto all three.

**FastAPI — Pydantic Settings** (`pip install envpit[fastapi]`). FastAPI's real idiom is
`pydantic_settings.BaseSettings`, not `os.environ` — `EnvpitSettingsSource` is a genuine
`PydanticBaseSettingsSource`, wired via `settings_customise_sources()`:

```python
from pydantic_settings import BaseSettings
from envpit.integrations.fastapi import EnvpitSettingsSource

class Settings(BaseSettings):
    database_url: str
    port: int = 8080

    @classmethod
    def settings_customise_sources(cls, settings_cls, init_settings, env_settings,
                                    dotenv_settings, file_secret_settings):
        return (EnvpitSettingsSource(settings_cls), init_settings, env_settings,
                dotenv_settings, file_secret_settings)

settings = Settings()   # database_url/port resolved from EnvPit, case-insensitive, env_prefix honored
```

**Flask — `app.config`** (`pip install envpit[flask]`):

```python
from flask import Flask
from envpit.integrations.flask import init_app

app = Flask(__name__)
init_app(app)   # merges the EnvPit snapshot into app.config
```

**Django — `settings.py`, no extra install.** Django has no plugin hook for external settings
sources (verified — its settings loader just imports `settings.py` as a plain module); the
accepted idiom (the one `django-environ` also uses) is populating values at the top of the file,
before the rest of it reads them:

```python
# settings.py
import envpit
from envpit.integrations.django import load_into_settings

load_into_settings(globals(), client=envpit.load())

DEBUG = DEBUG == "true"   # every EnvPit value is a string — typed post-processing is yours
```

All three integrations share `populate_environ()`'s precedence rules (existing value wins unless
`override=True`) and its secret-exclusion default: server-flagged secrets are excluded unless
`include_secrets=True` is passed to `init_app()`/`load_into_settings()`. FastAPI's
`EnvpitSettingsSource` follows the same default via its own `include_secrets=True` constructor
argument (an excluded secret field simply falls back to that field's own default, same as an
absent key).

## API

```python
import envpit
from envpit import EnvpitClient

client = EnvpitClient.load(
    api_key=None,        # falls back to the ENVPIT_API_KEY environment variable
    host=None,            # default: https://envpit.com
    poll_interval=60.0,   # seconds; 0 disables ALL background refresh, including realtime
    timeout=5.0,           # seconds, per request
    logger=None,           # a stdlib logging.Logger, or any object exposing a subset of
                            # debug/info/warn/error — absent = silent
)

client.get("DATABASE_URL")                      # str; raises MissingKeyError if absent
client.get("DATABASE_URL", "postgres://local")  # str with a default — never raises
client.get_int("PORT", 8080)                     # int; raises TypeMismatchError if unparsable
client.get_bool("MAINTENANCE_MODE", False)       # bool: true/1/yes/on, false/0/no/off (ci)
client.get_optional("PORT")                      # str | None — the only getter that never raises

client.snapshot()                                # dict[str, str | None] — defensive copy, in-memory only (values only)
client.known_secret_keys()                       # frozenset[str] — server-flagged secret key NAMES only
client.populate_environ(                         # see Quickstart above; returns a MergeResult
    override=False, include_secrets=False, only=None, exclude=None, environ=None,
)

unsubscribe = client.on_change(lambda event: ...)   # event: ChangeEvent (key names only)
client.on_connection(lambda event: ...)             # event: ConnectionEvent
client.on_error(lambda event: ...)                  # event: an EnvpitError subclass instance

client.cache_info   # CacheInfo — fetched_at / age_ms / last_error / etag / refresh_mode / ...
client.close()       # stops background refresh; also a context manager:
with EnvpitClient.load() as client:
    ...
```

The module-level `envpit.load()` sets a default instance so `envpit.get(...)` /
`envpit.get_int(...)` / `envpit.on_change(...)` etc. delegate to it — convenience sugar over the
same client class shown above.

Listener registration only accepts plain (sync) callables — an `async def` callback raises a
`TypeError` immediately at registration, with a message telling you how to bridge it
(`asyncio.run_coroutine_threadsafe`). This is deliberate: a sync dispatcher silently never
awaiting your coroutine would otherwise fail invisibly.

## Errors

Every SDK error is a subclass of `envpit.EnvpitError`:

| Class | When |
|---|---|
| `AuthenticationError` | No API key found, or the server rejected it (HTTP 401/403) |
| `NetworkError` | DNS/connect/timeout, a non-2xx response, or an invalid/oversized response |
| `MissingKeyError` | `get*()` called for a key that isn't set and no default was given (`.key`) |
| `TypeMismatchError` | `get_int`/`get_bool` couldn't parse the stored value (`.key`, `.expected_type`) |

```python
try:
    port = client.get_int("PORT")
except envpit.MissingKeyError as e:
    ...
except envpit.EnvpitError as e:   # catch-all
    ...
```

No config value or API key ever appears in an error message or log line (one narrow, documented
exception: `TypeMismatchError` echoes the offending raw value itself, e.g. `got "abc"` — that
value is what you passed to a typed getter, never a secret by construction of the typed-getter
path).

## Caching & resilience

- Memory-only. Nothing is ever written to disk — no cache file, no temp file, no pickle/shelve.
- Stale-while-revalidate: a background refresh failure never raises from `get*()` — the last
  good snapshot keeps serving reads, and the failure is recorded on `client.cache_info`.
- Realtime push (SSE) is an optimization; the `poll_interval` timer is always the correctness
  backstop, independent of the realtime channel's health.
- One daemon poll thread + one daemon realtime thread — neither keeps your process alive.

## Security notes

- Auth is sent as `X-Api-Key`, never `Authorization` — a separate trust boundary from any
  session auth your app has.
- No SDK option exists to skip TLS verification. Python's `urllib` verifies certificates by
  default; this SDK never disables that.
- `repr(client)`/`str(client)`/`print(client)` never include the API key or any config value —
  both are always shown redacted.
- Response bodies and realtime stream lines are size-capped (5 MiB / 64 KiB respectively) so a
  misbehaving or compromised server can't exhaust client memory.
- The config-resolve response must be the post-bd:envpit-durd `{values, secretKeys}` envelope —
  a pre-durd bare `{key: value}` map is rejected as a `NetworkError`, not silently accepted (it
  would otherwise read as "no secrets here" and merge production secrets while reporting none
  excluded). There were zero published SDK releases before this shape shipped, so this only
  matters if you're pointed at a very old self-hosted EnvPit server.

## Requirements

Python ≥ 3.10. Zero runtime dependencies — stdlib `urllib`/`json`/`threading`/`hashlib` only.
`envpit.integrations.*` is opt-in and never imported by the core package: `envpit.integrations.
fastapi` needs `pip install envpit[fastapi]` (pydantic-settings), `envpit.integrations.flask`
needs `pip install envpit[flask]` (flask); `envpit.integrations.django` needs no extra install.
