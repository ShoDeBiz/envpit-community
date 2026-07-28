"""EnvPit — Python SDK. `envpit.load()` is the module-level sugar entry point (Sara §2.1: the
instantiated `EnvpitClient` is the primitive in every language; Python/Node get a module-level
default-instance sugar layer). `envpit.get(...)`/`get_int(...)`/etc. delegate to whichever
client was most recently `load()`ed.

Async usage (Sara ADR-S3-03, the reconciled decision — NOT a dedicated `aload()` method, no
extra API surface): `load()` only blocks once, at startup. From an asyncio app, either call it
in your lifespan/startup hook (before the event loop needs to be responsive), or wrap it —
`await asyncio.to_thread(envpit.load)` — if you'd rather not block the loop even there. Every
`get*()` read after that is a plain synchronous in-memory lookup either way; there is no
separate async code path to keep in sync with the sync one.
"""

from __future__ import annotations

import os
import threading
from collections.abc import Callable, Collection, MutableMapping

from .client import EnvpitClient, FetchImpl
from .errors import (
    AuthenticationError,
    EnvpitError,
    MissingKeyError,
    NetworkError,
    TypeMismatchError,
)
from .types import (
    CacheInfo,
    ChangeEvent,
    ChangeTrigger,
    ConfigSnapshot,
    ConnectionEvent,
    ConnectionMode,
    ConnectionReason,
    Logger,
)

__all__ = [
    "EnvpitClient",
    "EnvpitError",
    "AuthenticationError",
    "NetworkError",
    "MissingKeyError",
    "TypeMismatchError",
    "ConfigSnapshot",
    "ChangeEvent",
    "ChangeTrigger",
    "ConnectionEvent",
    "ConnectionMode",
    "ConnectionReason",
    "CacheInfo",
    "Logger",
    "load",
    "get",
    "get_string",
    "get_int",
    "get_bool",
    "on_change",
    "on_connection",
    "on_error",
    "cache_info",
    "close",
    "populate_environ",
]

_default_lock = threading.Lock()
_default_client: EnvpitClient | None = None


def load(
    *,
    api_key: str | None = None,
    host: str | None = None,
    poll_interval: float = 60.0,
    timeout: float = 5.0,
    logger: Logger | None = None,
    _fetch_impl: FetchImpl | None = None,
    _sse_opener: Callable[..., object] | None = None,
) -> EnvpitClient:
    """Fetches your environment's config once (blocking) and sets the module-level default
    client so `envpit.get(...)` etc. delegate to it. Also returns the client explicitly — the
    instance is the primitive; this is a thin lazy delegate on top of it.

    Calling `load()` again (e.g. a hot-reload dev server re-executing module-level setup code,
    or a test suite loading more than once without explicit teardown) `close()`s the OUTGOING
    default client's background poll+realtime threads before installing the new one
    (bd:envpit-igc0) — the previous default is never orphaned/unstoppable. The new client is
    installed under `_default_lock` first (so `envpit.get(...)` etc. never observe a gap), and
    the old client's `close()` (which can block briefly joining its threads) runs OUTSIDE that
    lock so it can never stall an unrelated concurrent `envpit.get(...)` call.

    `_fetch_impl`/`_sse_opener` are test-only injectable seams (leading underscore — not part
    of the documented public surface), mirroring `EnvpitClient.load()`'s own seams, so the
    module-level sugar layer can be exercised directly in tests without a real network call."""
    global _default_client
    client = EnvpitClient.load(
        api_key=api_key,
        host=host,
        poll_interval=poll_interval,
        timeout=timeout,
        logger=logger,
        _fetch_impl=_fetch_impl,
        _sse_opener=_sse_opener,
    )
    with _default_lock:
        previous = _default_client
        _default_client = client
    if previous is not None:
        previous.close()
    return client


def _require_default() -> EnvpitClient:
    with _default_lock:
        client = _default_client
    if client is None:
        raise RuntimeError("envpit: no default client — call envpit.load() first.")
    return client


def get(key: str, default: str | None = None) -> str:
    return _require_default().get(key, default)


def get_string(key: str, default: str | None = None) -> str:
    return _require_default().get_string(key, default)


def get_int(key: str, default: int | None = None) -> int:
    return _require_default().get_int(key, default)


def get_bool(key: str, default: bool | None = None) -> bool:
    return _require_default().get_bool(key, default)


def on_change(listener: Callable[[ChangeEvent], None]) -> Callable[[], None]:
    return _require_default().on_change(listener)


def on_connection(listener: Callable[[ConnectionEvent], None]) -> Callable[[], None]:
    return _require_default().on_connection(listener)


def on_error(listener: Callable[[EnvpitError], None]) -> Callable[[], None]:
    return _require_default().on_error(listener)


def cache_info() -> CacheInfo:
    return _require_default().cache_info


def populate_environ(
    *,
    override: bool = False,
    exclude: Collection[str] | None = None,
    environ: MutableMapping[str, str] | None = None,
) -> set[str]:
    """Module-sugar delegate for `EnvpitClient.populate_environ()` — see its docstring
    (`client.py`) for the full contract (opt-in only, no-override-by-default, boot-time
    snapshot, no secret filtering — bd:envpit-yvyr)."""
    return _require_default().populate_environ(override=override, exclude=exclude, environ=environ)


def close() -> None:
    global _default_client
    with _default_lock:
        client = _default_client
        _default_client = None
    if client is not None:
        client.close()


def _reset_default_lock_after_fork() -> None:
    """`os.fork()` atfork hook (bd:envpit-p261's adjacent hazard): only the calling thread
    survives a fork, so `_default_lock` could be inherited by a forked child in a locked state
    if some OTHER thread happened to be inside `envpit.load()`/`close()`/a getter at the exact
    instant of fork — which would deadlock every module-sugar call in the child forever (a
    silent freeze, same failure class this bd exists to eliminate). Discarding it for a fresh,
    always-unlocked one is safe unconditionally: this lock only ever guards a plain pointer
    swap, so there is no partial state worth preserving across a fork either way. Registered
    once at import time — `os.register_at_fork` has no unregister API, so this fires for every
    fork for the life of the process; that's fine, the reset is idempotent and cheap. See
    `EnvpitClient._handle_fork_in_child` (client.py) for the matching per-instance reset."""
    global _default_lock
    _default_lock = threading.Lock()


if hasattr(os, "register_at_fork"):  # POSIX only — no-op on platforms without os.fork()
    os.register_at_fork(after_in_child=_reset_default_lock_after_fork)
