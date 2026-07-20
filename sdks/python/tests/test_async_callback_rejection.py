"""AC-UX3-05 / Sara §3.1: registering an `async def` callback (or a partial-wrapped/duck-typed
callable that evades that static check but still returns an awaitable when invoked) must be
rejected with a clear, actionable `TypeError` at REGISTRATION time — not silently accepted and
mishandled later. This is the Python-specific footgun class (silence, not a crash) this design
exists to close: a sync dispatcher never awaits a returned coroutine, so an accepted async
listener would otherwise "not run" with zero observable signal."""

from __future__ import annotations

import asyncio
import functools

import pytest

from envpit.client import EnvpitClient
from envpit.emitter import SafeEmitter

from ._utils import fetch_queue


def test_async_def_callback_is_rejected_at_registration_with_a_clear_typeerror() -> None:
    emitter: SafeEmitter = SafeEmitter("change")

    async def bad_listener(event: object) -> None:
        pass

    with pytest.raises(TypeError, match="async callbacks are not supported"):
        emitter.on(bad_listener)


def test_partial_wrapped_coroutine_function_is_also_rejected_at_registration() -> None:
    emitter: SafeEmitter = SafeEmitter("change")

    async def bad_listener(prefix: str, event: object) -> None:
        pass

    wrapped = functools.partial(bad_listener, "x")
    with pytest.raises(TypeError, match="async callbacks are not supported"):
        emitter.on(wrapped)


def test_bound_async_method_is_also_rejected_at_registration() -> None:
    emitter: SafeEmitter = SafeEmitter("change")

    class Handler:
        async def handle(self, event: object) -> None:
            pass

    with pytest.raises(TypeError, match="async callbacks are not supported"):
        emitter.on(Handler().handle)


def test_dispatch_time_belt_closes_a_stray_awaitable_and_warns_exactly_once() -> None:
    """Covers the case that evades the registration-time `inspect.iscoroutinefunction` check
    entirely (a plain callable whose `__call__` itself is not `async def`, but returns an
    awaitable at runtime) — Sara §3.1's explicit "belt" layer."""
    warned: list = []

    class _Logger:
        def warn(self, message: str) -> None:
            warned.append(message)

    emitter: SafeEmitter = SafeEmitter("change", _Logger())

    class DuckAsyncCallable:
        def __call__(self, event: object) -> object:
            async def _inner() -> None:
                return None

            return _inner()

    emitter.on(DuckAsyncCallable())
    emitter.emit(object())

    assert len(warned) == 1
    assert "awaitable that will never be awaited" in warned[0]


def test_client_on_change_rejects_an_async_callback_at_registration() -> None:
    client = EnvpitClient.load(
        api_key="epk_test", poll_interval=0, _fetch_impl=fetch_queue(({"K": "v"}, None))
    )
    try:
        async def bad(event: object) -> None:
            pass

        with pytest.raises(TypeError, match="async callbacks are not supported"):
            client.on_change(bad)
    finally:
        client.close()


def test_client_on_connection_and_on_error_also_reject_async_callbacks() -> None:
    client = EnvpitClient.load(
        api_key="epk_test", poll_interval=0, _fetch_impl=fetch_queue(({"K": "v"}, None))
    )
    try:
        async def bad(event: object) -> None:
            pass

        with pytest.raises(TypeError):
            client.on_connection(bad)
        with pytest.raises(TypeError):
            client.on_error(bad)
    finally:
        client.close()


# ---------------------------------------------------------------------------
# AC-PY-01 (reconciled — Sara ADR-S3-03 supersedes Bella's original dual load()/aload() ask):
# the documented async escape hatch is `await asyncio.to_thread(envpit.load)`, NOT a dedicated
# `aload()` method. This proves that pattern actually works: the sync `load()` runs off the
# event loop thread and the returned client behaves identically either way.
# ---------------------------------------------------------------------------


def test_ac_py_01_async_context_uses_load_via_asyncio_to_thread_without_a_dedicated_aload() -> None:
    assert not hasattr(EnvpitClient, "aload")  # confirms the "no extra API surface" decision

    async def _run() -> None:
        client = await asyncio.to_thread(
            EnvpitClient.load,
            api_key="epk_test",
            poll_interval=0,
            _fetch_impl=fetch_queue(({"K": "v"}, None)),
        )
        try:
            assert client.get("K") == "v"
        finally:
            client.close()

    asyncio.run(_run())
