"""Regression coverage for `bd:envpit-4dbm` — a mid-connection TCP reset
(`http.client.RemoteDisconnected`: a server that accepted the connection, read the request, then
closed with zero response bytes — a pod killed mid-request, an LB idle-timeout race, a
NAT/firewall RST) is NOT a `urllib.error.URLError` subclass, so it used to escape
`transport.fetch_config()` unwrapped: not `NetworkError`, not even `EnvpitError`. Two distinct
consequences, both covered here:

1. FIRST LOAD: the raw stdlib exception escaped `EnvpitClient.load()` directly, breaking the
   documented "load() raises EnvpitError" contract.
2. BACKGROUND REFRESH: `cache_info.last_error` held the raw stdlib exception (not `NetworkError`,
   inconsistent with every other failure mode), AND `on_error()` listeners never fired (client.py
   only emits when `isinstance(error, EnvpitError)` — false for the raw type).

`test_error_mapping_vectors.py` covers the transport-level mapping via the shared
`test-vectors/error-mapping.json` `connection-reset-mid-request-is-network-error` case (added by
this same fix); this file covers the CLIENT-level consequences end-to-end (first-load raise
shape, `cache_info.last_error` typing, and `on_error()` firing on the background-refresh path)
that the vector file alone can't exercise, using the REAL `transport.fetch_config` (not a
re-implementation) through a fake `urlopen` seam, exactly like the vector-consumption tests do."""

from __future__ import annotations

import http.client

import pytest

from envpit.client import EnvpitClient
from envpit.errors import EnvpitError, NetworkError
from envpit.transport import fetch_config

from ._utils import FakeHttpResponse, wait_until


def _fetch_impl_via_transport(urlopen):
    """Wraps the REAL `transport.fetch_config` with a fake low-level `urlopen`, so `EnvpitClient`
    tests exercise transport.py's actual exception-mapping logic (not a shortcut `_fetch_impl`
    that returns/raises `NetworkError` directly, which would test nothing about the bug)."""

    def _fetch(*, host: str, api_key: str, timeout: float):
        return fetch_config(host=host, api_key=api_key, timeout=timeout, urlopen=urlopen)

    return _fetch


# ---------------------------------------------------------------------------
# Consequence 1 — FIRST LOAD
# ---------------------------------------------------------------------------


def test_bd_envpit_4dbm_first_load_raises_network_error_not_the_raw_stdlib_exception() -> None:
    def urlopen(request, timeout):  # noqa: ANN001, ANN202
        raise http.client.RemoteDisconnected("Remote end closed connection without response")

    with pytest.raises(NetworkError) as excinfo:
        EnvpitClient.load(
            api_key="epk_test", poll_interval=0, _fetch_impl=_fetch_impl_via_transport(urlopen)
        )
    # Not just "some EnvpitError" — confirm it's specifically NOT the raw stdlib type leaking
    # through disguised as something else, and that `except EnvpitError` (the SDK's own
    # documented catch-all pattern) would actually catch it.
    assert isinstance(excinfo.value, EnvpitError)
    assert not isinstance(excinfo.value, http.client.RemoteDisconnected)


def test_bd_envpit_4dbm_load_raising_network_error_is_caught_by_the_documented_except_pattern() -> None:
    """The exact pattern the SDK's own docs teach (`except envpit.NetworkError:` /
    `except envpit.EnvpitError:` around startup `load()`) must actually catch this — pre-fix, it
    did not, because the raw `http.client.RemoteDisconnected` isn't an `EnvpitError` at all."""

    def urlopen(request, timeout):  # noqa: ANN001, ANN202
        raise http.client.RemoteDisconnected("Remote end closed connection without response")

    caught = False
    try:
        EnvpitClient.load(
            api_key="epk_test", poll_interval=0, _fetch_impl=_fetch_impl_via_transport(urlopen)
        )
    except NetworkError:
        caught = True
    assert caught


