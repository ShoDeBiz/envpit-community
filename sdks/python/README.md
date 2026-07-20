# EnvPit — Python SDK

Official Python SDK for [EnvPit](https://envpit.com) — configuration & secrets management
without enterprise complexity.

## Quickstart

```bash
pip install envpit
export ENVPIT_API_KEY="epk_..."   # an environment-pinned key: Project → API Keys → New key
```

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

## Requirements

Python ≥ 3.10. Zero runtime dependencies — stdlib `urllib`/`json`/`threading`/`hashlib` only.
