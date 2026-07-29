"""Flask example — consumes the PUBLISHED `envpit` package from PyPI and talks to the real,
production EnvPit API through `envpit.integrations.flask.init_app()`, which merges the resolved
snapshot straight into `app.config` — Flask's own idiom for programmatic config (see that
module's docstring).

Why this exists: every test behind `init_app()` mocks the transport. This file is the first time
it has ever talked to a real server.

Run:
    set -a; . ~/.envpit-example.env; set +a
    flask --app app run --port 8002
"""

from __future__ import annotations

import os

import envpit
from envpit.integrations.flask import init_app
from flask import Flask, jsonify

app = Flask(__name__)

# The SDK auto-reads ENVPIT_API_KEY from the environment, but NOT ENVPIT_HOST (verified against
# `client.py` — only the API key has that env-var convenience). Passed through explicitly here.
_client = envpit.load(host=os.environ.get("ENVPIT_HOST"), poll_interval=0)
_merge_result = init_app(app, client=_client)

# --- Explicit demonstration: secret-flagged keys did NOT reach app.config -------------------
#
# Asserted against the REAL `app.config` mapping (a dict subclass) — not the returned
# `MergeResult` summary, which could itself be wrong.
_secret_keys = _client.known_secret_keys()
_leaked = [k for k in _secret_keys if k in app.config]
assert not _leaked, f"FAIL: secret-flagged keys reached app.config: {_leaked}"

# A second, throwaway app merged WITH include_secrets=True isolates whether the exclusion did
# anything observable in THIS account right now — see README for why this comes back empty here
# (HOMER_KEY currently has no value: the null check runs before the secret check).
_probe_app = Flask(f"{__name__}-secret-probe")
_merge_result_with_secrets = init_app(_probe_app, client=_client, include_secrets=True)
_secret_exclusion_had_an_effect = bool(set(_secret_keys) & set(_merge_result_with_secrets.merged))

print("[envpit-flask-example] merged into app.config:", list(_merge_result.merged))
print("[envpit-flask-example] secret-flagged keys (names only):", sorted(_secret_keys))
print("[envpit-flask-example] skipped as secret:", list(_merge_result.skipped_secrets))
print(
    "[envpit-flask-example] secret exclusion had an observable effect in this account:",
    _secret_exclusion_had_an_effect,
    "(expected False here -- HOMER_KEY currently has no value; see README)",
)


@app.get("/config-check")
def config_check():
    """Key NAMES only in the response — never a config VALUE over HTTP."""
    return jsonify(
        {
            "app_config_keys_merged": list(_merge_result.merged),
            "secret_flagged_keys": sorted(_secret_keys),
            "any_secret_key_in_app_config": bool([k for k in _secret_keys if k in app.config]),
            "secret_exclusion_had_observable_effect": _secret_exclusion_had_an_effect,
        }
    )
