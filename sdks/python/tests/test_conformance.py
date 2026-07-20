"""One dedicated test per `test-vectors/CONFORMANCE.md` INV-SDK-N ID, with the ID embedded in
the test's own name (`CONFORMANCE.md`'s rule: "Every language's test suite MUST contain at
least one test per INV-SDK-N ID... with the ID in the test's own name" — enables a future
CONFORMANCE-ID grep-gate CI job, Sara §5.3/§5.5).
"""

from __future__ import annotations

import threading
import time

import pytest

from envpit.client import EnvpitClient
from envpit.errors import (
    AuthenticationError,
    MissingKeyError,
    NetworkError,
    TypeMismatchError,
)
from envpit.realtime import RealtimeCallbacks, RealtimeTransport

from ._utils import FakeSseStream, fetch_queue, wait_until

# ---------------------------------------------------------------------------
# INV-SDK-1 — load() sole entry point; first-load failure fatal; no half-init client
# ---------------------------------------------------------------------------


def test_inv_sdk_1_load_is_the_only_entry_point_first_load_failure_is_fatal() -> None:
    def failing_fetch(*, host: str, api_key: str, timeout: float) -> None:
        raise NetworkError("boom")

    with pytest.raises(NetworkError):
        EnvpitClient.load(api_key="epk_test", poll_interval=0, _fetch_impl=failing_fetch)


def test_inv_sdk_1_direct_construction_is_rejected_no_half_initialized_client_is_reachable() -> None:
    with pytest.raises(RuntimeError):
        EnvpitClient(api_key="epk_test")


def test_inv_sdk_1_load_itself_never_fires_a_change_event() -> None:
    client = EnvpitClient.load(
        api_key="epk_test", poll_interval=0, _fetch_impl=fetch_queue(({"A": "1"}, None))
    )
    try:
        changes: list = []
        client.on_change(lambda e: changes.append(e))
        assert changes == []
    finally:
        client.close()


# ---------------------------------------------------------------------------
# INV-SDK-2 — every get*() after load is synchronous, in-memory; never a network call
# ---------------------------------------------------------------------------


def test_inv_sdk_2_getters_after_load_never_trigger_a_network_call() -> None:
    calls = {"n": 0}

    def fetch(*, host: str, api_key: str, timeout: float) -> tuple:
        calls["n"] += 1
        return {"K": "v"}, None

    client = EnvpitClient.load(api_key="epk_test", poll_interval=0, _fetch_impl=fetch)
    try:
        for _ in range(5):
            assert client.get("K") == "v"
        assert calls["n"] == 1
    finally:
        client.close()


# ---------------------------------------------------------------------------
# INV-SDK-3 — memory-only, never persisted to disk: see test_no_disk_write.py (grep gate,
# GAP-documented per CONFORMANCE.md — a negative property isn't provable positively).
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# INV-SDK-4 — stale-while-revalidate: refresh failure keeps last good snapshot, never raises
# ---------------------------------------------------------------------------


def test_inv_sdk_4_stale_while_revalidate_keeps_last_good_snapshot_on_refresh_failure() -> None:
    call_count = {"n": 0}

    def fetch(*, host: str, api_key: str, timeout: float) -> tuple:
        call_count["n"] += 1
        if call_count["n"] == 1:
            return {"K": "v0"}, None
        raise NetworkError("simulated background refresh failure")

    client = EnvpitClient.load(api_key="epk_test", poll_interval=0, _fetch_impl=fetch)
    try:
        client._refresh(is_first_load=False, trigger="poll")  # must not raise
        assert client.get("K") == "v0"
        assert client.cache_info.last_error is not None
    finally:
        client.close()


# ---------------------------------------------------------------------------
# INV-SDK-5 — generation guard: a superseded refresh outcome (success OR failure) is discarded
# ---------------------------------------------------------------------------


def test_inv_sdk_5_generation_guard_out_of_order_success_response_is_discarded() -> None:
    call_index = {"n": 0}
    release_first = threading.Event()

    def fetch(*, host: str, api_key: str, timeout: float) -> tuple:
        call_index["n"] += 1
        n = call_index["n"]
        if n == 1:
            return {"K": "v0"}, None  # initial load
        if n == 2:
            release_first.wait(2.0)  # the FIRST-triggered refresh — deliberately delayed
            return {"K": "stale"}, "etag-stale"
        return {"K": "fresh"}, "etag-fresh"  # the SECOND-triggered refresh — resolves first

    client = EnvpitClient.load(api_key="epk_test", poll_interval=0, _fetch_impl=fetch)
    try:
        changes: list = []
        client.on_change(lambda e: changes.append(e))

        t1 = threading.Thread(target=lambda: client._refresh(is_first_load=False, trigger="poll"))
        t1.start()
        assert wait_until(lambda: call_index["n"] >= 2)  # t1 has claimed the lower generation
        time.sleep(0.02)
        client._refresh(is_first_load=False, trigger="push")  # claims the higher generation
        release_first.set()
        t1.join(timeout=2.0)

        assert client.get("K") == "fresh"  # the newer response wins
        assert client.cache_info.etag == "etag-fresh"
        assert len(changes) == 1
        assert changes[0].etag == "etag-fresh"
    finally:
        client.close()


