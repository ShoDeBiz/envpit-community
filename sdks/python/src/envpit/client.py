"""`client = envpit.load(...)` — the Python core client (Sara §2.1: sync-first, daemon threads,
zero runtime dependencies). One bulk fetch per environment (`GET /api/v1/config`, key-scope-
inferred from the API key); every `get*()` call after `load()` resolves is a synchronous,
in-memory read — never a network call (INV-SDK-2).

Caching: memory-only, never persisted to disk (INV-SDK-3). Background refresh uses stale-
while-revalidate — a failed refresh keeps serving the last good snapshot and records the
failure on `cache_info`, it never raises to a `get*()` caller (INV-SDK-4). Only the FIRST load
raises (there is nothing to fall back to yet) — `EnvpitClient.load()`/`envpit.load()` surfaces
this directly, so a caller can never hold a half-initialized client (INV-SDK-1). Enforced
structurally here, not just by convention: `EnvpitClient(...)` cannot be constructed directly
(raises `RuntimeError`) — only `EnvpitClient.load()` can produce an instance.

Realtime: whenever `poll_interval > 0`, the client ALSO opens a realtime (SSE) connection
alongside the poll timer. A `config-changed` push triggers an immediate refetch; the poll timer
remains the correctness backstop regardless (INV-SDK-8). `on_change()`/`on_connection()`/
`on_error()` are the push-style surfaces (typed registration methods, Sara §2.1 — not a
generic `on(event, cb)`); `cache_info` is the pull-style equivalent.

Generation guard (INV-SDK-5, bd:envpit-1mvf, Sara §4 "Python — direct port"): every refresh
claims a monotonically increasing generation number, under `self._state_lock`, BEFORE its
request is issued. Its outcome — success OR failure — is applied only if that generation is
still the newest issued when the outcome arrives; the check-and-apply is one critical section
under the same lock (NOT relying on the GIL for check-then-apply atomicity, per Sara's explicit
instruction — two statements, and free-threaded CPython builds exist from 3.13 onward).
"""

from __future__ import annotations

import os
import re
import threading
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

from .emitter import SafeEmitter
from .errors import AuthenticationError, EnvpitError, MissingKeyError, TypeMismatchError
from .realtime import RealtimeCallbacks, RealtimeTransport
from .transport import fetch_config
from .types import (
    CacheInfo,
    ChangeEvent,
    ChangeTrigger,
    ConfigSnapshot,
    ConnectionEvent,
    ConnectionMode,
    ConnectionReason,
    Logger,
    RefreshMode,
)

DEFAULT_HOST = "https://envpit.com"
DEFAULT_POLL_INTERVAL_S = 60.0
DEFAULT_TIMEOUT_S = 5.0

TRUE_VALUES = {"true", "1", "yes", "on"}
FALSE_VALUES = {"false", "0", "no", "off"}
INTEGER_PATTERN = re.compile(r"^-?\d+$")

#: Guards `EnvpitClient.__init__` against direct construction — only `EnvpitClient.load()`
#: (which passes this exact sentinel) can produce an instance. AC-SDK-05a: "no reachable state
#: where a caller holds a client object that hasn't completed its first fetch."
_LOAD_SENTINEL = object()

#: Type of the injectable `_fetch_impl` seam (test-only; matches `transport.fetch_config`'s
#: keyword signature so the real function is a drop-in default).
FetchImpl = Callable[..., Any]


