"""bd:envpit-yvyr (Python leg) — `EnvpitClient.populate_environ()` / `envpit.populate_environ()`
merges the loaded snapshot into `os.environ` (or an injected mapping), matching the
`python-dotenv`-style idiom so pre-existing `os.environ.get("X")` call sites keep working
untouched.

Safety decisions from the owner (bd:envpit-yvyr, settled — not re-litigated here):
  1. Nothing is EVER written to `os.environ` automatically at `load()` time — this function must
     be called explicitly. See `test_populate_environ_is_never_called_automatically_by_load`.
  2. A key already present in the target mapping wins by default (no override) — same precedence
     `python-dotenv.load_dotenv()` uses. `override=True` opts into overwriting.

bd:envpit-durd, AC-SEC-E11 — the config-resolve wire shape is now `{values, secretKeys}` (was a
bare `key -> value` map with no per-key secret signal at all). `EnvpitClient._known_secret_keys()`
(and its public wrapper `known_secret_keys()`) now returns the REAL set from the loaded snapshot,
and `populate_environ()` EXCLUDES those keys by default (`include_secrets=False`) — the inverse of
the pre-durd behavior asserted by `test_populate_environ_has_no_automatic_secret_filtering` in this
file's prior revision (see git history; that test now asserts the opposite, on purpose — the
protocol gap it documented is closed)."""

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


def test_snapshot_still_returns_secret_values_unchanged_by_bd_envpit_durd() -> None:
    """Getters/`snapshot()` are UNCHANGED by the envelope change — they still return secret
    values as-is; only the env-merge path (`populate_environ()`/the framework integrations)
    filters on `secret_keys`."""
    client = make_loaded_client({"DB_PASSWORD": "hunter2"}, secret_keys={"DB_PASSWORD"})
    assert client.get("DB_PASSWORD") == "hunter2"
    assert client.snapshot() == {"DB_PASSWORD": "hunter2"}


def test_known_secret_keys_returns_the_real_set_from_the_loaded_snapshot() -> None:
    client = make_loaded_client(
        {"DB_PASSWORD": "hunter2", "API_URL": "https://x"}, secret_keys={"DB_PASSWORD"}
    )
    assert client.known_secret_keys() == frozenset({"DB_PASSWORD"})
    assert client._known_secret_keys() == frozenset({"DB_PASSWORD"})


def test_known_secret_keys_is_empty_when_the_environment_has_no_secrets() -> None:
    client = make_loaded_client({"API_URL": "https://x"})
    assert client.known_secret_keys() == frozenset()


# ---------------------------------------------------------------------------
# EnvpitClient.populate_environ — core merge semantics (non-secret paths)
# ---------------------------------------------------------------------------


def test_populate_environ_writes_into_an_injected_mapping_by_default() -> None:
    client = make_loaded_client({"DATABASE_URL": "postgres://x", "PORT": "9090"})
    target: dict[str, str] = {}

    result = client.populate_environ(environ=target)

    assert target == {"DATABASE_URL": "postgres://x", "PORT": "9090"}
    assert result.merged == ("DATABASE_URL", "PORT")
    assert result.skipped_existing == ()
    assert result.skipped_secrets == ()


def test_populate_environ_never_touches_real_os_environ_unless_asked() -> None:
    sentinel_key = "ENVPIT_TEST_SENTINEL_SHOULD_NEVER_BE_SET"
    assert sentinel_key not in os.environ
    client = make_loaded_client({sentinel_key: "leaked"})
    client.populate_environ(environ={})  # explicit target — real os.environ never touched
    assert sentinel_key not in os.environ


def test_populate_environ_does_not_override_an_existing_value_by_default() -> None:
    client = make_loaded_client({"DATABASE_URL": "postgres://from-envpit"})
    target = {"DATABASE_URL": "postgres://already-set-by-deploy-platform"}

    result = client.populate_environ(environ=target)

    assert target["DATABASE_URL"] == "postgres://already-set-by-deploy-platform"
    assert result.merged == ()  # nothing was actually written — the pre-existing value won
    assert result.skipped_existing == ("DATABASE_URL",)


def test_populate_environ_override_true_overwrites_an_existing_value() -> None:
    client = make_loaded_client({"DATABASE_URL": "postgres://from-envpit"})
    target = {"DATABASE_URL": "postgres://stale"}

    result = client.populate_environ(environ=target, override=True)

    assert target["DATABASE_URL"] == "postgres://from-envpit"
    assert result.merged == ("DATABASE_URL",)


def test_populate_environ_skips_keys_whose_value_is_none() -> None:
    client = make_loaded_client({"UNSET_KEY": None, "SET_KEY": "v"})
    target: dict[str, str] = {}

    result = client.populate_environ(environ=target)

    assert "UNSET_KEY" not in target
    assert result.merged == ("SET_KEY",)


