"""bd:envpit-yvyr (Python leg) — `EnvpitClient.populate_environ()` / `envpit.populate_environ()`
merges the loaded snapshot into `os.environ` (or an injected mapping), matching the
`python-dotenv`-style idiom so pre-existing `os.environ.get("X")` call sites keep working
untouched.

Two safety decisions from the owner (bd:envpit-yvyr, settled — not re-litigated here):
  1. Nothing is EVER written to `os.environ` automatically at `load()` time — this function must
     be called explicitly. See `test_populate_environ_is_never_called_automatically_by_load`.
  2. A key already present in the target mapping wins by default (no override) — same precedence
     `python-dotenv.load_dotenv()` uses. `override=True` opts into overwriting.

KNOWN, DOCUMENTED LIMITATION (verified against `apps/api/src/config-management/
config-resolve.controller.ts` in the main `envpit` repo, 2026-07-28): the SDK-facing resolve
endpoint (`GET /v1/config`) returns a flat `key -> value` map with NO per-key `is_secret` flag —
`schema: { additionalProperties: { type: 'string', nullable: true } }`. The richer
`is_secret`-carrying endpoint (`GET /v1/projects/:id/config-keys`) is guarded by
`JwtAuthGuard`+`RbacGuard` (human session auth), a deliberately separate trust boundary
(ADR-M5-03) that an API-key-authed SDK cannot reach. So THIS SDK CANNOT automatically exclude
"secret" keys from a `populate_environ()` call — there is no signal to filter on. The mitigation
actually shipped is: (a) nothing merges unless explicitly opted in, and (b) an `exclude=`
allow-list lets a caller who knows their own secret key names keep them out by hand. This test
file asserts that limitation directly (`test_populate_environ_has_no_automatic_secret_filtering`)
so a future change can't silently regress the documented behavior in either direction without a
test failing.

Oliver's 2026-07-28 correction (re-verified, matches the Java SDK's independent finding) also
asked for a prepared "socket" for once the server DOES start shipping secret metadata:
`EnvpitClient._known_secret_keys()` — today it always returns an empty `frozenset()` (there is
nothing to report), but `populate_environ()`/the framework integrations already fold its result
into the exclude set unconditionally, so the day the wire protocol adds `is_secret`, only
`_known_secret_keys()`'s body needs to change — no call site here, in `_environ_merge.py`, or in
any `integrations/*` module needs to change. `test_known_secret_keys_hook_is_already_wired_in`
proves the socket is live, not just planned."""

from __future__ import annotations

import os

import pytest

import envpit

from ._utils import fake_fetch_impl, make_loaded_client

# ---------------------------------------------------------------------------
# EnvpitClient.get_optional / EnvpitClient.snapshot — small building blocks
# ---------------------------------------------------------------------------


def test_get_optional_returns_none_for_a_missing_key_without_raising() -> None:
    client = make_loaded_client({"A": "1"})
    assert client.get_optional("MISSING") is None


def test_get_optional_returns_the_value_for_a_present_key() -> None:
    client = make_loaded_client({"A": "1"})
    assert client.get_optional("A") == "1"


def test_snapshot_returns_a_defensive_copy() -> None:
    client = make_loaded_client({"A": "1", "B": None})
    snap = client.snapshot()
    assert snap == {"A": "1", "B": None}
    snap["A"] = "mutated"
    assert client.get("A") == "1"  # the client's own state is untouched


# ---------------------------------------------------------------------------
# EnvpitClient.populate_environ — core merge semantics
# ---------------------------------------------------------------------------


def test_populate_environ_writes_into_an_injected_mapping_by_default() -> None:
    client = make_loaded_client({"DATABASE_URL": "postgres://x", "PORT": "9090"})
    target: dict[str, str] = {}

    written = client.populate_environ(environ=target)

    assert target == {"DATABASE_URL": "postgres://x", "PORT": "9090"}
    assert written == {"DATABASE_URL", "PORT"}


def test_populate_environ_never_touches_real_os_environ_unless_asked() -> None:
    sentinel_key = "ENVPIT_TEST_SENTINEL_SHOULD_NEVER_BE_SET"
    assert sentinel_key not in os.environ
    client = make_loaded_client({sentinel_key: "leaked"})
    client.populate_environ(environ={})  # explicit target — real os.environ never touched
    assert sentinel_key not in os.environ


def test_populate_environ_does_not_override_an_existing_value_by_default() -> None:
    client = make_loaded_client({"DATABASE_URL": "postgres://from-envpit"})
    target = {"DATABASE_URL": "postgres://already-set-by-deploy-platform"}

    written = client.populate_environ(environ=target)

    assert target["DATABASE_URL"] == "postgres://already-set-by-deploy-platform"
    assert written == set()  # nothing was actually written — the pre-existing value won


def test_populate_environ_override_true_overwrites_an_existing_value() -> None:
    client = make_loaded_client({"DATABASE_URL": "postgres://from-envpit"})
    target = {"DATABASE_URL": "postgres://stale"}

    written = client.populate_environ(environ=target, override=True)

    assert target["DATABASE_URL"] == "postgres://from-envpit"
    assert written == {"DATABASE_URL"}