def test_inv_sdk_5_generation_guard_stale_failure_does_not_clobber_newer_success() -> None:
    call_index = {"n": 0}
    release_first = threading.Event()

    def fetch(*, host: str, api_key: str, timeout: float) -> tuple:
        call_index["n"] += 1
        n = call_index["n"]
        if n == 1:
            return {"K": "v0"}, None
        if n == 2:
            release_first.wait(2.0)
            raise NetworkError("stale failure — must be discarded, not clobber newer state")
        return {"K": "fresh"}, "etag-fresh"

    client = EnvpitClient.load(api_key="epk_test", poll_interval=0, _fetch_impl=fetch)
    try:
        errors: list = []
        client.on_error(lambda e: errors.append(e))

        t1 = threading.Thread(target=lambda: client._refresh(is_first_load=False, trigger="poll"))
        t1.start()
        assert wait_until(lambda: call_index["n"] >= 2)
        time.sleep(0.02)
        client._refresh(is_first_load=False, trigger="push")
        release_first.set()
        t1.join(timeout=2.0)

        assert client.get("K") == "fresh"
        assert client.cache_info.last_error is None  # the stale FAILURE must not clobber this
        assert errors == []  # ...and must not fire a spurious error event
    finally:
        client.close()


# ---------------------------------------------------------------------------
# INV-SDK-6 — safe listener dispatch: a raising listener can never crash the SDK/host, and
# never blocks other subscribers
# ---------------------------------------------------------------------------


def test_inv_sdk_6_safe_listener_dispatch_a_throwing_listener_does_not_block_others_or_crash() -> None:
    logged: list = []

    class _Logger:
        def error(self, message: str) -> None:
            logged.append(message)

    fetch = fetch_queue(({"K": "v0"}, None), ({"K": "v1"}, None))
    client = EnvpitClient.load(api_key="epk_test", poll_interval=0, logger=_Logger(), _fetch_impl=fetch)
    try:
        order: list = []

        def bad(event: object) -> None:
            order.append("bad")
            raise RuntimeError("listener blew up")

        def good(event: object) -> None:
            order.append("good")

        client.on_change(bad)
        client.on_change(good)
        client._refresh(is_first_load=False, trigger="poll")  # must not raise/crash

        assert order == ["bad", "good"]
        assert any("a config event listener raised" in line for line in logged)
    finally:
        client.close()


# ---------------------------------------------------------------------------
# INV-SDK-7 — change payload is key NAMES only, null≡absent, no-op when nothing differs,
# snapshot applied before delivery
# ---------------------------------------------------------------------------


def test_inv_sdk_7_change_payload_is_key_names_only_and_snapshot_applied_before_delivery() -> None:
    # Deliberately distinctive (non-digit) values so the value-absence assertion below can't be
    # accidentally satisfied by a coincidental digit inside the event's own timestamp field.
    fetch = fetch_queue(
        ({"A": "before-secret-alpha"}, None), ({"A": "after-secret-alpha", "B": "after-secret-beta"}, None)
    )
    client = EnvpitClient.load(api_key="epk_test", poll_interval=0, _fetch_impl=fetch)
    try:
        seen: dict = {}

        def handler(event: object) -> None:
            seen["A"] = client.get("A")
            seen["B"] = client.get("B")
            seen["repr"] = repr(event)

        client.on_change(handler)
        client._refresh(is_first_load=False, trigger="poll")

        assert seen["A"] == "after-secret-alpha"
        assert seen["B"] == "after-secret-beta"
        assert "secret-alpha" not in seen["repr"]
        assert "secret-beta" not in seen["repr"]
        assert "changed_keys=['A', 'B']" in seen["repr"]  # key NAMES only, sorted
    finally:
        client.close()


def test_inv_sdk_7_no_change_event_fires_when_nothing_differs() -> None:
    fetch = fetch_queue(({"A": "1"}, None), ({"A": "1"}, None))
    client = EnvpitClient.load(api_key="epk_test", poll_interval=0, _fetch_impl=fetch)
    try:
        changes: list = []
        client.on_change(lambda e: changes.append(e))
        client._refresh(is_first_load=False, trigger="poll")
        assert changes == []
    finally:
        client.close()