class EnvpitClient:
    def __init__(
        self,
        *,
        api_key: str | None = None,
        host: str | None = None,
        poll_interval: float = DEFAULT_POLL_INTERVAL_S,
        timeout: float = DEFAULT_TIMEOUT_S,
        logger: Logger | None = None,
        _fetch_impl: FetchImpl | None = None,
        _sse_opener: Callable[..., Any] | None = None,
        _sentinel: object = None,
    ) -> None:
        if _sentinel is not _LOAD_SENTINEL:
            raise RuntimeError(
                "envpit: EnvpitClient() must not be constructed directly — use envpit.load() "
                "(or EnvpitClient.load()), the SDK's only entry point."
            )

        resolved_key = api_key if api_key is not None else os.environ.get("ENVPIT_API_KEY")
        if not resolved_key:
            raise AuthenticationError(
                "EnvPit: no API key found. Set the ENVPIT_API_KEY environment variable, or "
                "pass api_key=... to envpit.load()."
            )

        self._api_key = resolved_key
        self._host = (host or DEFAULT_HOST).rstrip("/")
        self._poll_interval_s = poll_interval
        self._timeout_s = timeout
        self._logger = logger
        self._fetch_impl: FetchImpl = _fetch_impl or fetch_config
        self._sse_opener = _sse_opener

        self._snapshot: ConfigSnapshot | None = None
        self._fetched_at: datetime | None = None
        self._last_error: BaseException | None = None
        self._etag: str | None = None
        self._last_change_at: datetime | None = None
        self._refresh_mode: RefreshMode = "polling" if poll_interval > 0 else "off"
        self._realtime_since: datetime | None = None
        self._saw_first_realtime_connect = False

        self._state_lock = threading.Lock()
        self._generation = 0

        self._change_emitter: SafeEmitter[ChangeEvent] = SafeEmitter("change", logger)
        self._connection_emitter: SafeEmitter[ConnectionEvent] = SafeEmitter("connection", logger)
        self._error_emitter: SafeEmitter[EnvpitError] = SafeEmitter("error", logger)

        self._poll_thread: threading.Thread | None = None
        self._poll_stop = threading.Event()
        self._realtime: RealtimeTransport | None = None

    def __repr__(self) -> str:  # AC-SEC-SDK3-1: value-free/key-free default representation
        keys = len(self._snapshot) if self._snapshot is not None else 0
        return f"EnvpitClient(host={self._host!r}, keys={keys}, api_key=<redacted>)"

    __str__ = __repr__

    # ---- entry point --------------------------------------------------------

    @classmethod
    def load(
        cls,
        *,
        api_key: str | None = None,
        host: str | None = None,
        poll_interval: float = DEFAULT_POLL_INTERVAL_S,
        timeout: float = DEFAULT_TIMEOUT_S,
        logger: Logger | None = None,
        _fetch_impl: FetchImpl | None = None,
        _sse_opener: Callable[..., Any] | None = None,
    ) -> EnvpitClient:
        """The SDK's only entry point. Constructs the client, fetches the environment's config
        once (raises on failure — no cache exists yet to fall back to), and — unless
        `poll_interval` is `0` — starts the background poll thread AND the realtime (SSE)
        connection thread. Returns a ready-to-read client; every `get*()` call on the result is
        synchronous. `load()` resolving is NOT itself a `change` event (no boot double-fire)."""
        client = cls(
            api_key=api_key,
            host=host,
            poll_interval=poll_interval,
            timeout=timeout,
            logger=logger,
            _fetch_impl=_fetch_impl,
            _sse_opener=_sse_opener,
            _sentinel=_LOAD_SENTINEL,
        )
        client._bootstrap()
        return client

    def _bootstrap(self) -> None:
        self._refresh(is_first_load=True)
        if self._poll_interval_s > 0:
            self._poll_thread = threading.Thread(
                target=self._poll_loop, name="envpit-poll", daemon=True
            )
            self._poll_thread.start()

            realtime_kwargs: dict[str, Any] = {}
            if self._sse_opener is not None:
                realtime_kwargs["opener"] = self._sse_opener
            self._realtime = RealtimeTransport(
                host=self._host,
                api_key=self._api_key,
                poll_interval_s=self._poll_interval_s,
                callbacks=RealtimeCallbacks(
                    on_change_signal=self._handle_push_signal,
                    on_mode_change=self._handle_connection_mode_change,
                    on_log=self._log,
                ),
                **realtime_kwargs,
            )
            self._realtime.start()

    def _poll_loop(self) -> None:
        while not self._poll_stop.wait(self._poll_interval_s):
            self._safe_background_refresh("poll")

    def _log(self, level: str, message: str) -> None:
        if self._logger is None:
            return
        method = getattr(self._logger, level, None)
        if not callable(method):
            return
        try:
            method(message)
        except Exception:  # noqa: BLE001 - a panicking injected logger must not crash the SDK
            pass

    # ---- lifecycle ------------------------------------------------------------

    def close(self) -> None:
        """Stops the background poll thread AND the realtime (SSE) connection. Idempotent. The
        last snapshot remains readable."""
        self._poll_stop.set()
        if self._poll_thread is not None and self._poll_thread is not threading.current_thread():
            self._poll_thread.join(timeout=5.0)
        if self._realtime is not None:
            self._realtime.close()
            self._realtime = None

    def __enter__(self) -> EnvpitClient:
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        self.close()

    # ---- listeners ----------------------------------------------------------

    def on_change(self, listener: Callable[[ChangeEvent], None]) -> Callable[[], None]:
        """Subscribes `listener` to `change`. Returns an idempotent unsubscribe callable. A
        raising listener is caught and reported through the injected `logger`; it never
        crashes the host process and never stops other listeners from running (INV-SDK-6). An
        `async def` listener is rejected immediately with a `TypeError` — see `emitter.py`."""
        return self._change_emitter.on(listener)

    def on_connection(self, listener: Callable[[ConnectionEvent], None]) -> Callable[[], None]:
        return self._connection_emitter.on(listener)

    def on_error(self, listener: Callable[[EnvpitError], None]) -> Callable[[], None]:
        return self._error_emitter.on(listener)

    # ---- cache info -----------------------------------------------------------

    @property
    def cache_info(self) -> CacheInfo:
        fetched_at = self._fetched_at
        age_ms = (
            (datetime.now(timezone.utc) - fetched_at).total_seconds() * 1000
            if fetched_at is not None
            else None
        )
        return CacheInfo(
            fetched_at=fetched_at,
            age_ms=age_ms,
            last_error=self._last_error,
            etag=self._etag,
            refresh_mode=self._refresh_mode,
            realtime_since=(self._realtime_since if self._refresh_mode == "realtime" else None),
            last_change_at=self._last_change_at,
        )

    # ---- getters ------------------------------------------------------------

    def get(self, key: str, default: str | None = None) -> str:
        """Raw string read. Raises `MissingKeyError` if the key is absent/`None` and no
        `default` is given."""
        raw = self._read_raw(key)
        if raw is not None:
            return raw
        if default is not None:
            return default
        raise MissingKeyError(key)

    def get_string(self, key: str, default: str | None = None) -> str:
        """Alias of `get()` — explicit typed-getter naming to match the other two getters."""
        return self.get(key, default)

    def get_int(self, key: str, default: int | None = None) -> int:
        """Parses the value as a base-10 integer. Raises `TypeMismatchError` if it isn't one."""
        raw = self._read_raw(key)
        if raw is None:
            if default is not None:
                return default
            raise MissingKeyError(key)
        trimmed = raw.strip()
        if not INTEGER_PATTERN.match(trimmed):
            raise TypeMismatchError(key, "integer", raw)
        return int(trimmed, 10)

    def get_bool(self, key: str, default: bool | None = None) -> bool:
        """Parses the value as a boolean. Accepts (case-insensitive) true/false, 1/0, yes/no,
        on/off. Raises `TypeMismatchError` for anything else."""
        raw = self._read_raw(key)
        if raw is None:
            if default is not None:
                return default
            raise MissingKeyError(key)
        normalized = raw.strip().lower()
        if normalized in TRUE_VALUES:
            return True
        if normalized in FALSE_VALUES:
            return False
        raise TypeMismatchError(key, "boolean", raw)

    def _read_raw(self, key: str) -> str | None:
        # Structurally unreachable via the public API: `load()` never returns a client without
        # a successful first fetch (it raises instead). Kept as a defensive guard.
        if self._snapshot is None:
            raise RuntimeError(
                "envpit: config not loaded yet — this should be unreachable via EnvpitClient.load()."
            )
        value = self._snapshot.get(key)
        return value if value is not None else None

    # ---- internal refresh machinery (INV-SDK-4/5) -----------------------------

    def _handle_push_signal(self, pushed_etag: str) -> None:
        # The event's own etag lets us skip a wasted refetch when this is a duplicate
        # notification we already reflect (e.g. a repeat after reconnect).
        if self._etag is not None and pushed_etag == self._etag:
            return
        self._safe_background_refresh("push")

    def _handle_connection_mode_change(
        self, mode: ConnectionMode, reason: ConnectionReason, since: datetime
    ) -> None:
        self._refresh_mode = mode
        self._realtime_since = since if mode == "realtime" else None
        self._connection_emitter.emit(ConnectionEvent(mode=mode, since=since, reason=reason))

        # Self-healing catch-up: refetch whenever the channel (re)connects, in case a change
        # was missed while it was down. Skipped on the very first realtime connect right after
        # `load()` — that data is already fresh, and firing it there would just be a wasted
        # duplicate of the bootstrap fetch.
        if mode == "realtime":
            if self._saw_first_realtime_connect:
                self._safe_background_refresh("reconnect")
            self._saw_first_realtime_connect = True

    def _safe_background_refresh(self, trigger: ChangeTrigger) -> None:
        # A background trigger (poll tick / push signal / reconnect catch-up) runs on the poll
        # thread or the realtime thread — an unexpected bug here (not a fetch failure, which
        # `_refresh()` already handles; a genuine SDK bug in the apply/diff/emit path) must
        # never silently kill that thread forever, mirroring Java's AC-JV-01
        # (`ScheduledExecutorService.scheduleAtFixedRate` silently cancels all future
        # executions on an uncaught throw) adapted to Python's thread-based design — Sara §4
        # chose daemon threads, not `asyncio.create_task`, for Python's background refresh, so
        # Bella's asyncio-specific AC-PY-02 mitigation (`task.add_done_callback`) doesn't apply
        # verbatim; this is the thread-model-correct equivalent of the same requirement ("no
        # swallowed background-task exception").
        try:
            self._refresh(is_first_load=False, trigger=trigger)
        except Exception as exc:  # noqa: BLE001
            self._log(
                "error",
                f"envpit: background config refresh crashed unexpectedly (trigger: {trigger}): "
                f"{exc} — will retry on the next trigger",
            )

    def _refresh(self, *, is_first_load: bool, trigger: ChangeTrigger | None = None) -> None:
        with self._state_lock:
            self._generation += 1
            my_generation = self._generation

        try:
            snapshot, etag = self._fetch_impl(
                host=self._host, api_key=self._api_key, timeout=self._timeout_s
            )
        except Exception as error:  # noqa: BLE001
            with self._state_lock:
                # In-flight guard (INV-SDK-5, failure path): a stale/superseded refresh's
                # failure must not clobber `cache_info.last_error` (or fire a spurious `error`
                # event) once a newer refresh has already landed.
                if my_generation != self._generation:
                    return
                self._last_error = error
                must_raise = is_first_load or self._snapshot is None
            if must_raise:
                raise error
            self._log(
                "warn",
                f"envpit: background config refresh failed ({type(error).__name__}): "
                f"{error} — serving last known values",
            )
            if isinstance(error, EnvpitError):
                self._error_emitter.emit(error)
            return

        with self._state_lock:
            # In-flight guard (INV-SDK-5, success path): a newer refresh() may have been issued
            # while this one's fetch was in flight — discard a superseded response outright.
            if my_generation != self._generation:
                return
            previous_snapshot = self._snapshot
            self._snapshot = snapshot
            self._fetched_at = datetime.now(timezone.utc)
            self._last_error = None
            self._etag = etag

        # Consistent-read guarantee: the snapshot above is already applied BEFORE we emit — a
        # listener calling `client.get(...)` inside its handler sees the new values, never a
        # torn state. No `change` on the very first load, and none when nothing actually
        # differs.
        if not is_first_load and previous_snapshot is not None:
            changed_keys = _diff_snapshots(previous_snapshot, snapshot)
            if changed_keys:
                received_at = datetime.now(timezone.utc)
                self._last_change_at = received_at
                self._change_emitter.emit(
                    ChangeEvent(
                        changed_keys=changed_keys,
                        etag=etag,
                        received_at=received_at,
                        trigger=trigger or "poll",
                    )
                )


def _diff_snapshots(previous: ConfigSnapshot, next_snapshot: ConfigSnapshot) -> list[str]:
    """Computes changed key NAMES between two in-memory snapshots — never sent over the wire,
    and never includes values (log-safe by construction). A key absent from a snapshot and a
    key present-with-`None` are treated identically ("unset"), matching `_read_raw()`'s own
    missing-vs-null equivalence."""
    keys = set(previous.keys()) | set(next_snapshot.keys())
    changed = [key for key in keys if previous.get(key) != next_snapshot.get(key)]
    return sorted(changed)
