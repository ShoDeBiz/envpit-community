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
from collections.abc import Callable, Collection, MutableMapping
from datetime import datetime, timezone
from typing import Any

from ._environ_merge import merge_snapshot
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
    MergeResult,
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
        # bd:envpit-ubky — mirror the api_key resolution above: fall back to ENVPIT_HOST before
        # the cloud default, so a self-hoster setting ENVPIT_API_KEY + ENVPIT_HOST in the env
        # (and never passing host=) reaches their own server, not the cloud. Explicit host= wins.
        self._host = (host or os.environ.get("ENVPIT_HOST") or DEFAULT_HOST).rstrip("/")
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
        self._closed = False
        self._fork_hook_registered = False

    def __repr__(self) -> str:  # AC-SEC-SDK3-1: value-free/key-free default representation
        keys = len(self._snapshot.values) if self._snapshot is not None else 0
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
            self._start_background_threads()
            self._register_fork_hook()

    def _start_background_threads(self) -> None:
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

    def _register_fork_hook(self) -> None:
        # bd:envpit-p261: only the calling thread survives `os.fork()` (POSIX semantics) — a
        # client `load()`ed before a `gunicorn --preload` / uWSGI-prefork fork() ends up with
        # ZERO background threads in the child, with NO error signal whatsoever
        # (`cache_info.last_error` stays `None`, `refresh_mode` looks unchanged — a forked
        # worker's client is silently frozen at fork-time state forever). Self-healing fix
        # (Quinn's preferred option): `os.register_at_fork(after_in_child=...)` re-establishes
        # the poll+realtime threads in the child automatically, no user action required.
        # POSIX-only (`os.fork()`/`os.register_at_fork` don't exist on Windows) and only
        # registered once per instance — `os.register_at_fork` has no unregister API, so a
        # `self._closed` guard inside the handler is what makes a closed client's hook a
        # permanent no-op rather than resurrecting it on some unrelated later fork.
        if self._fork_hook_registered or not hasattr(os, "register_at_fork"):
            return
        self._fork_hook_registered = True
        os.register_at_fork(after_in_child=self._handle_fork_in_child)

    def _handle_fork_in_child(self) -> None:
        """Runs in the child immediately after `os.fork()`. Only the calling thread survives a
        fork, so every `Lock`/`Event` this instance owns may be inherited in whatever state it
        happened to be in at the instant of fork — a lock held by a thread that no longer
        exists in the child would deadlock forever if reused as-is (the classic fork+threads
        hazard; the same pattern CPython's own `logging` module works around). None of that
        state is worth trying to preserve/repair (whatever critical section was in flight died
        with its thread), so every lock is simply discarded for a fresh, unlocked one before
        anything touches this client again — see `_reset_locks_after_fork()`.

        The stale `Thread`/`RealtimeTransport` objects from the parent are NOT reused (dropped
        outright): CPython's own atfork machinery marks inherited `Thread` objects as stopped,
        so they're inert in the child regardless — brand-new ones are simply started."""
        if self._closed:
            return  # a closed client's threads must never be resurrected by an unrelated fork
        self._reset_locks_after_fork()
        self._poll_thread = None
        self._realtime = None
        self._saw_first_realtime_connect = False  # this process hasn't (re)connected yet
        self._log(
            "warn",
            "envpit: process forked — re-establishing background config refresh in the "
            "child process (see bd:envpit-p261)",
        )
        self._start_background_threads()
        # Self-heal promptly rather than waiting up to a full `poll_interval` for the restarted
        # poll thread's first tick: kick one immediate background refresh on its own thread so
        # the atfork handler itself never blocks on network I/O.
        threading.Thread(
            target=self._safe_background_refresh,
            args=("poll",),
            name="envpit-fork-recover",
            daemon=True,
        ).start()

    def _reset_locks_after_fork(self) -> None:
        self._state_lock = threading.Lock()
        self._poll_stop = threading.Event()
        self._change_emitter.reset_lock_after_fork()
        self._connection_emitter.reset_lock_after_fork()
        self._error_emitter.reset_lock_after_fork()

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
        last snapshot remains readable. Also permanently disarms this client's `os.fork()`
        self-heal hook (bd:envpit-p261) — `os.register_at_fork` has no unregister API, so
        `_closed` is what stops a closed client's threads from being resurrected by some
        unrelated later fork elsewhere in the process."""
        self._closed = True
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

    def get_optional(self, key: str) -> str | None:
        """Raw string read that never raises — returns `None` for an absent/unset key instead of
        `MissingKeyError`. The one typed getter every `integrations/*` module needs (a Pydantic
        Settings source, for instance, must report "no value" rather than raise per-field)."""
        return self._read_raw(key)

    # ---- native-mechanism merge (bd:envpit-yvyr) -------------------------------

    def snapshot(self) -> dict[str, str | None]:
        """A defensive (shallow) copy of the current in-memory config snapshot's VALUES (never
        includes `secret_keys` — use `known_secret_keys()` for that). Mutating the returned dict
        never affects this client's own state — same in-memory-only, never-network-call guarantee
        as every `get*()` call (INV-SDK-2/INV-SDK-3). Unchanged by bd:envpit-durd: secret-flagged
        values are still returned here exactly as before — this only labels which keys are
        secret, it does not change who can read a decrypted secret."""
        if self._snapshot is None:
            raise RuntimeError(
                "envpit: config not loaded yet — this should be unreachable via EnvpitClient.load()."
            )
        return dict(self._snapshot.values)

    def known_secret_keys(self) -> frozenset[str]:
        """Public accessor (bd:envpit-durd, AC-SEC-E11) for the current snapshot's secret key
        NAMES only — never values. Lets a caller write their own filter (e.g. before logging a
        snapshot, or before handing values to a third-party tool) without re-fetching or
        re-deriving the set `populate_environ()`/`integrations.flask.init_app()`/
        `integrations.django.load_into_settings()` already use internally."""
        return self._known_secret_keys()

    def _known_secret_keys(self) -> frozenset[str]:
        """Internal accessor for the current snapshot's secret key names — the exclude-set input
        for `populate_environ()`/`integrations/flask.py`/`integrations/django.py`. Backed by the
        real `secretKeys` field of the `{values, secretKeys}` resolve envelope (bd:envpit-durd,
        AC-SEC-E11), independently verified against `apps/api/src/config-management/
        config-resolve.controller.ts`'s documented response schema in the main `envpit` repo.

        Before bd:envpit-durd this always returned an empty `frozenset()` — the wire protocol had
        no per-key secret signal at all, so there was nothing to report (see git history for that
        prior state, and `bd:envpit-yvyr`'s original correction comment explaining the gap). That
        gap is now closed: the server labels secret keys by name in every resolve response, so
        this simply reads them off the loaded snapshot. No call site changed — `populate_environ`
        below, `integrations/flask.py`, and `integrations/django.py` already folded this method's
        result into their exclude set unconditionally; they now do the right thing automatically."""
        if self._snapshot is None:
            raise RuntimeError(
                "envpit: config not loaded yet — this should be unreachable via EnvpitClient.load()."
            )
        return self._snapshot.secret_keys

    def populate_environ(
        self,
        *,
        override: bool = False,
        include_secrets: bool = False,
        only: Collection[str] | None = None,
        exclude: Collection[str] | None = None,
        environ: MutableMapping[str, str] | None = None,
    ) -> MergeResult:
        """Merges the current snapshot into `os.environ` (or an injected `environ=` mapping —
        test-only seam, mirrors `_fetch_impl`/`urlopen`) so existing `os.environ.get("X")` call
        sites work unmodified — the "native mechanism" Oliver asked for (bd:envpit-yvyr).

        NEVER called automatically by `load()` — this is an explicit, opt-in action.

        Secrets are EXCLUDED BY DEFAULT (bd:envpit-durd, AC-SEC-E11 — the zero-argument call is
        the safe one): a key flagged `is_secret=true` server-side (`known_secret_keys()`) is
        skipped into the returned `MergeResult.skipped_secrets` unless `include_secrets=True` is
        passed explicitly. Naming `include_secrets=True` at the call site IS the acknowledgment
        that decrypted secret values will be written into `environ` — env vars are inherited by
        every child process, are frequently serialized whole by APM/crash-reporting tools, and are
        readable at `/proc/<pid>/environ` on Linux.

        `only=`/`exclude=` are Python-local additions (no Node/Java equivalent; mirrors Go's
        `WithOnly`/`WithExclude`) for a caller who wants to narrow the merge further by name:
        `only=` is an allowlist (every other key is skipped as if never fetched); `exclude=` is a
        denylist. Neither can pull a secret through the secret check — naming a secret key in
        `only=` still requires `include_secrets=True` to actually merge it (see
        `_environ_merge.py`'s module docstring for the full check order).

        A key already present in `environ` wins by default (no override) — same precedence
        `python-dotenv.load_dotenv()` uses; pass `override=True` to overwrite instead. A snapshot
        value of `None` (an unset EnvPit variable) is never written.

        BOOT-TIME SNAPSHOT ONLY: this is a one-shot copy, not a subscription. EnvPit's realtime
        refresh (SSE) updates THIS client's own in-memory snapshot (`get()` sees it immediately),
        but cannot reach a value already copied out into `environ` — `os.environ` has no
        equivalent of Spring's `@RefreshScope`. Call `populate_environ()` again after a
        `on_change()` callback if you need the target mapping to track live updates; anything
        that needs guaranteed-live values should read through the client (`get()`/`get_int()`/
        etc.) instead of `environ`.

        Returns a `MergeResult` — three SORTED, values-free key-name tuples (`merged`,
        `skipped_existing`, `skipped_secrets`) — log-safe by construction.
        """
        target: MutableMapping[str, str] = environ if environ is not None else os.environ
        return merge_snapshot(
            self.snapshot(),
            target,
            override=override,
            only=only,
            exclude=exclude,
            secret_keys=self._known_secret_keys(),
            include_secrets=include_secrets,
        )

    def _read_raw(self, key: str) -> str | None:
        # Structurally unreachable via the public API: `load()` never returns a client without
        # a successful first fetch (it raises instead). Kept as a defensive guard.
        if self._snapshot is None:
            raise RuntimeError(
                "envpit: config not loaded yet — this should be unreachable via EnvpitClient.load()."
            )
        value = self._snapshot.values.get(key)
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
            changed_keys = _diff_snapshots(previous_snapshot.values, snapshot.values)
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


def _diff_snapshots(
    previous: dict[str, str | None], next_snapshot: dict[str, str | None]
) -> list[str]:
    """Computes changed key NAMES between two in-memory snapshots' VALUES — never sent over the
    wire, and never includes values (log-safe by construction). Deliberately values-only and
    unaffected by bd:envpit-durd's `secretKeys` addition (out of scope per that bd's own
    decision): a `secretKeys`-only change (no `values` difference) is NOT a config change. A key
    absent from a snapshot and a key present-with-`None` are treated identically ("unset"),
    matching `_read_raw()`'s own missing-vs-null equivalence."""
    keys = set(previous.keys()) | set(next_snapshot.keys())
    changed = [key for key in keys if previous.get(key) != next_snapshot.get(key)]
    return sorted(changed)
