"""Shared types for the EnvPit Python SDK.

`ConfigSnapshot` mirrors the shipped Node SDK's shape 1:1 (key -> value map, secret-flagged
keys already decrypted server-side, non-secret keys as-is). `Logger` is a structural (duck-typed)
protocol — pass a stdlib `logging.Logger`, or any object exposing a subset of these methods;
absent methods are simply never called (Sara §2.1: "silent by default, observable by choice").
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal, Protocol, runtime_checkable

ConfigSnapshot = dict[str, str | None]

ChangeTrigger = Literal["push", "poll", "reconnect"]
ConnectionMode = Literal["realtime", "polling"]
ConnectionReason = Literal["connected", "server-reconnect", "network", "unsupported", "shutdown"]
RefreshMode = Literal["realtime", "polling", "off"]


@runtime_checkable
class Logger(Protocol):
    """Structurally compatible with a stdlib `logging.Logger` (which has `.debug/.info/.warning`
    and a deprecated-but-present `.warn` alias) or any hand-rolled object exposing a subset of
    these four methods. SDK log lines are always English and NEVER contain a config value —
    only key names/counts/durations (INV-SDK-11)."""

    def debug(self, message: str) -> None: ...
    def info(self, message: str) -> None: ...
    def warn(self, message: str) -> None: ...
    def error(self, message: str) -> None: ...


@dataclass(frozen=True)
class ChangeEvent:
    """Payload of a `change` event. Log-safe by construction (INV-SDK-7): key NAMES only,
    never values — safe to pass through any structured-log formatter."""

    changed_keys: list[str]
    etag: str | None
    received_at: datetime
    trigger: ChangeTrigger


@dataclass(frozen=True)
class ConnectionEvent:
    """Payload of a `connection` event — fires ONLY on an actual `mode` transition, never once
    per (re)connect attempt."""

    mode: ConnectionMode
    since: datetime
    reason: ConnectionReason


@dataclass(frozen=True)
class CacheInfo:
    """Point-in-time view of the SDK's in-memory cache — the pull-style equivalent of the
    `change`/`connection`/`error` push-style events."""

    fetched_at: datetime | None
    age_ms: float | None
    last_error: BaseException | None
    etag: str | None
    refresh_mode: RefreshMode
    realtime_since: datetime | None
    last_change_at: datetime | None
