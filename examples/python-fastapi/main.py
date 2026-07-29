"""FastAPI example — consumes the PUBLISHED `envpit` package from PyPI and talks to the real,
production EnvPit API through `envpit.integrations.fastapi.EnvpitSettingsSource`, a genuine
`pydantic_settings.PydanticBaseSettingsSource` (see that module's docstring — verified against
the installed `pydantic-settings` package, not guessed).

Why this exists: every test behind `EnvpitSettingsSource` mocks the transport. This file is the
first time it has ever talked to a real server.

Run:
    set -a; . ~/.envpit-example.env; set +a
    uvicorn main:app --port 8001
"""

from __future__ import annotations

import os

import envpit
from envpit.integrations.fastapi import EnvpitSettingsSource
from fastapi import FastAPI
from pydantic_settings import BaseSettings, PydanticBaseSettingsSource

# The SDK auto-reads ENVPIT_API_KEY from the environment (EnvpitClient.__init__), but NOT
# ENVPIT_HOST — only the API key has that env-var convenience (verified: `client.py` has no
# `os.environ.get("ENVPIT_HOST")` anywhere). Passing it through explicitly here is required to
# actually reach this account's server, not an oversight in the SDK.
_client = envpit.load(host=os.environ.get("ENVPIT_HOST"), poll_interval=0)


class Settings(BaseSettings):
    """Field names are matched case-insensitively against the live EnvPit snapshot's key names
    (`DB_URL`, `GREETING`, `MOELSOE`, `HOMER_KEY`) — see `EnvpitSettingsSource.get_field_value`."""

    db_url: str
    greeting: str
    moelsoe: str
    # HOMER_KEY is flagged secret server-side. Excluded by default (EnvpitSettingsSource's
    # documented posture) -> must stay None. NOTE: in this account HOMER_KEY also currently has
    # NO value set, so this field would be None from the null check alone even if it were not
    # secret-flagged. The `homer_key_would_leak_if_included` check below is the part that
    # actually isolates the secret-exclusion behavior from the "just happens to be unset"
    # behavior — see README "What this example could NOT verify".
    homer_key: str | None = None

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        # EnvPit first; real env vars / .env / init kwargs remain as fallback for anything EnvPit
        # doesn't have -- the documented pattern from the integration's own module docstring.
        return (
            EnvpitSettingsSource(settings_cls, client=_client),
            init_settings,
            env_settings,
            dotenv_settings,
            file_secret_settings,
        )


settings = Settings()

# --- Explicit demonstration: secret-flagged keys did NOT reach the settings object ----------
#
# Asserted against the REAL source object's output, not the `Settings` instance's post-default
# value. `settings.homer_key is None` would be true either way (secret-excluded, or simply
# absent) and proves nothing on its own -- calling the source directly shows the raw dict
# pydantic-settings itself consumed, straight from `EnvpitSettingsSource.__call__`, before any
# field default is applied.
_raw_source_output = EnvpitSettingsSource(Settings, client=_client)()
assert "homer_key" not in _raw_source_output, "FAIL: secret-flagged key leaked into settings source output"

# A second run, explicitly opting IN to secrets, isolates whether that exclusion did anything at
# all in THIS account right now -- see README for why this comes back empty here.
_raw_source_with_secrets = EnvpitSettingsSource(Settings, client=_client, include_secrets=True)()
_secret_exclusion_had_an_effect = "homer_key" in _raw_source_with_secrets

print("[envpit-fastapi-example] loaded settings keys:", sorted(_raw_source_output.keys()))
print("[envpit-fastapi-example] secret-flagged keys (names only):", sorted(_client.known_secret_keys()))
print(
    "[envpit-fastapi-example] homer_key reached Settings():",
    settings.homer_key is not None,
    "(expected False)",
)
print(
    "[envpit-fastapi-example] secret exclusion had an observable effect in this account:",
    _secret_exclusion_had_an_effect,
    "(expected False here -- HOMER_KEY currently has no value; see README)",
)

app = FastAPI()


@app.get("/config-check")
def config_check() -> dict:
    """Key NAMES only in the response -- never a config VALUE over HTTP."""
    return {
        "settings_keys_loaded": sorted(_raw_source_output.keys()),
        "secret_flagged_keys": sorted(_client.known_secret_keys()),
        "homer_key_reached_settings": settings.homer_key is not None,
        "secret_exclusion_had_observable_effect": _secret_exclusion_had_an_effect,
    }