# ---------------------------------------------------------------------------
# INV-SDK-8 — poll is the correctness backstop; poll_interval 0 disables ALL background refresh
# ---------------------------------------------------------------------------


def test_inv_sdk_8_poll_interval_zero_disables_all_background_refresh_including_realtime() -> None:
    client = EnvpitClient.load(
        api_key="epk_test", poll_interval=0, _fetch_impl=fetch_queue(({"K": "v"}, None))
    )
    try:
        assert client.cache_info.refresh_mode == "off"
        assert client._poll_thread is None
        assert client._realtime is None
    finally:
        client.close()


# ---------------------------------------------------------------------------
# INV-SDK-9 — etag dedup on push; catch-up refetch on every reconnect except the first connect
# ---------------------------------------------------------------------------


def test_inv_sdk_9_etag_dedup_on_push_with_same_etag_does_not_trigger_a_refetch() -> None:
    stream = FakeSseStream()
    calls = {"n": 0}

    def fetch(*, host: str, api_key: str, timeout: float) -> tuple:
        calls["n"] += 1
        return {"K": "v0"}, "same-etag"

    client = EnvpitClient.load(
        api_key="epk_test",
        poll_interval=3600,
        _fetch_impl=fetch,
        _sse_opener=lambda url, headers, timeout: stream,
    )
    try:
        assert wait_until(lambda: client.cache_info.refresh_mode == "realtime")
        changes: list = []
        client.on_change(lambda e: changes.append(e))

        stream.push('event: config-changed\ndata: {"etag":"same-etag"}\n\n')
        time.sleep(0.2)

        assert changes == []
        assert calls["n"] == 1
    finally:
        client.close()


def test_inv_sdk_9_reconnect_after_first_connect_triggers_catch_up_refetch_not_on_first_connect() -> None:
    from datetime import datetime, timezone

    # First connect (via a real, injected SSE opener) must NOT catch-up refetch — proven by
    # observing that only the initial fetch ran and `K` is still the first-load value. The
    # SECOND `realtime`-mode transition is then driven directly at `EnvpitClient`'s own
    # reconnect-catch-up gate (`_handle_connection_mode_change`) — this is the precise unit
    # under test for INV-SDK-9's "except the very first connect" rule; `RealtimeTransport`
    # itself only calls that gate when its own `mode` actually flips (proven separately by
    # INV-SDK-10's cadence test), so driving it directly here tests the invariant without
    # depending on real multi-second quick-retry/degraded-backoff timing to force a second
    # transition end-to-end.
    fetch = fetch_queue(({"K": "v0"}, None), ({"K": "v1"}, None))
    client = EnvpitClient.load(
        api_key="epk_test",
        poll_interval=3600,
        _fetch_impl=fetch,
        _sse_opener=lambda url, headers, timeout: FakeSseStream(),
    )
    try:
        assert wait_until(lambda: client.cache_info.refresh_mode == "realtime")
        assert client.get("K") == "v0"  # unchanged — the first connect did NOT catch-up refetch

        changes: list = []
        client.on_change(lambda e: changes.append(e))

        client._handle_connection_mode_change("realtime", "connected", datetime.now(timezone.utc))

        assert wait_until(lambda: len(changes) == 1)
        assert changes[0].trigger == "reconnect"
        assert client.get("K") == "v1"
    finally:
        client.close()


# ---------------------------------------------------------------------------
# INV-SDK-10 — quiet-retry/degraded diagnostics cadence: never per-attempt noise
# ---------------------------------------------------------------------------


def test_inv_sdk_10_degraded_diagnostics_cadence_one_retry_one_info_one_warn_never_per_attempt() -> None:
    log_lines: list = []
    mode_changes: list = []

    def opener(url: str, headers: dict, timeout: float) -> None:
        raise ConnectionError("refused")

    transport = RealtimeTransport(
        host="https://example.test",
        api_key="epk_test",
        poll_interval_s=60,
        callbacks=RealtimeCallbacks(
            on_change_signal=lambda etag: None,
            on_mode_change=lambda mode, reason, since: mode_changes.append((mode, reason)),
            on_log=lambda level, msg: log_lines.append((level, msg)),
        ),
        opener=opener,
        quick_reconnect_delay_s=0.02,
        degraded_reconnect_interval_s=0.05,
        degraded_reconnect_jitter_s=0.0,
        warn_threshold_s=0.3,
    )
    transport.start()
    time.sleep(1.0)
    transport.close()

    infos = [m for (level, m) in log_lines if level == "info"]
    warns = [m for (level, m) in log_lines if level == "warn"]
    assert len(infos) == 1  # exactly one "unavailable, falling back" line for the whole episode
    assert len(warns) == 1  # exactly one "still unavailable after N min" line
    # No `connection` event fires here: `mode` starts as `'polling'` by default (this transport
    # never successfully connected even once), so a failure that keeps it `'polling'` is not a
    # transition — matches shipped Node's identical `modeChanged` guard (realtime-transport.ts
    # `declareDegraded`). A `connection` event only fires on an ACTUAL flip (e.g. realtime ->
    # polling, or polling -> realtime after a real connect) — never per retry attempt either way.
    assert mode_changes == []


