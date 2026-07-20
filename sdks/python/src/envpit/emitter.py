"""A tiny, thread-safe event dispatcher — the Python equivalent of the shipped Node SDK's
`SafeEmitter` (`sdks/node/src/emitter.ts`, bd:envpit-r59g). One instance per event
(`EnvpitClient` holds three: change/connection/error) rather than Node's generic
`on(event, cb)` — Sara §2.1: "typed registration methods... snake_case idiomatic".

Two safety properties, both load-bearing (INV-SDK-6):
1. A listener that raises is caught, reported through the injected `Logger` (never re-raised
   to `emit()`'s caller), and every OTHER listener still runs.
2. Registering an `async def` callback is REJECTED IMMEDIATELY with a `TypeError` (Sara §3.1 /
   Uma AC-UX3-05) — the Python-specific footgun this class exists to design away is not a
   crash (Node's failure mode) but SILENCE: an async callback registered on a sync dispatcher
   returns a never-awaited coroutine, so the handler "isn't running" with zero observable
   signal. Fail fast and loud at registration instead. A dispatch-time belt additionally
   catches `functools.partial`-wrapped / duck-typed callables that evade the registration-time
   `inspect.iscoroutinefunction` check but still return an awaitable when invoked: the
   awaitable is closed (never silently GC'd unawaited) and one warning is logged.

Thread-safe: listener-set mutation (register/unsubscribe) is guarded by a lock; dispatch
snapshots the listener set under that same lock before iterating (outside the lock) so a
listener that unsubscribes itself or another listener mid-dispatch can never corrupt the
iteration — same guarantee Node gets from `Set` iteration semantics, needed here because the
poll thread and the realtime thread can both trigger `emit()` concurrently.
"""

from __future__ import annotations

import functools
import inspect
import threading
from collections.abc import Callable
from typing import Generic, TypeVar

from .types import Logger

T = TypeVar("T")
Listener = Callable[[T], None]


def _unwrap_partial(fn: object) -> object:
    while isinstance(fn, functools.partial):
        fn = fn.func
    return fn


def _is_coroutine_callable(fn: object) -> bool:
    target = _unwrap_partial(fn)
    if inspect.iscoroutinefunction(target):
        return True
    call = getattr(target, "__call__", None)  # noqa: B004 - deliberate, see docstring
    if call is not None and call is not target and inspect.iscoroutinefunction(call):
        return True
    return False


ASYNC_CALLBACK_REJECTION_MESSAGE = (
    "envpit: async callbacks are not supported by the sync client — use a sync callback, or "
    "bridge with asyncio.run_coroutine_threadsafe(your_coro, your_loop)"
)


class SafeEmitter(Generic[T]):
    def __init__(self, event_name: str, logger: Logger | None = None) -> None:
        self._event_name = event_name
        self._logger = logger
        self._lock = threading.Lock()
        self._listeners: dict[int, Listener[T]] = {}

    def on(self, listener: Listener[T]) -> Callable[[], None]:
        if _is_coroutine_callable(listener):
            raise TypeError(ASYNC_CALLBACK_REJECTION_MESSAGE)

        key = id(listener)
        with self._lock:
            self._listeners[key] = listener

        unsubscribed = False

        def unsubscribe() -> None:
            nonlocal unsubscribed
            if unsubscribed:
                return
            unsubscribed = True
            with self._lock:
                self._listeners.pop(key, None)

        return unsubscribe

    def reset_lock_after_fork(self) -> None:
        """`os.fork()` atfork hook helper (bd:envpit-p261): only the calling thread survives a
        fork, so `self._lock` could be inherited by a forked child in a locked state if some
        other thread happened to be mid-`on()`/`emit()` at the exact instant of fork — a lock
        held by a now-nonexistent thread would deadlock forever if reused as-is. Discarded for
        a fresh, always-unlocked one; registered listener callables are preserved as-is (plain
        data with no thread ownership, safe to keep)."""
        self._lock = threading.Lock()

    def emit(self, payload: T) -> None:
        with self._lock:
            listeners = list(self._listeners.values())
        for listener in listeners:
            try:
                result = listener(payload)
            except Exception as exc:  # noqa: BLE001 - deliberate catch-all; never BaseException
                self._report_listener_error(exc)
                continue
            if inspect.isawaitable(result):
                self._handle_stray_awaitable(result)

    def _handle_stray_awaitable(self, awaitable: object) -> None:
        close = getattr(awaitable, "close", None)
        if callable(close):
            try:
                close()
            except Exception:  # noqa: BLE001
                pass
        self._safe_log(
            "warn",
            f"envpit: a {self._event_name} listener returned an awaitable that will never be "
            "awaited — use a sync callback (see the error-handling guide)",
        )

    def _report_listener_error(self, exc: Exception) -> None:
        self._safe_log(
            "error",
            f"envpit: a config event listener raised (event: {self._event_name}): {exc}",
        )

    def _safe_log(self, level: str, message: str) -> None:
        if self._logger is None:
            return
        method = getattr(self._logger, level, None)
        if not callable(method):
            return
        try:
            method(message)
        except Exception:  # noqa: BLE001 - a panicking injected logger must not crash the SDK
            pass
