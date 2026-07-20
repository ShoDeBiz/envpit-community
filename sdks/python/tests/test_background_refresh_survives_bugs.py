"""AC-PY-02 (adapted — see report): Bella's original wording ("no swallowed background-task
exception") was framed around `asyncio.create_task`, but Sara §4 chose daemon THREADS, not
asyncio tasks, for Python's background refresh — so the asyncio-specific mitigation
(`task.add_done_callback`) doesn't apply verbatim. This is the thread-model-correct equivalent:
an unexpected bug in the apply/diff/emit path (NOT a fetch failure, which `_refresh()` already
handles via INV-SDK-4) must never silently kill the poll thread forever — the Python-thread
analogue of Java's AC-JV-01 (`ScheduledExecutorService.scheduleAtFixedRate` silently cancels
all future executions on an uncaught throw)."""

from __future__ import annotations

import pytest

import envpit.client as client_module
from envpit.client import EnvpitClient

from ._utils import wait_until


def test_ac_py_02_poll_thread_survives_an_unexpected_bug_and_keeps_retrying(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logged: list = []

    class _Logger:
        def error(self, message: str) -> None:
            logged.append(message)

    call_count = {"n": 0}

    def fetch(*, host: str, api_key: str, timeout: float) -> tuple:
        call_count["n"] += 1
        return {"K": str(call_count["n"])}, None

    client = EnvpitClient.load(
        api_key="epk_test", poll_interval=0.05, logger=_Logger(), _fetch_impl=fetch
    )
    try:
        original_diff = client_module._diff_snapshots
        state = {"raised": False}

        def buggy_diff(previous: dict, next_snapshot: dict) -> list:
            if not state["raised"]:
                state["raised"] = True
                raise RuntimeError("simulated bug in the diff/emit path")
            return original_diff(previous, next_snapshot)

        monkeypatch.setattr(client_module, "_diff_snapshots", buggy_diff)  # type: ignore[attr-defined]

        assert wait_until(lambda: call_count["n"] >= 3, timeout=2.0)
        assert any(
            "background config refresh crashed unexpectedly (trigger: poll)" in line
            for line in logged
        )
    finally:
        client.close()
