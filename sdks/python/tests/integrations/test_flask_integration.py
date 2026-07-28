"""bd:envpit-yvyr — Flask's own idiom is `app.config` (populated via `from_mapping`/`from_object`/
`from_pyfile`, all funneling into the same `Config` dict subclass).
`envpit.integrations.flask.init_app(app)` merges the resolved snapshot into `app.config` the same
way any other Flask extension's `init_app(app)` hook would."""

from __future__ import annotations

import pytest

flask = pytest.importorskip("flask")

from envpit.integrations.flask import init_app  # noqa: E402

from .._utils import make_loaded_client  # noqa: E402


def _make_app() -> flask.Flask:
    return flask.Flask(__name__)


def test_init_app_merges_the_snapshot_into_app_config() -> None:
    app = _make_app()
    client = make_loaded_client({"DATABASE_URL": "postgres://x", "PORT": "9090"})

    written = init_app(app, client=client)

    assert app.config["DATABASE_URL"] == "postgres://x"
    assert app.config["PORT"] == "9090"
    assert written == {"DATABASE_URL", "PORT"}


def test_init_app_does_not_override_an_existing_app_config_value_by_default() -> None:
    app = _make_app()
    app.config["DATABASE_URL"] = "postgres://already-configured"
    client = make_loaded_client({"DATABASE_URL": "postgres://from-envpit"})

    written = init_app(app, client=client)

    assert app.config["DATABASE_URL"] == "postgres://already-configured"
    assert written == set()


def test_init_app_override_true_overwrites_existing_app_config() -> None:
    app = _make_app()
    app.config["DATABASE_URL"] = "postgres://stale"
    client = make_loaded_client({"DATABASE_URL": "postgres://from-envpit"})

    written = init_app(app, client=client, override=True)

    assert app.config["DATABASE_URL"] == "postgres://from-envpit"
    assert written == {"DATABASE_URL"}


def test_init_app_exclude_keeps_named_keys_out_of_app_config() -> None:
    app = _make_app()
    client = make_loaded_client({"SECRET_KEY": "hunter2", "DATABASE_URL": "postgres://x"})

    written = init_app(app, client=client, exclude={"SECRET_KEY"})

    # Flask itself pre-seeds `app.config["SECRET_KEY"] = None` by default — assert the EnvPit
    # value never overwrote it, rather than "not in" (which Flask's own default would fail).
    assert app.config["SECRET_KEY"] is None
    assert app.config["DATABASE_URL"] == "postgres://x"
    assert written == {"DATABASE_URL"}


def test_init_app_skips_none_values() -> None:
    app = _make_app()
    client = make_loaded_client({"UNSET": None, "SET": "v"})

    init_app(app, client=client)

    assert "UNSET" not in app.config
    assert app.config["SET"] == "v"


def test_init_app_uses_the_module_level_default_client_when_none_is_passed() -> None:
    import envpit

    from .._utils import fake_fetch_impl

    app = _make_app()
    fetch = fake_fetch_impl({"NAME": "envpit"})
    envpit.load(api_key="epk_test", poll_interval=0, _fetch_impl=fetch)
    try:
        written = init_app(app)
        assert app.config["NAME"] == "envpit"
        assert written == {"NAME"}
    finally:
        envpit.close()
