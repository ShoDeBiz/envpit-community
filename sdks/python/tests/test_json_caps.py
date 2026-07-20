"""AC-SEC-SDK3-2 (`THREATMODEL-envpit-0t2z-3.md` F2): adversarial size/depth caps on the parsed
HTTP response and the realtime SSE line reader — a malicious/compromised server or a
TLS-bypassed MITM must not be able to exhaust client memory. No shared vector family exists yet
for these caps specifically (Slice 0 landed the 6 established families; this AC's own
"adversarial vectors added to the suite" is dedicated Python-side coverage, same as it will be
for Go/Java — flagged honestly in the hand-off report, not silently claimed as vector-covered).
"""

from __future__ import annotations

import pytest

from envpit.errors import NetworkError
from envpit.sse_parser import SseFrameParser, SseLineTooLongError
from envpit.transport import DEFAULT_BODY_BYTE_CAP, fetch_config

from ._utils import FakeHttpResponse


class _UnboundedResponse:
    """Simulates a server streaming an effectively unbounded body — read() never signals EOF
    until the cap should have already tripped the parser/reader."""

    def __init__(self, total_bytes: int) -> None:
        self._remaining = total_bytes
        self.headers: dict = {}

    def read(self, n: int = 65536) -> bytes:
        if self._remaining <= 0:
            return b""
        chunk_size = min(n, self._remaining)
        self._remaining -= chunk_size
        return b"a" * chunk_size

    def __enter__(self) -> _UnboundedResponse:
        return self

    def __exit__(self, *exc: object) -> bool:
        return False


def test_ac_sec_sdk3_2a_oversized_response_body_is_rejected_not_buffered_unbounded() -> None:
    oversized = _UnboundedResponse(DEFAULT_BODY_BYTE_CAP + (1024 * 1024))  # cap + 1 MiB

    def urlopen(request: object, timeout: float) -> _UnboundedResponse:
        return oversized

    with pytest.raises(NetworkError, match="exceeded the maximum allowed size"):
        fetch_config(host="https://example.test", api_key="epk_test", timeout=1.0, urlopen=urlopen)

    # The reader must have stopped shortly after crossing the cap, not consumed the entire
    # (much larger) adversarial body — proves it isn't buffering unbounded before checking.
    assert oversized._remaining > 0


def test_ac_sec_sdk3_2a_body_exactly_at_the_cap_is_accepted() -> None:
    import json

    payload = json.dumps({"K": "v" * (DEFAULT_BODY_BYTE_CAP - 20)}).encode("utf-8")
    assert len(payload) <= DEFAULT_BODY_BYTE_CAP

    def urlopen(request: object, timeout: float) -> FakeHttpResponse:
        return FakeHttpResponse(payload, headers={})

    snapshot, _etag = fetch_config(
        host="https://example.test", api_key="epk_test", timeout=1.0, urlopen=urlopen
    )
    assert "K" in snapshot


def test_ac_sec_sdk3_2b_oversized_sse_line_is_rejected_not_buffered_unbounded() -> None:
    parser = SseFrameParser(max_line_bytes=64)
    huge_unterminated_line = "event: config-changed\ndata: " + ("x" * 200)  # no trailing \n
    with pytest.raises(SseLineTooLongError):
        parser.push(huge_unterminated_line)


def test_ac_sec_sdk3_2b_sse_line_under_the_cap_parses_normally() -> None:
    parser = SseFrameParser(max_line_bytes=1024)
    frames = parser.push("event: config-changed\ndata: {}\n\n")
    assert len(frames) == 1
    assert frames[0].event == "config-changed"


def test_ac_sec_sdk3_2c_python_json_depth_bomb_is_mapped_to_network_error_not_a_crash() -> None:
    depth = 200_000
    depth_bomb = ("[" * depth) + ("]" * depth)

    def urlopen(request: object, timeout: float) -> FakeHttpResponse:
        return FakeHttpResponse(depth_bomb.encode("utf-8"), headers={})

    with pytest.raises(NetworkError, match="invalid JSON response"):
        fetch_config(host="https://example.test", api_key="epk_test", timeout=1.0, urlopen=urlopen)


def test_ac_sec_sdk3_2c_non_object_json_top_level_is_rejected() -> None:
    def urlopen(request: object, timeout: float) -> FakeHttpResponse:
        return FakeHttpResponse(b"[1,2,3]", headers={})

    with pytest.raises(NetworkError, match="invalid JSON response"):
        fetch_config(host="https://example.test", api_key="epk_test", timeout=1.0, urlopen=urlopen)
