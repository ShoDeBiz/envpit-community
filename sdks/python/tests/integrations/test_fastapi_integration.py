"""bd:envpit-yvyr — FastAPI's actual idiom is Pydantic Settings (`pydantic_settings.BaseSettings`
+ `settings_customise_sources()`), NOT a raw `os.environ` merge. `EnvpitSettingsSource` is a real
`pydantic_settings.PydanticBaseSettingsSource` subclass, wired the documented way (verified
against the installed `pydantic-settings==2.14.2` — `PydanticBaseSettingsSource.__init__`/
`get_field_value`/`prepare_field_value`/`BaseSettings.settings_customise_sources` signatures read
directly from the installed package, not guessed)."""

from __future__ import annotations

import sys

import pytest

pydantic_settings = pytest.importorskip("pydantic_settings")

from envpit.integrations.fastapi import EnvpitSettingsSource  # noqa: E402

from .._utils import make_loaded_client  # noqa: E402

BaseSettings = pydantic_settings.BaseSettings


def _settings_class(client):
    class Settings(BaseSettings):
        database_url: str
        port: int = 8080
        tags: list[str] = []

        @classmethod
        def settings_customise_sources(
            cls, settings_cls, init_settings, env_settings, dotenv_settings, file_secret_settings
        ):
            return (EnvpitSettingsSource(settings_cls, client=client),)

    return Settings


def test_settings_field_resolves_from_the_envpit_snapshot() -> None:
    client = make_loaded_client({"DATABASE_URL": "postgres://x", "PORT": "9090"})
    settings = _settings_class(client)()

    assert settings.database_url == "postgres://x"
    assert settings.port == 9090  # coerced to int by pydantic, same as EnvSettingsSource would


def test_settings_field_matching_is_case_insensitive_like_the_stock_env_source() -> None:
    client = make_loaded_client({"database_url": "postgres://lowercase"})
    settings = _settings_class(client)()

    assert settings.database_url == "postgres://lowercase"


def test_settings_field_falls_back_to_its_default_when_absent_from_the_snapshot() -> None:
    client = make_loaded_client({"DATABASE_URL": "postgres://x"})
    settings = _settings_class(client)()

    assert settings.port == 8080  # never in the snapshot — the field's own default wins


def test_settings_missing_required_field_raises_a_validation_error() -> None:
    client = make_loaded_client({"PORT": "1"})  # DATABASE_URL absent, no default
    with pytest.raises(Exception) as exc_info:  # noqa: PT011 - pydantic ValidationError
        _settings_class(client)()
    assert "database_url" in str(exc_info.value).lower()


def test_settings_complex_list_field_is_json_decoded_via_the_base_class() -> None:
    client = make_loaded_client({"DATABASE_URL": "x", "TAGS": '["a", "b"]'})
    settings = _settings_class(client)()

    assert settings.tags == ["a", "b"]


def test_settings_source_uses_the_module_level_default_client_when_none_is_passed() -> None:
    import envpit

    from .._utils import fake_fetch_impl

    fetch = fake_fetch_impl({"DATABASE_URL": "postgres://default-client"})
    envpit.load(api_key="epk_test", poll_interval=0, _fetch_impl=fetch)
    try:
        class Settings(BaseSettings):
            database_url: str

            @classmethod
            def settings_customise_sources(
                cls, settings_cls, init_settings, env_settings, dotenv_settings, file_secret_settings
            ):
                return (EnvpitSettingsSource(settings_cls),)  # no client= passed

        assert Settings().database_url == "postgres://default-client"
    finally:
        envpit.close()


def test_env_prefix_is_respected() -> None:
    client = make_loaded_client({"APP_DATABASE_URL": "postgres://prefixed"})

    class PrefixedSettings(BaseSettings):
        model_config = {"env_prefix": "APP_"}
        database_url: str

        @classmethod
        def settings_customise_sources(
            cls, settings_cls, init_settings, env_settings, dotenv_settings, file_secret_settings
        ):
            return (EnvpitSettingsSource(settings_cls, client=client),)

    assert PrefixedSettings().database_url == "postgres://prefixed"


def test_settings_field_excludes_a_server_flagged_secret_by_default_bd_envpit_durd() -> None:
    client = make_loaded_client(
        {"DATABASE_URL": "postgres://x", "DB_PASSWORD": "hunter2"}, secret_keys={"DB_PASSWORD"}
    )

    class Settings(BaseSettings):
        database_url: str
        db_password: str | None = None

        @classmethod
        def settings_customise_sources(
            cls, settings_cls, init_settings, env_settings, dotenv_settings, file_secret_settings
        ):
            return (EnvpitSettingsSource(settings_cls, client=client),)

    settings = Settings()
    assert settings.database_url == "postgres://x"
    assert settings.db_password is None  # excluded — falls through to the field's own default


def test_settings_field_include_secrets_true_opts_a_flagged_key_in() -> None:
    client = make_loaded_client(
        {"DATABASE_URL": "postgres://x", "DB_PASSWORD": "hunter2"}, secret_keys={"DB_PASSWORD"}
    )

    class Settings(BaseSettings):
        database_url: str
        db_password: str | None = None

        @classmethod
        def settings_customise_sources(
            cls, settings_cls, init_settings, env_settings, dotenv_settings, file_secret_settings
        ):
            return (EnvpitSettingsSource(settings_cls, client=client, include_secrets=True),)

    settings = Settings()
    assert settings.db_password == "hunter2"


def test_importing_the_fastapi_integration_without_pydantic_settings_raises_a_clear_import_error(
    monkeypatch,
) -> None:
    """`envpit.integrations.fastapi` must fail LOUDLY with actionable guidance if
    `pydantic-settings` isn't installed — never a bare `ModuleNotFoundError` with no next step."""
    for name in [m for m in sys.modules if m == "pydantic_settings" or m.startswith("pydantic_settings.")]:
        monkeypatch.delitem(sys.modules, name, raising=False)
    for name in [m for m in sys.modules if m == "envpit.integrations.fastapi"]:
        monkeypatch.delitem(sys.modules, name, raising=False)
    monkeypatch.setitem(sys.modules, "pydantic_settings", None)  # forces ModuleNotFoundError

    with pytest.raises(ImportError, match="pip install envpit\\[fastapi\\]"):
        import envpit.integrations.fastapi  # noqa: F401