def test_populate_environ_skips_keys_whose_value_is_none() -> None:
    client = make_loaded_client({"UNSET_KEY": None, "SET_KEY": "v"})
    target: dict[str, str] = {}

    written = client.populate_environ(environ=target)

    assert "UNSET_KEY" not in target
    assert written == {"SET_KEY"}


def test_populate_environ_exclude_keeps_named_keys_out() -> None:
    client = make_loaded_client({"DB_PASSWORD": "hunter2", "API_URL": "https://x"})
    target: dict[str, str] = {}

    written = client.populate_environ(environ=target, exclude={"DB_PASSWORD"})

    assert "DB_PASSWORD" not in target
    assert target == {"API_URL": "https://x"}
    assert written == {"API_URL"}


def test_populate_environ_exclude_combines_with_override() -> None:
    client = make_loaded_client({"DB_PASSWORD": "hunter2", "API_URL": "https://x"})
    target = {"API_URL": "https://stale"}

    written = client.populate_environ(environ=target, exclude={"DB_PASSWORD"}, override=True)

    assert target == {"API_URL": "https://x"}
    assert written == {"API_URL"}


def test_populate_environ_has_no_automatic_secret_filtering() -> None:
    """Documented limitation (see module docstring): the wire response carries no `is_secret`
    flag, so nothing named "SECRET"/"PASSWORD"/"TOKEN" is auto-excluded — every key is eligible
    unless the caller passes it in `exclude=`. This test exists so a future "helpful" heuristic
    can't be added silently without this test forcing a conscious decision + doc update."""
    client = make_loaded_client({"DB_PASSWORD": "hunter2", "JWT_SECRET": "s3cr3t"})
    target: dict[str, str] = {}

    written = client.populate_environ(environ=target)

    assert written == {"DB_PASSWORD", "JWT_SECRET"}


def test_populate_environ_defaults_to_real_os_environ_when_no_target_given(monkeypatch) -> None:
    monkeypatch.delenv("ENVPIT_TEST_REAL_TARGET", raising=False)
    client = make_loaded_client({"ENVPIT_TEST_REAL_TARGET": "v"})

    written = client.populate_environ()

    assert os.environ["ENVPIT_TEST_REAL_TARGET"] == "v"
    assert written == {"ENVPIT_TEST_REAL_TARGET"}


def test_known_secret_keys_hook_is_already_wired_in() -> None:
    """The prepared "socket" for future server-provided secret metadata (Oliver, bd:envpit-yvyr,
    2026-07-28 correction): `_known_secret_keys()` is currently always empty, but subclassing/
    monkeypatching it to report a key is enough to exclude it — no other code changes needed."""
    client = make_loaded_client({"DB_PASSWORD": "hunter2", "API_URL": "https://x"})
    assert client._known_secret_keys() == frozenset()  # nothing to report today — protocol gap

    client._known_secret_keys = lambda: frozenset({"DB_PASSWORD"})  # simulates a future SDK
    target: dict[str, str] = {}
    written = client.populate_environ(environ=target)

    assert "DB_PASSWORD" not in target
    assert target == {"API_URL": "https://x"}
    assert written == {"API_URL"}


def test_populate_environ_is_never_called_automatically_by_load() -> None:
    sentinel_key = "ENVPIT_TEST_NEVER_AUTO_MERGED"
    os.environ.pop(sentinel_key, None)
    make_loaded_client({sentinel_key: "should-not-appear"})
    assert sentinel_key not in os.environ


# ---------------------------------------------------------------------------
# Module-level sugar: envpit.populate_environ() delegates to the default client
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_module_singleton():
    yield
    envpit.close()


def test_module_level_populate_environ_delegates_to_the_default_client() -> None:
    fetch = fake_fetch_impl({"NAME": "envpit"})
    envpit.load(api_key="epk_test", poll_interval=0, _fetch_impl=fetch)

    target: dict[str, str] = {}
    written = envpit.populate_environ(environ=target)

    assert target == {"NAME": "envpit"}
    assert written == {"NAME"}


def test_module_level_populate_environ_before_load_raises_a_clear_runtime_error() -> None:
    with pytest.raises(RuntimeError, match="no default client"):
        envpit.populate_environ()


def test_populate_environ_boot_time_snapshot_is_not_refreshed_by_a_later_client_refresh() -> None:
    """Decision #3 (bd:envpit-yvyr): native-mechanism merge is a boot-time snapshot; realtime
    refresh cannot reach a value already copied out into `os.environ`. Asserted directly: a
    client-side refresh that changes a value does NOT retroactively update a previously
    `populate_environ()`-filled target mapping."""
    client = make_loaded_client({"FLAG": "off"})
    target: dict[str, str] = {}
    client.populate_environ(environ=target)
    assert target["FLAG"] == "off"

    # Simulate a background refresh landing a new value — a realtime push in production.
    client._fetch_impl = fake_fetch_impl({"FLAG": "on"})
    client._refresh(is_first_load=False, trigger="poll")
    assert client.get("FLAG") == "on"  # the live client sees the new value ...
    assert target["FLAG"] == "off"  # ... but the earlier os.environ snapshot is untouched
