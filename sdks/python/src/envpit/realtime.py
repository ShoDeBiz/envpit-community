"""Manages exactly one logical realtime (SSE) connection to `GET {host}/api/v1/config/events`,
with transparent reconnection — Python port of the shipped Node SDK's `RealtimeTransport`
(`sdks/node/src/realtime-transport.ts`). One quiet, immediate retry for any disconnect, then a
degraded/backoff loop with the diagnostics cadence `SPEC-envpit-a9d-1b-ux.md` §3.3 specifies:
one `info` on entering degraded mode, one `warn` after 5 minutes still degraded, one `info` on
restore — never a line per failed attempt (INV-SDK-10).

Threading model (Sara §2.1): ONE daemon thread runs the connect/pump/reconnect loop for this
transport's entire lifetime — the Python equivalent of Node's `timer.unref()` (INV-SDK-11: a
loaded, still-connecting client must never keep the host process alive).

`opener` is an injectable seam (test-only; not part of the documented public `EnvpitClient`
surface) returning any object exposing `.read(n) -> bytes` (`b""` == EOF) and `.close()` — the
Python analogue of Node's `fetchImpl` injection point for the realtime channel.

Platform note (deliberate, not an oversight): Node's design distinguishes a `'network'` failure
from a structural `'unsupported'` one (`fetch` returning a non-streamable response body in some
runtime) and permanently stops retrying in the latter case. Python's `urllib` response objects
are always streamable file-like objects in every environment this SDK targets — there is no
analogous "this runtime can't stream" failure mode, so `'unsupported'`/`permanently_unsupported`
is not reachable here and is intentionally omitted (see the Python `RealtimeTransport`'s own
report §7 for the explicit call-out).
"""

from __future__ import annotations

import codecs
import json
import random
import threading
import time
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from .sse_parser import SseFrame, SseFrameParser, SseLineTooLongError
from .types import ConnectionMode, ConnectionReason

CONFIG_EVENTS_PATH = "/api/v1/config/events"
CONFIG_CHANGED_EVENT_NAME = "config-changed"
RECONNECT_EVENT_NAME = "reconnect"

QUICK_RECONNECT_DELAY_S = 1.0
DEGRADED_RECONNECT_INTERVAL_S = 10.0
DEGRADED_RECONNECT_JITTER_S = 2.0
DEGRADED_WARN_THRESHOLD_S = 5 * 60.0

_READ_CHUNK_BYTES = 4096
#: Read timeout per socket op; generous vs. the server's ~25s heartbeat cadence so heartbeats
#: alone keep a healthy connection from ever hitting this.
_STREAM_TIMEOUT_S = 90.0


def default_sse_opener(url: str, headers: dict[str, str], timeout: float) -> Any:
    request = urllib.request.Request(url, headers=headers, method="GET")
    return urllib.request.urlopen(request, timeout=timeout)


@dataclass
class RealtimeCallbacks:
    #: A `config-changed` push arrived; the caller (EnvpitClient) decides whether a refetch is
    #: actually needed (e.g. skip if it already holds this etag).
    on_change_signal: Callable[[str], None]
    #: `mode` just transitioned (never fired per-attempt — only on an actual state change).
    on_mode_change: Callable[[ConnectionMode, ConnectionReason, datetime], None]
    on_log: Callable[[str, str], None]  # (level, message)


