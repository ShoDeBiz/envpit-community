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

import threading
from collections.abc import Callable

from .client import EnvpitClient
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
) -> EnvpitClient:
    """Fetches your environment's config once (blocking) and sets the module-level default
    client so `envpit.get(...)` etc. delegate to it. Also returns the client explicitly — the
    instance is the primitive; this is a thin lazy delegate on top of it."""
    global _default_client
    client = EnvpitClient.load(
        api_key=api_key, host=host, poll_interval=poll_interval, timeout=timeout, logger=logger
    )
    with _default_lock:
        _default_client = client
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


def close() -> None:
    global _default_client
    with _default_lock:
        client = _default_client
        _default_client = None
    if client is not None:
        client.close()
