# EnvPit + FastAPI example

Consumes the **published `envpit` package from PyPI** (`envpit[fastapi]~=0.1.0` in
`requirements.txt` — no relative path, no `-e ../..`) and resolves a real `pydantic_settings.
BaseSettings` class from the live, production EnvPit API through
`envpit.integrations.fastapi.EnvpitSettingsSource`.

## Setup

```bash
cd examples/python-fastapi
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run

The API key lives outside this repo at `~/.envpit-example.env` (never committed, never printed).

```bash
set -a; . ~/.envpit-example.env; set +a
PYTHONUNBUFFERED=1 uvicorn main:app --port 8001
```

`PYTHONUNBUFFERED=1` just makes the startup print lines show up immediately instead of waiting
on Python's stdout buffer when uvicorn isn't attached to a TTY — cosmetic only.

## What correct output looks like

Startup log (module-level, runs once on import — before uvicorn's own "Application startup
complete" line):

```
[envpit-fastapi-example] loaded settings keys: ['db_url', 'greeting', 'moelsoe']
[envpit-fastapi-example] secret-flagged keys (names only): ['HOMER_KEY']
[envpit-fastapi-example] homer_key reached Settings(): False (expected False)
[envpit-fastapi-example] secret exclusion had an observable effect in this account: False (expected False here -- HOMER_KEY currently has no value; see below)
```

Then, in another terminal:

```bash
curl -s http://127.0.0.1:8001/config-check
```

```json
{"settings_keys_loaded":["db_url","greeting","moelsoe"],"secret_flagged_keys":["HOMER_KEY"],"homer_key_reached_settings":false,"secret_exclusion_had_observable_effect":false}
```

Only key NAMES appear anywhere in this output — never a config value.

## What this proves

- `Settings()` — a genuine `pydantic_settings.BaseSettings` subclass — gets its field values from
  a live EnvPit server through `EnvpitSettingsSource`, the way a FastAPI developer actually uses
  Pydantic Settings (`settings_customise_sources`), not a bespoke wrapper.
- `homer_key` (backed by the server-side `is_secret=true`-flagged `HOMER_KEY`) never reaches
  `Settings()` — asserted directly against `EnvpitSettingsSource(...)()`'s raw output dict (the
  actual object pydantic-settings consumes), not against `settings.homer_key is None`, which
  would look identical whether the key were secret-excluded or simply absent.

## What this example could NOT verify

**The live account currently has no secret key WITH a value.** `HOMER_KEY` is flagged secret but
unset in this environment. Per `_environ_merge.py`'s documented check order, the null-value check
(step 3) runs BEFORE the secret check (step 4) — so a secret with no value is filtered out by the
null check regardless of `include_secrets`, and never reaches `skipped_secrets`/the "excluded
because secret" path at all. The `secret_exclusion_had_observable_effect: false` field above is
the honest result of that: calling the source with `include_secrets=True` produces the exact same
output as without it, because there is nothing for that flag to change here. **This does not mean
the secret filter is broken** — `merge_snapshot`'s ordering is intentional and documented, and I
did not have write access to this (read-only, production) API key to set a value on `HOMER_KEY`
and prove the filter blocks a real value. That is the one thing this example demonstrates about
the "absent" key path, not the "withheld" key path — see the SDK's own `_environ_merge.py`
docstring for the distinction.
