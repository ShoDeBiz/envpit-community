"""Shared test-only fakes/helpers — the Python analogue of `sdks/node/test/test-utils.ts`."""

from __future__ import annotations

import queue
import time
from collections.abc import Callable, Collection
from typing import Any

from envpit.client import EnvpitClient
from envpit.types import ConfigSnapshot

#: Anything a caller can hand to `fake_fetch_impl`/`fetch_queue`/`make_loaded_client` in place of
#: a real `ConfigSnapshot` — a bare `dict[str, str | None]` (the overwhelming majority of this
#: suite's tests, which only care about VALUES and are unaffected by bd:envpit-durd's
#: `secretKeys` addition) is auto-wrapped into a `ConfigSnapshot` with an empty `secret_keys` by
#: `_as_snapshot` below, so this convenience is zero-cost for every pre-existing call site.
SnapshotLike = ConfigSnapshot | dict[str, "str | None"]


def _as_snapshot(snapshot: SnapshotLike, secret_keys: Collection[str] = ()) -> ConfigSnapshot:
    if isinstance(snapshot, ConfigSnapshot):
        if secret_keys:
            raise AssertionError(
                "pass secret_keys via the ConfigSnapshot itself, not alongside an already-built one"
            )
        return snapshot
    return ConfigSnapshot(values=dict(snapshot), secret_keys=frozenset(secret_keys))


def fake_fetch_impl(
    snapshot: SnapshotLike, etag: str | None = None, secret_keys: Collection[str] = ()
) -> Callable[..., Any]:
    built = _as_snapshot(snapshot, secret_keys)

    def _fetch(*, host: str, api_key: str, timeout: float) -> tuple[ConfigSnapshot, str | None]:
        return ConfigSnapshot(values=dict(built.values), secret_keys=built.secret_keys), etag

    return _fetch


def fetch_queue(*results: tuple[SnapshotLike, str | None]) -> Callable[..., Any]:
    """Each call pops the next `(snapshot, etag)` pair. Raises loudly once exhausted — an
    unexpected extra fetch call fails the test instead of silently repeating stale data
    (mirrors Node test-utils' `routedFetch` "no response configured" philosophy)."""
    remaining: list[tuple[SnapshotLike, str | None]] = list(results)

    def _fetch(*, host: str, api_key: str, timeout: float) -> tuple[ConfigSnapshot, str | None]:
        if not remaining:
            raise AssertionError("fetch queue exhausted — unexpected extra fetch call")
        snapshot, etag = remaining.pop(0)
        built = _as_snapshot(snapshot)
        return ConfigSnapshot(values=dict(built.values), secret_keys=built.secret_keys), etag

    return _fetch


def make_loaded_client(
    snapshot: SnapshotLike, secret_keys: Collection[str] = (), **kwargs: Any
) -> EnvpitClient:
    kwargs.setdefault("poll_interval", 0)
    kwargs.setdefault("api_key", "epk_test")
    fetch_impl = kwargs.pop("_fetch_impl", None) or fake_fetch_impl(snapshot, secret_keys=secret_keys)
    return EnvpitClient.load(_fetch_impl=fetch_impl, **kwargs)


def wait_until(predicate: Callable[[], bool], timeout: float = 2.0, interval: float = 0.02) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


class FakeSseStream:
    """A controllable fake SSE response object: `.read(n)` blocks (briefly, polling) until data
    is pushed or the stream is closed, then returns `b""` (EOF) — the Python analogue of Node's
    test-utils `sseResponse()` (a `ReadableStream` + `push()` helper)."""

    status = 200

    def __init__(self) -> None:
        self._queue: queue.Queue[bytes] = queue.Queue()
        self._closed = False

    def push(self, text: str) -> None:
        self._queue.put(text.encode("utf-8"))

    def read(self, n: int = -1) -> bytes:
        while True:
            try:
                return self._queue.get(timeout=0.05)
            except queue.Empty:
                if self._closed:
                    return b""

    def close(self) -> None:
        self._closed = True

    def __enter__(self) -> FakeSseStream:
        return self

    def __exit__(self, *exc: Any) -> bool:
        self.close()
        return False


class FakeHttpResponse:
    """A minimal fake standing in for `http.client.HTTPResponse` — supports the context-manager
    + `.read(n)` + `.headers.get()` surface `transport.fetch_config` actually uses."""

    def __init__(self, body: bytes, headers: dict[str, str] | None = None) -> None:
        self._body = body
        self.headers = headers or {}

    def read(self, n: int = -1) -> bytes:
        if n is None or n < 0:
            chunk, self._body = self._body, b""
            return chunk
        chunk, self._body = self._body[:n], self._body[n:]
        return chunk

    def __enter__(self) -> FakeHttpResponse:
        return self

    def __exit__(self, *exc: Any) -> bool:
        return False
