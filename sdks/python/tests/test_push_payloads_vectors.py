"""Consumes `test-vectors/push-payloads.json` (11 cases) — drives the REAL `EnvpitClient`
end-to-end through the injected `_sse_opener` seam (a `FakeSseStream`), proving each vector's
`expectedBehavior` against the shipped push -> refetch decision in `realtime.py`/`client.py`.
`poll_interval` is set large enough that the poll timer never fires during the test window —
only the injected SSE push drives the refresh under test (mirrors Node's `pollIntervalMs:
60_000` + fake-timer-untouched approach)."""

from __future__ import annotations

import time

import pytest

from envpit.client import EnvpitClient

from ._utils import FakeSseStream, fetch_queue, wait_until
from ._vectors import load_vectors

VECTORS = load_vectors("push-payloads.json")["cases"]


class _RecordingLogger:
    def __init__(self) -> None:
        self.errors: list = []

    def error(self, message: str) -> None:
        self.errors.append(message)


@pytest.mark.parametrize("case", VECTORS, ids=[c["name"] for c in VECTORS])
def test_push_payload_vector(case: dict) -> None:
    stream = FakeSseStream()

    def opener(url: str, headers: dict, timeout: float) -> FakeSseStream:
        return stream

    if case["expectedBehavior"] == "refetch":
        fetch = fetch_queue(({"K": "v0"}, None), ({"K": "v1"}, case.get("expectedEtag")))
    else:
        fetch = fetch_queue(({"K": "v0"}, None))

    logger = _RecordingLogger()
    client = EnvpitClient.load(
        api_key="epk_test",
        poll_interval=3600,
        logger=logger,
        _fetch_impl=fetch,
        _sse_opener=opener,
    )
    try:
        assert wait_until(lambda: client.cache_info.refresh_mode == "realtime")

        changes: list = []
        errors: list = []
        client.on_change(lambda e: changes.append(e))
        client.on_error(lambda e: errors.append(e))

        stream.push(f"event: {case['event']}\ndata: {case['data']}\n\n")

        if case["expectedBehavior"] == "refetch":
            assert wait_until(lambda: len(changes) == 1)
            assert changes[0].etag == case.get("expectedEtag")
            assert client.get("K") == "v1"
        else:
            time.sleep(0.2)  # settle window — no refetch expected
            assert changes == []
            assert client.get("K") == "v0"

        assert errors == []  # no adversarial push payload ever produces an `error` event
        assert logger.errors == []  # ...nor is severe enough to log an error line
    finally:
        client.close()
