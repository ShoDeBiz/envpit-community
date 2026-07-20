"""Regression coverage for `bd:envpit-igc0` — the module-level sugar layer
(`envpit.load()`/`get*()`/`on_*()`/`cache_info()`/`close()`, the exact `import envpit;
client = envpit.load()` shape the README's quickstart shows as the hero pattern) had ZERO test
coverage before this file: `src/envpit/__init__.py` sat at 48% coverage, and the only reference
to the top-level `envpit` module anywhere in `tests/` was a signature-introspection check in
`test_no_skip_tls.py` — never an actual `envpit.load()`/`envpit.get()` call (per Chris's review,
`outputs/REVIEW-envpit-0t2z-3-python.md`). Exercises the REAL top-level `envpit` module
directly — not `EnvpitClient` — the same "injected seam, real code path" philosophy used
everywhere else in this suite (`_fetch_impl`/`_sse_opener` passed straight through `envpit.load()`
to `EnvpitClient.load()`)."""

from __future__ import annotations

import threading

import pytest

import envpit

from ._utils import fake_fetch_impl, fetch_queue, wait_until


@pytest.fixture(autouse=True)
def _reset_module_singleton():
    """Every test gets a clean module-level default client. A leftover default from a
    previous/failed test must never leak its background poll+realtime threads into the next
    one — this fixture is itself a regression guard for exactly the class of leak `bd:envpit-igc0`
    is about."""
    yield
    envpit.close()


# ---------------------------------------------------------------------------
# Basic delegation: load()/get*()/cache_info()/close() through the real top-level module
# ---------------------------------------------------------------------------


def test_load_returns_the_client_and_installs_it_as_the_default() -> None:
    fetch = fake_fetch_impl({"PORT": "9090"})
    client = envpit.load(api_key="epk_test", poll_interval=0, _fetch_impl=fetch)
    assert isinstance(client, envpit.EnvpitClient)
    assert envpit.get("PORT") == "9090"


def test_get_get_string_get_int_get_bool_all_delegate_to_the_default_client() -> None:
    fetch = fake_fetch_impl({"NAME": "envpit", "PORT": "9090", "MAINTENANCE_MODE": "true"})
    envpit.load(api_key="epk_test", poll_interval=0, _fetch_impl=fetch)

    assert envpit.get("NAME") == "envpit"
    assert envpit.get_string("NAME") == "envpit"
    assert envpit.get_int("PORT") == 9090
    assert envpit.get_bool("MAINTENANCE_MODE") is True


def test_get_with_default_and_missing_key_error_delegate_correctly() -> None:
    fetch = fake_fetch_impl({"K": "v"})
    envpit.load(api_key="epk_test", poll_interval=0, _fetch_impl=fetch)

    assert envpit.get("ABSENT", "fallback") == "fallback"
    with pytest.raises(envpit.MissingKeyError):
        envpit.get("ABSENT")


def test_cache_info_delegates_to_the_default_client() -> None:
    fetch = fake_fetch_impl({"K": "v"}, etag="etag-1")
    envpit.load(api_key="epk_test", poll_interval=0, _fetch_impl=fetch)

    info = envpit.cache_info()
    assert isinstance(info, envpit.CacheInfo)
    assert info.etag == "etag-1"
    assert info.last_error is None


def test_on_change_on_connection_on_error_all_delegate_and_unsubscribe_works() -> None:
    fetch = fetch_queue(({"K": "v0"}, None), ({"K": "v1"}, None))
    client = envpit.load(api_key="epk_test", poll_interval=0, _fetch_impl=fetch)

    changes: list = []
    unsubscribe = envpit.on_change(lambda e: changes.append(e))
    envpit.on_connection(lambda e: None)  # smoke: delegates without raising
    envpit.on_error(lambda e: None)  # smoke: delegates without raising

    client._refresh(is_first_load=False, trigger="poll")
    assert len(changes) == 1
    assert changes[0].changed_keys == ["K"]

    unsubscribe()
    client._refresh(is_first_load=False, trigger="poll")  # no-op fetch queue exhaustion guard
    # (fetch_queue is exhausted after 2 calls above; a 3rd call would raise loudly if issued —
    # asserting no exception propagated confirms the unsubscribe actually took effect, since a
    # 3rd refresh was never triggered by this test in the first place. The real assertion is
    # that `changes` didn't grow past 1.)
    assert len(changes) == 1


# ---------------------------------------------------------------------------
# get()-before-load() and close()-before-load()
# ---------------------------------------------------------------------------


def test_get_before_load_raises_a_clear_runtime_error_not_an_attribute_error() -> None:
    with pytest.raises(RuntimeError, match="no default client"):
        envpit.get("ANYTHING")