# ---------------------------------------------------------------------------
# Consequence 2 — BACKGROUND REFRESH: cache_info.last_error typing + on_error() firing
# ---------------------------------------------------------------------------


def test_bd_envpit_4dbm_background_refresh_records_network_error_not_the_raw_exception() -> None:
    # First call must succeed for this scenario (a background refresh, not a first load); the
    # 2nd+ call hits the reset.
    calls = {"n": 0}

    def flip_urlopen(request, timeout):  # noqa: ANN001, ANN202
        calls["n"] += 1
        if calls["n"] == 1:
            return FakeHttpResponse(b'{"K":"v0"}', headers={})
        raise http.client.RemoteDisconnected("Remote end closed connection without response")

    client = EnvpitClient.load(
        api_key="epk_test",
        poll_interval=0,
        _fetch_impl=_fetch_impl_via_transport(flip_urlopen),
    )
    try:
        assert client.cache_info.last_error is None

        client._refresh(is_first_load=False, trigger="poll")  # hits the reset (2nd call)

        # Stale-while-error: the last GOOD value is still served correctly (unaffected by this
        # bug, confirmed as still-working, not just assumed).
        assert client.get("K") == "v0"

        last_error = client.cache_info.last_error
        assert last_error is not None
        assert isinstance(last_error, NetworkError), (
            f"cache_info.last_error must be NetworkError, not the raw stdlib exception; "
            f"got {type(last_error).__name__}"
        )
        assert not isinstance(last_error, http.client.RemoteDisconnected)
    finally:
        client.close()


def test_bd_envpit_4dbm_on_error_fires_for_a_mid_connection_reset_on_background_refresh() -> None:
    calls = {"n": 0}

    def flip_urlopen(request, timeout):  # noqa: ANN001, ANN202
        calls["n"] += 1
        if calls["n"] == 1:
            return FakeHttpResponse(b'{"K":"v0"}', headers={})
        raise http.client.RemoteDisconnected("Remote end closed connection without response")

    client = EnvpitClient.load(
        api_key="epk_test",
        poll_interval=0,
        _fetch_impl=_fetch_impl_via_transport(flip_urlopen),
    )
    try:
        errors: list = []
        client.on_error(lambda e: errors.append(e))

        client._refresh(is_first_load=False, trigger="poll")  # hits the reset

        # Pre-fix: this listener never fired at all (client.py's `isinstance(error, EnvpitError)`
        # guard was False for the raw stdlib exception type) — confirmed here it fires exactly
        # once, with the correctly-typed error.
        assert len(errors) == 1
        assert isinstance(errors[0], NetworkError)
    finally:
        client.close()


def test_bd_envpit_4dbm_background_refresh_self_heals_once_the_connection_stops_resetting() -> None:
    """Full end-to-end sanity via the real poll thread (not just a manually-driven `_refresh()`
    call): a reset that stops happening is recovered from automatically, same as any other
    transient network failure (INV-SDK-4's stale-while-revalidate contract already covers this
    once the error is correctly typed as `NetworkError` — this proves the fix doesn't merely
    relabel the error while leaving recovery broken)."""
    calls = {"n": 0}

    def flip_urlopen(request, timeout):  # noqa: ANN001, ANN202
        calls["n"] += 1
        if calls["n"] == 1:
            return FakeHttpResponse(b'{"K":"v0"}', headers={})
        if calls["n"] == 2:
            raise http.client.RemoteDisconnected("Remote end closed connection without response")
        return FakeHttpResponse(b'{"K":"v1"}', headers={})

    client = EnvpitClient.load(
        api_key="epk_test",
        poll_interval=0.05,
        _fetch_impl=_fetch_impl_via_transport(flip_urlopen),
    )
    try:
        assert wait_until(lambda: client.cache_info.last_error is not None)
        assert isinstance(client.cache_info.last_error, NetworkError)
        assert wait_until(lambda: client.get("K") == "v1")
        assert wait_until(lambda: client.cache_info.last_error is None)
    finally:
        client.close()
