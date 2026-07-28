"""Regression coverage for `bd:envpit-p261` — `os.fork()` called AFTER `envpit.load()`/
`EnvpitClient.load()` (the standard `gunicorn --preload` / uWSGI-prefork pattern: config client
created once at import time, workers forked from it) used to leave the forked child with ZERO
background threads and, critically, NO error signal whatsoever: `cache_info.last_error` stayed
`None`, `refresh_mode` looked unchanged, `get()` silently never reflected another server-side
change for the rest of the worker's life. Fix: `os.register_at_fork(after_in_child=...)`
self-heals by re-establishing the poll+realtime threads in the child automatically.

These tests use a REAL `os.fork()` (not a mock/simulation) — the only way to actually exercise
POSIX fork semantics (only the calling thread survives) — and communicate the child's result
back to the parent over a pipe, since assertions raised inside the forked child would not
otherwise fail the parent's pytest run. Skipped on platforms without `os.fork()`/
`os.register_at_fork` (Windows)."""

from __future__ import annotations

import os
import select
import threading
import time

import pytest

from envpit.client import EnvpitClient
from envpit.types import ConfigSnapshot

from ._utils import wait_until

pytestmark = pytest.mark.skipif(
    not hasattr(os, "register_at_fork"), reason="os.fork()/register_at_fork is POSIX-only"
)


def _run_in_fork(child_fn, timeout: float = 10.0) -> bytes:
    """Forks, runs `child_fn()` in the child, and returns whatever bytes the child wrote to the
    pipe. `child_fn` must itself write a result to the given `write_fd` and must not return
    normally (always exits via `os._exit()` so the child never falls back into pytest's own
    exit machinery, which would run cleanup code twice — once in each process)."""
    read_fd, write_fd = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(read_fd)
        try:
            child_fn(write_fd)
        except BaseException as exc:  # noqa: BLE001 - must never let an exception escape the child
            try:
                os.write(write_fd, f"FAIL:child-raised:{exc!r}".encode())
            except OSError:
                pass
        finally:
            os.close(write_fd)
            os._exit(0)
        return b""  # unreachable

    os.close(write_fd)
    result = b""
    deadline = time.monotonic() + timeout
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                result += b"FAIL:parent-timed-out-waiting-for-child"
                break
            ready, _, _ = select.select([read_fd], [], [], remaining)
            if not ready:
                continue
            chunk = os.read(read_fd, 65536)
            if not chunk:
                break
            result += chunk
    finally:
        os.close(read_fd)
        # Reap the child unconditionally, even on a parent-side timeout, so a broken test never
        # leaves a zombie/orphaned process behind.
        for _ in range(50):
            try:
                waited_pid, _ = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                break
            if waited_pid == pid:
                break
            time.sleep(0.1)
        else:
            try:
                os.kill(pid, 9)
                os.waitpid(pid, 0)
            except (ChildProcessError, ProcessLookupError):
                pass
    return result


