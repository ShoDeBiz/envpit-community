"""bd:envpit-yvyr — Django has NO plugin hook for external settings sources (verified: Django's
settings loader just `exec`s `settings.py` as a plain module — there is no `settings_customise_
sources()`-style extension point the way pydantic-settings has). The accepted idiom (the same one
`django-environ`/`django-configurations` use) is: populate values at the TOP of `settings.py`,
before the rest of the module reads them. `envpit.integrations.django.load_into_settings(...)`
targets `settings.py`'s own module namespace (`globals()`, called from inside settings.py) so
typed values — `client.get_bool("DEBUG")`, `client.get_int("PORT")` — can be assigned directly,
without the `os.environ`-is-strings-only constraint `populate_environ()` has.

This module intentionally has NO dependency on Django itself (it operates on any
`MutableMapping[str, object]` — `globals()` from a real settings.py included) so it does not
require `django` installed to import or test."""

from __future__ import annotations

from envpit.integrations.django import load_into_settings

from .._utils import make_loaded_client


def test_load_into_settings_writes_into_a_plain_dict() -> None:
    client = make_loaded_client({"DATABASE_URL": "postgres://x", "PORT": "9090"})
    settings_globals: dict[str, object] = {"__name__": "myapp.settings"}

    written = load_into_settings(settings_globals, client=client)

    assert settings_globals["DATABASE_URL"] == "postgres://x"
    assert settings_globals["PORT"] == "9090"
    assert written.merged == ("DATABASE_URL", "PORT")


def test_load_into_settings_does_not_override_an_already_defined_setting_by_default() -> None:
    client = make_loaded_client({"DEBUG": "true"})
    settings_globals: dict[str, object] = {"DEBUG": False}  # already a real bool, set above

    written = load_into_settings(settings_globals, client=client)

    assert settings_globals["DEBUG"] is False  # untouched — the string "true" never overwrote it
    assert written.merged == ()


def test_load_into_settings_override_true_overwrites() -> None:
    client = make_loaded_client({"ALLOWED_HOSTS": "example.com"})
    settings_globals: dict[str, object] = {"ALLOWED_HOSTS": ["localhost"]}

    written = load_into_settings(settings_globals, client=client, override=True)

    assert settings_globals["ALLOWED_HOSTS"] == "example.com"
    assert written.merged == ("ALLOWED_HOSTS",)


def test_load_into_settings_exclude_keeps_named_keys_out() -> None:
    client = make_loaded_client({"SECRET_KEY": "hunter2", "DATABASE_URL": "postgres://x"})
    settings_globals: dict[str, object] = {}

    written = load_into_settings(settings_globals, client=client, exclude={"SECRET_KEY"})

    assert "SECRET_KEY" not in settings_globals
    assert settings_globals["DATABASE_URL"] == "postgres://x"
    assert written.merged == ("DATABASE_URL",)


def test_load_into_settings_excludes_server_flagged_secrets_by_default_bd_envpit_durd() -> None:
    client = make_loaded_client(
        {"SECRET_KEY": "hunter2", "DATABASE_URL": "postgres://x"}, secret_keys={"SECRET_KEY"}
    )
    settings_globals: dict[str, object] = {}

    written = load_into_settings(settings_globals, client=client)

    assert "SECRET_KEY" not in settings_globals
    assert settings_globals["DATABASE_URL"] == "postgres://x"
    assert written.merged == ("DATABASE_URL",)
    assert written.skipped_secrets == ("SECRET_KEY",)


def test_load_into_settings_include_secrets_true_opts_a_flagged_key_in() -> None:
    client = make_loaded_client(
        {"SECRET_KEY": "hunter2", "DATABASE_URL": "postgres://x"}, secret_keys={"SECRET_KEY"}
    )
    settings_globals: dict[str, object] = {}

    written = load_into_settings(settings_globals, client=client, include_secrets=True)

    assert settings_globals["SECRET_KEY"] == "hunter2"
    assert written.merged == ("DATABASE_URL", "SECRET_KEY")


def test_load_into_settings_used_via_exec_against_a_real_module_namespace() -> None:
    """Proves the actual settings.py usage pattern works: `globals()` called at module scope
    inside an `exec`'d module IS that module's real namespace — assigning into it defines
    module-level names, exactly the way `SECRET_KEY = os.environ["SECRET_KEY"]` would."""
    client = make_loaded_client({"SECRET_KEY": "hunter2", "DEBUG": "false"})

    settings_source = (
        "import envpit\n"
        "from envpit.integrations.django import load_into_settings\n"
        "written = load_into_settings(globals(), client=_client)\n"
        "DEBUG = DEBUG == 'true'\n"  # typical settings.py post-processing of a merged string
    )
    module_namespace: dict[str, object] = {"_client": client}
    exec(compile(settings_source, "<settings.py>", "exec"), module_namespace)  # noqa: S102

    assert module_namespace["SECRET_KEY"] == "hunter2"
    assert module_namespace["DEBUG"] is False
    assert module_namespace["written"].merged == ("DEBUG", "SECRET_KEY")
