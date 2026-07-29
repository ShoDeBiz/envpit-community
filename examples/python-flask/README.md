# EnvPit + Flask example

Consumes the **published `envpit` package from PyPI** (`envpit[flask]~=0.1.0` in
`requirements.txt` — no relative path, no `-e ../..`) and populates `app.config` from the live,
production EnvPit API through `envpit.integrations.flask.init_app()`.

## Setup

```bash
cd examples/python-flask
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run

The API key lives outside this repo at `~/.envpit-example.env` (never committed, never printed).

```bash
set -a; . ~/.envpit-example.env; set +a
PYTHONUNBUFFERED=1 flask --app app run --port 8002
```

## What correct output looks like

Startup log (module-level, runs once on import):

```
[envpit-flask-example] merged into app.config: ['DB_URL', 'GREETING', 'MOELSOE']
[envpit-flask-example] secret-flagged keys (names only): ['HOMER_KEY']
[envpit-flask-example] skipped as secret: []
[envpit-flask-example] secret exclusion had an observable effect in this account: False (expected False here -- HOMER_KEY currently has no value; see below)
```

Then, in another terminal:

```bash
curl -s http://127.0.0.1:8002/config-check
```

```json
{"any_secret_key_in_app_config":false,"app_config_keys_merged":["DB_URL","GREETING","MOELSOE"],"secret_exclusion_had_observable_effect":false,"secret_flagged_keys":["HOMER_KEY"]}
```

Only key NAMES appear anywhere in this output — never a config value.

## What this proves

- `app.config['DB_URL']` etc. work completely untouched — `init_app(app)` is a plain merge into
  Flask's own `dict`-subclass config, the same shape any other Flask extension's `init_app(app)`
  hook takes.
- `HOMER_KEY` (server-side `is_secret=true`) never reaches `app.config` — asserted directly
  against the real `app.config` mapping (`k in app.config`), not against the `MergeResult`
  summary `init_app()` returns, which could itself be wrong.

## What this example could NOT verify

**The live account currently has no secret key WITH a value.** `HOMER_KEY` is flagged secret but
unset in this environment. Per `_environ_merge.py`'s documented check order, the null-value check
runs BEFORE the secret check — so a secret with no value is filtered out by the null check
regardless of `include_secrets`, and the "excluded because secret" path is never actually
exercised for it. The `secret_exclusion_had_observable_effect: false` field above shows exactly
that: merging with `include_secrets=True` produces the identical result to merging without it,
because there's nothing here for that flag to change. **This is not the filter being broken** —
it's the documented "absent, not withheld" behavior; see `_environ_merge.py`'s own module
docstring. I did not have write access (read-only, production key) to set a value on `HOMER_KEY`
to exercise the "withheld" path for real.