# ---------------------------------------------------------------------------
# INV-SDK-11 — no config value/API key ever in an error/log line; background work never blocks
# process exit (daemon threads)
# ---------------------------------------------------------------------------


def test_inv_sdk_11_no_api_key_or_config_value_ever_appears_in_a_thrown_error_message() -> None:
    secret_key = "epk_super-secret-do-not-leak-this-value"
    messages: list = []

    def fetch_401(*, host: str, api_key: str, timeout: float) -> None:
        raise AuthenticationError("API key rejected (HTTP 401). It may be revoked, expired, or mistyped.")

    def fetch_network_failure(*, host: str, api_key: str, timeout: float) -> None:
        raise NetworkError("Could not reach EnvPit (connect ECONNREFUSED).")

    try:
        EnvpitClient.load(api_key=secret_key, poll_interval=0, _fetch_impl=fetch_401)
    except AuthenticationError as exc:
        messages.append(str(exc))

    try:
        EnvpitClient.load(api_key=secret_key, poll_interval=0, _fetch_impl=fetch_network_failure)
    except NetworkError as exc:
        messages.append(str(exc))

    client = EnvpitClient.load(
        api_key=secret_key,
        poll_interval=0,
        _fetch_impl=fetch_queue(({"PORT": "not-a-number"}, None)),
    )
    try:
        try:
            client.get("MISSING_KEY")
        except MissingKeyError as exc:
            messages.append(str(exc))
        try:
            client.get_int("PORT")
        except TypeMismatchError as exc:
            messages.append(str(exc))
    finally:
        client.close()

    assert len(messages) == 4  # sanity: all 4 intended throw paths were actually exercised
    for message in messages:
        assert secret_key not in message


def test_inv_sdk_11_background_daemon_threads_never_block_process_exit() -> None:
    client = EnvpitClient.load(
        api_key="epk_test", poll_interval=0.05, _fetch_impl=fetch_queue(({"K": "v"}, None))
    )
    try:
        assert client._poll_thread is not None
        assert client._poll_thread.daemon is True
        assert client._realtime is not None
        assert client._realtime._thread is not None
        assert client._realtime._thread.daemon is True
    finally:
        client.close()


# ---------------------------------------------------------------------------
# INV-SDK-12 — ENVPIT_API_KEY auto-detect, explicit wins; header is X-Api-Key, never
# Authorization
# ---------------------------------------------------------------------------


def test_inv_sdk_12_explicit_api_key_wins_over_env_var(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVPIT_API_KEY", "epk_from_env")
    client = EnvpitClient.load(
        api_key="epk_explicit", poll_interval=0, _fetch_impl=fetch_queue(({"K": "v"}, None))
    )
    try:
        assert client._api_key == "epk_explicit"
    finally:
        client.close()


def test_inv_sdk_12_env_var_used_when_no_explicit_key_given(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVPIT_API_KEY", "epk_from_env")
    client = EnvpitClient.load(poll_interval=0, _fetch_impl=fetch_queue(({"K": "v"}, None)))
    try:
        assert client._api_key == "epk_from_env"
    finally:
        client.close()


def test_inv_sdk_12_no_api_key_anywhere_raises_authentication_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("ENVPIT_API_KEY", raising=False)
    with pytest.raises(AuthenticationError):
        EnvpitClient.load(poll_interval=0, _fetch_impl=fetch_queue(({"K": "v"}, None)))


def test_inv_sdk_12_config_fetch_sends_x_api_key_header_and_never_authorization() -> None:
    from envpit.transport import fetch_config

    from ._utils import FakeHttpResponse

    seen_headers: dict = {}

    def urlopen(request: object, timeout: float) -> FakeHttpResponse:
        seen_headers.update(dict(request.header_items()))  # type: ignore[attr-defined]
        return FakeHttpResponse(b'{"K":"v"}', headers={})

    fetch_config(host="https://example.test", api_key="epk_test", timeout=1.0, urlopen=urlopen)

    assert any(name.lower() == "x-api-key" for name in seen_headers)
    assert not any(name.lower() == "authorization" for name in seen_headers)
    assert seen_headers[[n for n in seen_headers if n.lower() == "x-api-key"][0]] == "epk_test"
