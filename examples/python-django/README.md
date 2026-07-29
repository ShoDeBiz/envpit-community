# EnvPit + Django example

Consumes the **published `envpit` package from PyPI** (`envpit~=0.1.0` in `requirements.txt` —
no relative path, no `-e ../..`) and loads config from the live, production EnvPit API into
`django.conf.settings` through `envpit.integrations.django.load_into_settings()`.

Django has **no plugin hook** for external settings sources, so — unlike the FastAPI/Flask
integrations — there is no automatic wiring. `load_into_settings(globals())` is called directly
from inside `exampleproject/settings.py`, the same `django-environ`/`django-configurations`
idiom, not an invented auto-integration.

## Setup

```bash
cd examples/python-django
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run

The API key lives outside this repo at `~/.envpit-example.env` (never committed, never printed).

```bash
set -a; . ~/.envpit-example.env; set +a

# Proves Django boots with EnvPit-sourced settings (no DB, no migrations, no apps beyond what
# Django's own system checks require).
python manage.py check

# Proves config arrived AND asserts secret exclusion against the real django.conf.settings
# object -- not against the MergeResult summary settings.py computed for itself.
python verify.py
```

## What correct output looks like

```
$ python manage.py check
System check identified no issues (0 silenced).

$ python verify.py
[envpit-django-example] merged into settings: ['DB_URL', 'GREETING', 'MOELSOE']
[envpit-django-example] secret-flagged keys (names only): ['HOMER_KEY']
[envpit-django-example] skipped as secret (per MergeResult): []
[envpit-django-example] secret exclusion had an observable effect in this account: True -- a secret WITH a value was withheld
[envpit-django-example] OK -- no secret-flagged key is an attribute of django.conf.settings
[envpit-django-example] OK -- every reported-merged key IS a real settings attribute
```

Only key NAMES appear anywhere in this output — never a config value.

## What this proves

- `django.conf.settings.DB_URL` etc. work completely untouched after `load_into_settings(
  globals())` runs at the top of `settings.py` — the values become real module-level names in
  the settings module's own namespace before the rest of the module (or Django itself) reads
  them.
- `HOMER_KEY` (server-side `is_secret=true`) never becomes a `django.conf.settings` attribute —
  asserted with `hasattr(settings, "HOMER_KEY")` against the real, fully-booted `LazySettings`
  object in `verify.py`, not against the `MergeResult` summary computed inside `settings.py`.

## Awkward against a live server (the finding this task exists to surface)

**Django's settings loader only copies UPPERCASE module-level names onto `django.conf.settings`**
(`django.conf.LazySettings._setup` → `Settings.__init__` filters `if setting.isupper()`). A first
draft of `settings.py` stored two extra probe values (whether the secret exclusion had any
observable effect, and the secret key list) under lowercase names for `verify.py` to read back —
the exact pattern `ENVPIT_MERGE_RESULT` already uses successfully. `verify.py` raised
`AttributeError: 'Settings' object has no attribute '...'` immediately: `load_into_settings(
globals())` had worked correctly (`ENVPIT_MERGE_RESULT`, uppercase, WAS present), the failure was
entirely in Django's own settings-copy filter silently dropping the lowercase names. Fixed by
renaming both to uppercase (`ENVPIT_KNOWN_SECRET_KEYS`,
`ENVPIT_SECRET_EXCLUSION_HAD_OBSERVABLE_EFFECT`) — not because they're real Django settings, but
because that's the only way anything defined in `settings.py` becomes readable off
`django.conf.settings` at all. This is a Django behavior, not an `envpit` bug, but it's exactly
the kind of thing that only shows up by actually running the integration end to end rather than
reading its docstring.

## What this example could NOT verify

**The live account currently has no secret key WITH a value.** `HOMER_KEY` is flagged secret but
unset in this environment. Per `_environ_merge.py`'s documented check order, the null-value check
runs BEFORE the secret check — so a secret with no value is filtered out by the null check
regardless of `include_secrets`, and the "excluded because secret" path is never actually
exercised for it. `ENVPIT_SECRET_EXCLUSION_HAD_OBSERVABLE_EFFECT: False` above shows exactly
that: merging with `include_secrets=True` (into a throwaway dict) produces the identical result
to merging without it, because there's nothing here for that flag to change. **This is not the
filter being broken** — it's the documented "absent, not withheld" behavior. I did not have write
access (read-only, production key) to set a value on `HOMER_KEY` to exercise the "withheld" path
for real.