def test_populate_environ_exclude_keeps_named_keys_out() -> None:
    client = make_loaded_client({"DB_PASSWORD": "hunter2", "API_URL": "https://x"})
    target: dict[str, str] = {}

    result = client.populate_environ(environ=target, exclude={"DB_PASSWORD"})

    assert "DB_PASSWORD" not in target
    assert target == {"API_URL": "https://x"}
    assert result.merged == ("API_URL",)


def test_populate_environ_exclude_combines_with_override() -> None:
    client = make_loaded_client({"DB_PASSWORD": "hunter2", "API_URL": "https://x"})
    target = {"API_URL": "https://stale"}

    result = client.populate_environ(environ=target, exclude={"DB_PASSWORD"}, override=True)

    assert target == {"API_URL": "https://x"}
    assert result.merged == ("API_URL",)


def test_populate_environ_defaults_to_real_os_environ_when_no_target_given(monkeypatch) -> None:
    monkeypatch.delenv("ENVPIT_TEST_REAL_TARGET", raising=False)
    client = make_loaded_client({"ENVPIT_TEST_REAL_TARGET": "v"})

    result = client.populate_environ()

    assert os.environ["ENVPIT_TEST_REAL_TARGET"] == "v"
    assert result.merged == ("ENVPIT_TEST_REAL_TARGET",)


def test_populate_environ_is_never_called_automatically_by_load() -> None:
    sentinel_key = "ENVPIT_TEST_NEVER_AUTO_MERGED"
    os.environ.pop(sentinel_key, None)
    make_loaded_client({sentinel_key: "should-not-appear"})
    assert sentinel_key not in os.environ


# ---------------------------------------------------------------------------
# EnvpitClient.populate_environ — secret exclusion (bd:envpit-durd, AC-SEC-E11)
# ---------------------------------------------------------------------------


def test_populate_environ_excludes_server_flagged_secrets_by_default() -> None:
    """The wire response now DOES carry secret metadata (`secretKeys`), and the default,
    zero-argument call excludes every key it names — the safe default the pre-durd revision of
    this test (`test_populate_environ_has_no_automatic_secret_filtering`, see git history) could
    not yet assert because the protocol gap it documented didn't close until now."""
    client = make_loaded_client(
        {"DB_PASSWORD": "hunter2", "JWT_SECRET": "s3cr3t", "API_URL": "https://x"},
        secret_keys={"DB_PASSWORD", "JWT_SECRET"},
    )
    target: dict[str, str] = {}

    result = client.populate_environ(environ=target)

    assert target == {"API_URL": "https://x"}
    assert result.merged == ("API_URL",)
    assert result.skipped_secrets == ("DB_PASSWORD", "JWT_SECRET")


def test_populate_environ_include_secrets_true_opts_every_flagged_key_in() -> None:
    client = make_loaded_client(
        {"DB_PASSWORD": "hunter2", "API_URL": "https://x"}, secret_keys={"DB_PASSWORD"}
    )
    target: dict[str, str] = {}

    result = client.populate_environ(environ=target, include_secrets=True)

    assert target == {"DB_PASSWORD": "hunter2", "API_URL": "https://x"}
    assert result.merged == ("API_URL", "DB_PASSWORD")
    assert result.skipped_secrets == ()


def test_populate_environ_secret_check_precedes_the_existing_key_check() -> None:
    """Matches `env-merge.json`'s `secret-check-precedes-existing-check` vector case: a secret
    already present in the target is reported as `skipped_secrets`, not `skipped_existing`, and
    `override=True` alone does not smuggle it through."""
    client = make_loaded_client({"DB_PASSWORD": "hunter2"}, secret_keys={"DB_PASSWORD"})
    target = {"DB_PASSWORD": "already-here"}

    result = client.populate_environ(environ=target, override=True)

    assert target["DB_PASSWORD"] == "already-here"  # untouched
    assert result.merged == ()
    assert result.skipped_existing == ()
    assert result.skipped_secrets == ("DB_PASSWORD",)


def test_populate_environ_override_plus_include_secrets_replaces_an_existing_secret() -> None:
    client = make_loaded_client({"DB_PASSWORD": "hunter2"}, secret_keys={"DB_PASSWORD"})
    target = {"DB_PASSWORD": "already-here"}

    result = client.populate_environ(environ=target, override=True, include_secrets=True)

    assert target["DB_PASSWORD"] == "hunter2"
    assert result.merged == ("DB_PASSWORD",)