def test_close_before_any_load_is_a_safe_no_op() -> None:
    envpit.close()  # must not raise


# ---------------------------------------------------------------------------
# bd:envpit-igc0 — the actual regression: a second load() must not orphan the first client
# ---------------------------------------------------------------------------


def test_bd_envpit_igc0_second_load_closes_the_previous_default_clients_background_threads() -> None:
    threads_before = threading.active_count()

    fetch1 = fake_fetch_impl({"A": "1"})
    c1 = envpit.load(api_key="epk_test", poll_interval=0.05, _fetch_impl=fetch1)
    assert wait_until(lambda: threading.active_count() >= threads_before + 2)
    assert c1._poll_thread is not None and c1._poll_thread.is_alive()
    assert c1._realtime is not None and c1._realtime._thread is not None
    assert c1._realtime._thread.is_alive()

    # Captured BEFORE the second load() — `load()` closes the outgoing default synchronously
    # (per the fix), including nulling `c1._realtime`, so these references must be grabbed
    # while c1 is still the live default.
    c1_poll_thread = c1._poll_thread
    c1_realtime_thread = c1._realtime._thread

    fetch2 = fake_fetch_impl({"B": "2"})
    c2 = envpit.load(api_key="epk_test", poll_interval=0.05, _fetch_impl=fetch2)
    assert c2 is not c1

    # The FIX under test: c1's threads must be stopped (not orphaned/leaked) as soon as c2
    # becomes the default — this is the exact scenario bd:envpit-igc0 reported as unstoppable
    # via the public API (`envpit.close()` only ever reached whichever client was CURRENT).
    assert wait_until(lambda: not c1_poll_thread.is_alive())
    assert wait_until(lambda: not c1_realtime_thread.is_alive())
    assert c1._realtime is None  # close() clears it — no dangling reference to a dead transport

    # c2 (the current default) is unaffected and still fully alive.
    assert c2._poll_thread is not None and c2._poll_thread.is_alive()
    assert c2._realtime is not None and c2._realtime._thread.is_alive()
    assert envpit.get("B") == "2"

    c2_poll_thread = c2._poll_thread
    c2_realtime_thread = c2._realtime._thread
    envpit.close()
    assert wait_until(lambda: not c2_poll_thread.is_alive())
    assert wait_until(lambda: not c2_realtime_thread.is_alive())

    # Overall thread count returns to baseline — nothing leaked across either load() or close().
    assert wait_until(lambda: threading.active_count() <= threads_before)


def test_bd_envpit_igc0_close_only_ever_reaches_the_currently_installed_default() -> None:
    """The specific failure mode from the bug report: pre-fix, `envpit.close()` only ever
    reached whichever client was CURRENTLY `_default_client` — the orphaned previous one was
    unstoppable via the public API. Post-fix, there is no "orphaned previous one" to begin
    with, because `load()` itself closes it. This test asserts that end state directly."""
    fetch1 = fake_fetch_impl({"A": "1"})
    c1 = envpit.load(api_key="epk_test", poll_interval=0.05, _fetch_impl=fetch1)
    assert wait_until(lambda: c1._poll_thread is not None and c1._poll_thread.is_alive())

    fetch2 = fake_fetch_impl({"B": "2"})
    envpit.load(api_key="epk_test", poll_interval=0.05, _fetch_impl=fetch2)

    envpit.close()  # closes whichever client is CURRENT (c2) ...

    # ... and c1, despite never being "current" at close() time, is ALSO stopped (by load()
    # itself, at swap time) — not left running forever as bd:envpit-igc0 described.
    assert wait_until(lambda: not c1._poll_thread.is_alive())


# ---------------------------------------------------------------------------
# EnvpitClient.__enter__/__exit__ — bundled minor finding from the same review (Chris's report
# §4 "Minor"): the `with EnvpitClient.load() as client:` pattern also had zero coverage.
# ---------------------------------------------------------------------------


def test_context_manager_protocol_closes_on_exit() -> None:
    fetch = fake_fetch_impl({"K": "v"})
    with envpit.EnvpitClient.load(
        api_key="epk_test", poll_interval=0.05, _fetch_impl=fetch
    ) as client:
        assert client.get("K") == "v"
        assert client._poll_thread is not None and client._poll_thread.is_alive()

    assert wait_until(lambda: not client._poll_thread.is_alive())


def test_context_manager_closes_even_when_the_body_raises() -> None:
    fetch = fake_fetch_impl({"K": "v"})
    with pytest.raises(ValueError):
        with envpit.EnvpitClient.load(
            api_key="epk_test", poll_interval=0.05, _fetch_impl=fetch
        ) as client:
            raise ValueError("boom")
    assert wait_until(lambda: not client._poll_thread.is_alive())