def test_bd_envpit_p261_fork_after_load_self_heals_background_refresh_in_the_child() -> None:
    """The exact repro from the bug report: `load()` before `fork()`, then a server-side change
    the child must eventually observe WITHOUT any user action — proving the child is not
    silently frozen at fork-time state forever."""
    call_count = {"n": 0}

    def fetch(*, host: str, api_key: str, timeout: float):
        call_count["n"] += 1
        return ConfigSnapshot({"PORT": str(9090 + call_count["n"])}), None

    client = EnvpitClient.load(api_key="epk_test", poll_interval=0.05, _fetch_impl=fetch)
    try:
        # Let the parent's background machinery run for real at least once before forking, so
        # this is a faithful "fork a warmed-up, already-connected client" repro, not just a
        # freshly-bootstrapped one.
        # Captured before forking: the parent's real OS-thread identities. `os.register_at_fork`
        # child hooks run SYNCHRONOUSLY as part of `os.fork()` itself (before `os.fork()` even
        # returns to the calling Python code) — by design, our self-heal hook has ALREADY
        # replaced `client._poll_thread`/`client._realtime._thread` with brand-new ones by the
        # time this test's `pid == 0` branch runs at all. So "no envpit-poll thread exists
        # immediately after fork" is not an externally observable/valid assertion given this
        # fix's synchronous-restart design — the POSIX fact ("only the calling thread survives
        # fork") is instead proven the way that's actually observable: the child's poll/realtime
        # threads are provably DIFFERENT OS threads (different `.ident`) from the parent's,
        # not the literal same ones somehow still running.
        parent_poll_ident = client._poll_thread.ident
        parent_realtime_ident = client._realtime._thread.ident
        assert wait_until(lambda: call_count["n"] >= 2)

        def in_child(write_fd: int) -> None:
            # The fix under test: the atfork hook must re-establish the poll thread without any
            # action from this test.
            if not wait_until(
                lambda: client._poll_thread is not None and client._poll_thread.is_alive(),
                timeout=3.0,
            ):
                os.write(write_fd, b"FAIL:poll-thread-never-re-established-after-fork")
                return
            if client._poll_thread.ident == parent_poll_ident:
                os.write(write_fd, b"FAIL:child-poll-thread-is-literally-the-parents-old-thread")
                return
            if (
                client._realtime is None
                or client._realtime._thread is None
                or client._realtime._thread.ident == parent_realtime_ident
            ):
                os.write(write_fd, b"FAIL:realtime-thread-not-freshly-re-established")
                return

            # And background refresh must actually resume and observe further changes — not
            # just "a thread exists" but genuinely functioning again.
            before = client.get("PORT")
            if not wait_until(lambda: client.get("PORT") != before, timeout=3.0):
                os.write(
                    write_fd,
                    b"FAIL:background-refresh-never-resumed-in-child:stuck-at:"
                    + before.encode(),
                )
                return

            # The non-negotiable minimum bar even if something above were still imperfect:
            # never silent. Confirm cache_info stays a truthful, healthy signal throughout.
            if client.cache_info.last_error is not None:
                os.write(
                    write_fd,
                    b"FAIL:unexpected-last_error:" + repr(client.cache_info.last_error).encode(),
                )
                return

            os.write(write_fd, b"OK")

        result = _run_in_fork(in_child)
        assert result == b"OK", result.decode(errors="replace")

        # Sanity: the parent process itself is completely unaffected by the child's fork/close.
        assert client._poll_thread is not None and client._poll_thread.is_alive()
    finally:
        client.close()


def test_bd_envpit_p261_closed_client_never_resurrects_its_threads_on_an_unrelated_fork() -> None:
    """`os.register_at_fork` has no unregister API — a client that was `close()`d before some
    LATER, unrelated fork() elsewhere in the process must have its hook be a permanent no-op,
    not resurrect background threads for a client the caller already tore down."""
    fetch_calls = {"n": 0}

    def fetch(*, host: str, api_key: str, timeout: float):
        fetch_calls["n"] += 1
        return ConfigSnapshot({"K": "v"}), None

    client = EnvpitClient.load(api_key="epk_test", poll_interval=0.05, _fetch_impl=fetch)
    client.close()
    assert wait_until(lambda: not client._poll_thread.is_alive())
    calls_at_close = fetch_calls["n"]

    def in_child(write_fd: int) -> None:
        names = {t.name for t in threading.enumerate()}
        if "envpit-poll" in names:
            os.write(write_fd, b"FAIL:closed-clients-poll-thread-was-resurrected")
            return
        os.write(write_fd, b"OK")

    result = _run_in_fork(in_child)
    assert result == b"OK", result.decode(errors="replace")
    # No new fetch call happened as a side effect of the fork either (the closed client's
    # `_fork_hook_registered`/`_closed` guard made the atfork handler a true no-op).
    assert fetch_calls["n"] == calls_at_close


def test_bd_envpit_p261_poll_interval_zero_client_never_registers_a_fork_hook() -> None:
    """A client with `poll_interval=0` never had background threads to begin with (INV-SDK-8) —
    it must not register an atfork hook at all (nothing to self-heal, and no need to accumulate
    a process-wide callback for a client with no background state)."""

    def fetch(*, host: str, api_key: str, timeout: float):
        return ConfigSnapshot({"K": "v"}), None

    client = EnvpitClient.load(api_key="epk_test", poll_interval=0, _fetch_impl=fetch)
    try:
        assert client._fork_hook_registered is False
    finally:
        client.close()