def test_known_secret_keys_hook_is_already_wired_in() -> None:
    """`known_secret_keys()`/`_known_secret_keys()` reads the REAL `secretKeys` field of the
    loaded snapshot (bd:envpit-durd) — every call site (`populate_environ` above, and the
    `flask`/`django` integrations) already folds its result into the exclude set
    unconditionally, so a real server-provided secret set (not a monkeypatch simulating a
    "future" that has now arrived) is enough to exclude it, with no other code changes needed."""
    client = make_loaded_client(
        {"DB_PASSWORD": "hunter2", "API_URL": "https://x"}, secret_keys={"DB_PASSWORD"}
    )
    assert client._known_secret_keys() == frozenset({"DB_PASSWORD"})

    target: dict[str, str] = {}
    result = client.populate_environ(environ=target)

    assert "DB_PASSWORD" not in target
    assert target == {"API_URL": "https://x"}
    assert result.merged == ("API_URL",)


# ---------------------------------------------------------------------------
# EnvpitClient.populate_environ — Python-local `only=`/`exclude=` × secrets interaction
# ---------------------------------------------------------------------------
#
# `only=`/`exclude=` are Python-local additions (mirroring Go's WithOnly/WithExclude; no Node/
# Java equivalent) NOT covered by the shared `env-merge.json` vector family (see its own
# `notes.languageLocalOptions`) — covered here instead, per the owner's explicit requirement that
# `only=` must not be able to pull a secret through without `include_secrets=True`.


def test_only_narrows_the_candidate_set_but_does_not_bypass_the_secret_check() -> None:
    """The core requirement: naming a secret key in `only=` alone is NOT enough to merge it —
    `include_secrets=True` is still required. `only=` narrows WHICH keys are even considered; it
    does not skip the checks that apply to whatever survives that narrowing."""
    client = make_loaded_client(
        {"DB_PASSWORD": "hunter2", "API_URL": "https://x", "PORT": "9090"},
        secret_keys={"DB_PASSWORD"},
    )
    target: dict[str, str] = {}

    result = client.populate_environ(environ=target, only={"DB_PASSWORD", "API_URL"})

    assert target == {"API_URL": "https://x"}  # PORT excluded by `only`; DB_PASSWORD by secret check
    assert result.merged == ("API_URL",)
    assert result.skipped_secrets == ("DB_PASSWORD",)


def test_only_plus_include_secrets_true_does_merge_the_named_secret() -> None:
    client = make_loaded_client(
        {"DB_PASSWORD": "hunter2", "API_URL": "https://x"}, secret_keys={"DB_PASSWORD"}
    )
    target: dict[str, str] = {}

    result = client.populate_environ(
        environ=target, only={"DB_PASSWORD"}, include_secrets=True
    )

    assert target == {"DB_PASSWORD": "hunter2"}
    assert result.merged == ("DB_PASSWORD",)


def test_only_excludes_every_key_not_named_uncounted_in_every_list() -> None:
    client = make_loaded_client({"A": "1", "B": "2"})
    target: dict[str, str] = {}

    result = client.populate_environ(environ=target, only={"A"})

    assert target == {"A": "1"}
    assert result.merged == ("A",)
    assert result.skipped_existing == ()
    assert result.skipped_secrets == ()


def test_exclude_always_wins_over_only_and_override_and_include_secrets() -> None:
    client = make_loaded_client(
        {"DB_PASSWORD": "hunter2", "API_URL": "https://x"}, secret_keys={"DB_PASSWORD"}
    )
    target: dict[str, str] = {}

    result = client.populate_environ(
        environ=target,
        only={"DB_PASSWORD", "API_URL"},
        exclude={"DB_PASSWORD"},
        include_secrets=True,
        override=True,
    )

    assert target == {"API_URL": "https://x"}
    assert result.merged == ("API_URL",)
    assert result.skipped_secrets == ()  # excluded, not reported as a skipped secret either


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
    result = envpit.populate_environ(environ=target)

    assert target == {"NAME": "envpit"}
    assert result.merged == ("NAME",)


def test_module_level_populate_environ_before_load_raises_a_clear_runtime_error() -> None:
    with pytest.raises(RuntimeError, match="no default client"):
        envpit.populate_environ()


def test_module_level_populate_environ_threads_include_secrets_through() -> None:
    fetch = fake_fetch_impl({"DB_PASSWORD": "hunter2"}, secret_keys={"DB_PASSWORD"})
    envpit.load(api_key="epk_test", poll_interval=0, _fetch_impl=fetch)

    target: dict[str, str] = {}
    result = envpit.populate_environ(environ=target, include_secrets=True)

    assert target == {"DB_PASSWORD": "hunter2"}
    assert result.merged == ("DB_PASSWORD",)


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
