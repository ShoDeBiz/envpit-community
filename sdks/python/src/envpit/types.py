"""Shared types for the EnvPit Python SDK.

`ConfigSnapshot` mirrors the shipped Node SDK's shape 1:1 — the UNWRAPPED `{values, secretKeys}`
resolve envelope (bd:envpit-durd, AC-SEC-E11): `values` is the key -> value map (secret-flagged
keys already decrypted server-side, non-secret keys as-is — WHO can read a decrypted secret is
unchanged by this shape, it only labels which keys are secret), `secret_keys` is the frozenset of
key NAMES flagged `is_secret=true` server-side (never values — log-safe by construction, same
convention as `ChangeEvent.changed_keys`). A secret key whose value is unset in this environment
still appears in `secret_keys` while its `values` entry is `None` (the flag is key-level, not
value-level; see `test-vectors/resolve-body.json`'s `unset-secret-is-still-listed` case).

Every `get*()` getter reads ONLY `values` and is UNCHANGED by this shape — they still return
secret values, same as before bd:envpit-durd (this is a labelling change, not an access-control
change). Only the native-env-merge path (`_environ_merge.merge_snapshot`, `populate_environ()`,
and the `flask`/`django` integrations) consults `secret_keys` to decide what to exclude.

`Logger` is a structural (duck-typed) protocol — pass a stdlib `logging.Logger`, or any object
exposing a subset of these methods; absent methods are simply never called (Sara §2.1: "silent by
default, observable by choice").
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal, Protocol, runtime_checkable


@dataclass(frozen=True)
class ConfigSnapshot:
    """The unwrapped resolve envelope (bd:envpit-durd). `secret_keys` defaults to an empty
    frozenset so test/internal call sites that only care about `values` (e.g. the
    `snapshot-diff.json` vector family, which is explicitly values-only and unaffected by this
    change) can construct one positionally: `ConfigSnapshot({"K": "v"})`."""

    values: dict[str, str | None]
    secret_keys: frozenset[str] = field(default_factory=frozenset)


@dataclass(frozen=True)
class MergeResult:
    """Result of `EnvpitClient.populate_environ()` / `integrations.flask.init_app()` /
    `integrations.django.load_into_settings()` — the shared `_environ_merge.merge_snapshot` core's
    return shape (`test-vectors/env-merge.json`). All three fields are SORTED tuples of key NAMES
    only — never values, log-safe by construction, same convention as `ChangeEvent.changed_keys`."""

    merged: tuple[str, ...]
    skipped_existing: tuple[str, ...]
    skipped_secrets: tuple[str, ...]

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
