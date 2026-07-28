"""FastAPI integration (bd:envpit-yvyr) — FastAPI's actual "native mechanism" is Pydantic
Settings (`pydantic_settings.BaseSettings`), NOT a raw `os.environ` merge; this is the one
framework integration that is genuinely something other than `populate_environ()` wearing a
different hat. `EnvpitSettingsSource` is a real `pydantic_settings.PydanticBaseSettingsSource`
subclass, wired the documented way — verified against the installed `pydantic-settings==2.14.2`
package (`PydanticBaseSettingsSource.__init__`/`get_field_value`/`prepare_field_value`,
`BaseSettings.settings_customise_sources`'s signature) rather than guessed from general Pydantic
knowledge.

Requires `pydantic-settings` installed (`pip install envpit[fastapi]`) — this module is never
imported by the core `envpit` package, so this is the only place that dependency is needed; a
missing install raises a clear, actionable `ImportError` below rather than a bare
`ModuleNotFoundError` deep in `pydantic_settings` internals.

Usage:
    from pydantic_settings import BaseSettings
    from envpit.integrations.fastapi import EnvpitSettingsSource

    class Settings(BaseSettings):
        database_url: str
        port: int = 8080

        @classmethod
        def settings_customise_sources(cls, settings_cls, init_settings, env_settings,
                                        dotenv_settings, file_secret_settings):
            # EnvPit first; falls through to real env vars / .env / init kwargs otherwise.
            return (EnvpitSettingsSource(settings_cls), init_settings, env_settings,
                    dotenv_settings, file_secret_settings)
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from ..client import EnvpitClient

try:
    from pydantic_settings import PydanticBaseSettingsSource
except ImportError as exc:  # pragma: no cover - exercised via a sys.modules-block test
    raise ImportError(
        "envpit.integrations.fastapi requires the 'pydantic-settings' package. Install it with "
        "`pip install envpit[fastapi]` (or `pip install pydantic-settings` directly)."
    ) from exc

if TYPE_CHECKING:
    from pydantic.fields import FieldInfo
    from pydantic_settings import BaseSettings


class EnvpitSettingsSource(PydanticBaseSettingsSource):
    """A Pydantic Settings source backed by an `EnvpitClient` snapshot. Field matching is
    case-insensitive (same convention as pydantic-settings' own `EnvSettingsSource`) and honors
    `model_config["env_prefix"]` if the `Settings` class sets one. Complex fields (`list`/`dict`/
    nested models) are JSON-decoded via the inherited `prepare_field_value()` — the exact same
    mechanism `EnvSettingsSource` itself uses, not a reimplementation.

    A field absent from the snapshot resolves to `None` here, which pydantic-settings then falls
    through to that field's own default (or raises `ValidationError` if the field is required) —
    the same "no value found" contract every other settings source in the chain follows.

    Secrets are EXCLUDED BY DEFAULT (bd:envpit-durd, AC-SEC-E11 — same default posture as
    `EnvpitClient.populate_environ()`/the `flask`/`django` integrations): a field whose matching
    key is flagged `is_secret=true` server-side resolves as "not found" here, which
    pydantic-settings then falls through to for a caller who wants secrets available through
    `Settings` fields at all."""

    def __init__(
        self,
        settings_cls: type[BaseSettings],
        client: EnvpitClient | None = None,
        include_secrets: bool = False,
    ) -> None:
        super().__init__(settings_cls)
        self._client = client
        self._include_secrets = include_secrets
        self._env_prefix = str(self.config.get("env_prefix") or "").upper()

    def _resolved_client(self) -> EnvpitClient:
        if self._client is not None:
            return self._client
        from .. import _require_default

        return _require_default()

    def get_field_value(self, field: FieldInfo, field_name: str) -> tuple[Any, str, bool]:
        target_key = self._env_prefix + field_name.upper()
        client = self._resolved_client()
        for key, value in client.snapshot().items():
            if key.upper() == target_key:
                if not self._include_secrets and key in client.known_secret_keys():
                    return None, field_name, False
                return value, field_name, False
        return None, field_name, False

    def __call__(self) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for field_name, field in self.settings_cls.model_fields.items():
            value, key, value_is_complex = self.get_field_value(field, field_name)
            if value is None:
                continue
            result[key] = self.prepare_field_value(field_name, field, value, value_is_complex)
        return result