class RealtimeTransport:
    def __init__(
        self,
        *,
        host: str,
        api_key: str,
        poll_interval_s: float,
        callbacks: RealtimeCallbacks,
        opener: Callable[[str, dict[str, str], float], Any] = default_sse_opener,
        quick_reconnect_delay_s: float = QUICK_RECONNECT_DELAY_S,
        degraded_reconnect_interval_s: float = DEGRADED_RECONNECT_INTERVAL_S,
        degraded_reconnect_jitter_s: float = DEGRADED_RECONNECT_JITTER_S,
        warn_threshold_s: float = DEGRADED_WARN_THRESHOLD_S,
    ) -> None:
        self._host = host
        self._api_key = api_key
        self._poll_interval_s = poll_interval_s
        self._callbacks = callbacks
        self._opener = opener
        self._quick_reconnect_delay_s = quick_reconnect_delay_s
        self._degraded_reconnect_interval_s = degraded_reconnect_interval_s
        self._degraded_reconnect_jitter_s = degraded_reconnect_jitter_s
        self._warn_threshold_s = warn_threshold_s

        self._stopped = True
        self._thread: threading.Thread | None = None
        self._current_response: Any = None
        self._response_lock = threading.Lock()
        self._wake = threading.Event()
        self._next_retry_delay = 0.0

        self._expecting_server_reconnect = False
        self._degraded_since_monotonic: float | None = None
        self._warned_this_episode = False
        self._quick_retry_used_for_episode = False
        self._mode: ConnectionMode = "polling"

    def __repr__(self) -> str:  # AC-SEC-SDK3-1: value-free/key-free default representation
        return f"RealtimeTransport(host={self._host!r}, api_key=<redacted>)"

    __str__ = __repr__

    def start(self) -> None:
        """Starts the connection loop on a new daemon thread. Idempotent while already
        running."""
        if not self._stopped:
            return
        self._stopped = False
        self._quick_retry_used_for_episode = False
        self._thread = threading.Thread(target=self._run, name="envpit-realtime", daemon=True)
        self._thread.start()

    def close(self) -> None:
        """Tears down the current connection (if any) and stops the reconnect loop. Idempotent."""
        if self._stopped:
            return
        self._stopped = True
        self._wake.set()
        with self._response_lock:
            response = self._current_response
        if response is not None:
            try:
                response.close()
            except Exception:  # noqa: BLE001
                pass
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=5.0)

    # ---- connection loop --------------------------------------------------

    def _run(self) -> None:
        while not self._stopped:
            self._connect_once()
            if self._stopped:
                return
            delay = self._next_retry_delay
            self._wake.wait(delay)
            self._wake.clear()

    def _connect_once(self) -> None:
        url = f"{self._host}{CONFIG_EVENTS_PATH}"
        headers = {"X-Api-Key": self._api_key, "Accept": "text/event-stream"}
        try:
            response = self._opener(url, headers, _STREAM_TIMEOUT_S)
        except Exception:  # noqa: BLE001 - any connect failure -> the same reconnect path
            if self._stopped:
                return
            self._on_failure()
            return

        if self._stopped:
            self._safe_close(response)
            return

        status = getattr(response, "status", 200)
        if not (200 <= status < 300):
            self._safe_close(response)
            self._on_failure()
            return

        with self._response_lock:
            self._current_response = response
        self._on_success()

        try:
            self._pump(response)
        except SseLineTooLongError:
            pass  # oversized line — treated as a disconnect below, same as any other failure
        except Exception:  # noqa: BLE001 - a read/decode error mid-stream is just a disconnect
            pass
        finally:
            with self._response_lock:
                self._current_response = None
            self._safe_close(response)

        if self._stopped:
            return
        self._on_failure()

    def _pump(self, response: Any) -> None:
        parser = SseFrameParser()
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        while not self._stopped:
            chunk = response.read(_READ_CHUNK_BYTES)
            if not chunk:
                return  # clean EOF -> treated as a disconnect by the caller
            text = decoder.decode(chunk)
            for frame in parser.push(text):
                self._handle_frame(frame)
                if self._stopped:
                    return

    def _handle_frame(self, frame: SseFrame) -> None:
        if frame.event == CONFIG_CHANGED_EVENT_NAME:
            etag = _parse_etag(frame.data)
            if etag:
                self._callbacks.on_change_signal(etag)
            return
        if frame.event == RECONNECT_EVENT_NAME:
            # The server is about to close this stream deliberately (rotation/shutdown/
            # revocation sweep) — remember that, so the next successful connect logs the
            # quieter "reconnected (server rotation)" line instead of a generic "connected" one.
            self._expecting_server_reconnect = True
            return
        # Unknown event name (e.g. a future `flags-changed` frame) — ignored by design.

    @staticmethod
    def _safe_close(response: Any) -> None:
        try:
            response.close()
        except Exception:  # noqa: BLE001
            pass

    # ---- state transitions --------------------------------------------------

    def _on_success(self) -> None:
        self._quick_retry_used_for_episode = False
        was_server_reconnect = self._expecting_server_reconnect
        self._expecting_server_reconnect = False
        was_degraded = self._degraded_since_monotonic is not None
        self._degraded_since_monotonic = None
        self._warned_this_episode = False

        mode_changed = self._mode != "realtime"
        since = datetime.now(timezone.utc)
        if mode_changed:
            self._mode = "realtime"

        if was_degraded:
            self._callbacks.on_log("info", "envpit: realtime channel restored")
        elif was_server_reconnect:
            self._callbacks.on_log(
                "debug", "envpit: realtime channel reconnected (server rotation)"
            )
        else:
            self._callbacks.on_log("debug", "envpit: realtime config channel connected")

        if mode_changed:
            self._callbacks.on_mode_change("realtime", "connected", since)

    def _on_failure(self) -> None:
        if self._stopped:
            return
        # One silent, immediate retry per episode before announcing anything.
        if not self._quick_retry_used_for_episode and self._degraded_since_monotonic is None:
            self._quick_retry_used_for_episode = True
            self._next_retry_delay = self._quick_reconnect_delay_s
            return
        self._declare_degraded("network")
        self._schedule_degraded_retry()

    def _declare_degraded(self, reason: ConnectionReason) -> None:
        if self._degraded_since_monotonic is not None:
            self._maybe_warn()
            return  # already announced this episode — stay quiet
        since = datetime.now(timezone.utc)
        self._degraded_since_monotonic = time.monotonic()
        poll_sec = max(1, round(self._poll_interval_s))
        message = (
            f"envpit: realtime channel unavailable — falling back to polling every "
            f"{poll_sec}s; config still refreshes, max staleness {poll_sec}s"
        )
        self._callbacks.on_log("info", message)

        mode_changed = self._mode != "polling"
        self._mode = "polling"
        if mode_changed:
            self._callbacks.on_mode_change("polling", reason, since)

    def _maybe_warn(self) -> None:
        if self._warned_this_episode or self._degraded_since_monotonic is None:
            return
        elapsed = time.monotonic() - self._degraded_since_monotonic
        if elapsed >= self._warn_threshold_s:
            self._warned_this_episode = True
            minutes = max(1, round(self._warn_threshold_s / 60.0))
            poll_sec = max(1, round(self._poll_interval_s))
            self._callbacks.on_log(
                "warn",
                f"envpit: realtime channel still unavailable after {minutes} min; "
                f"continuing to poll every {poll_sec}s",
            )

    def _schedule_degraded_retry(self) -> None:
        jitter = random.uniform(0, self._degraded_reconnect_jitter_s)
        self._next_retry_delay = self._degraded_reconnect_interval_s + jitter


def _parse_etag(data: str) -> str | None:
    try:
        parsed = json.loads(data)
    except (json.JSONDecodeError, RecursionError):
        return None
    if not isinstance(parsed, dict):
        return None
    etag = parsed.get("etag")
    return etag if isinstance(etag, str) and len(etag) > 0 else None
