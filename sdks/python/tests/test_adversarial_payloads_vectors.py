"""Backfill (bd:envpit-0t2z.3, Slice-0 follow-up — 2 missing families flagged during this SDK's
own implementation dispatch): consumes `test-vectors/adversarial-payloads.json` — malformed/
oversized/deeply-nested JSON+SSE vectors per Sentinel's AC-SEC-SDK3-2
(`outputs/THREATMODEL-envpit-0t2z-3.md` F2). This supersedes `tests/test_json_caps.py`'s bespoke
coverage of the SAME concern — that file predates this shared vector family (it was the
documented stopgap per its own module docstring: "No shared vector family exists yet for these
caps specifically"). Python already implements both caps for real (`DEFAULT_BODY_BYTE_CAP`,
`SseFrameParser`'s `max_line_bytes`), so every case here is a genuine, currently-passing positive
assertion — no gap, unlike Node's consumption of the same file.
"""

from __future__ import annotations

import json

import pytest

from envpit.errors import NetworkError
from envpit.sse_parser import SseFrameParser, SseLineTooLongError
from envpit.transport import DEFAULT_BODY_BYTE_CAP, fetch_config

from ._utils import FakeHttpResponse
from ._vectors import load_vectors

TEST_HOST = "https://example.test"

VECTORS = load_vectors("adversarial-payloads.json")["cases"]


def _case(name: str) -> dict:
    for c in VECTORS:
        if c["name"] == name:
            return c
    raise AssertionError(f'adversarial-payloads.json: no case named "{name}"')


def _build_padded_json_body(target_bytes: int) -> bytes:
    """`payloadRecipe: "json-object-single-key-K-padded-string"` — same construction the
    vector file documents (and this module's own bespoke predecessor already used)."""
    skeleton_len = len(json.dumps({"K": ""}).encode("utf-8"))
    pad_length = target_bytes - skeleton_len
    return json.dumps({"K": "v" * pad_length}).encode("utf-8")


def _build_unterminated_sse_line(target_bytes: int) -> str:
    """`lineRecipe: "sse-config-changed-data-padded-no-terminator"`."""
    prefix = "event: config-changed\ndata: "
    pad_length = target_bytes - len(prefix.encode("utf-8"))
    return prefix + ("x" * pad_length)


class _UnboundedResponse:
    """Simulates a server streaming an effectively unbounded body — `read()` never signals EOF
    until the cap should have already tripped the parser/reader (same shape as this module's
    bespoke predecessor)."""

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


class TestBodySizeCap:
    def test_oversized_response_body_is_rejected_not_buffered_unbounded(self) -> None:
        case = _case("oversized-response-body-exceeds-cap")
        oversized = _UnboundedResponse(case["payloadBytes"])

        def urlopen(request: object, timeout: float) -> _UnboundedResponse:
            return oversized

        with pytest.raises(NetworkError, match=case["expectedMessageSubstring"]):
            fetch_config(host=TEST_HOST, api_key="epk_test", timeout=1.0, urlopen=urlopen)

        # The reader must have stopped shortly after crossing the cap, not consumed the entire
        # (much larger) adversarial body — proves it isn't buffering unbounded before checking.
        assert oversized._remaining > 0

    def test_response_body_at_cap_boundary_is_accepted(self) -> None:
        case = _case("response-body-at-cap-boundary-is-accepted")
        assert case["payloadBytes"] <= DEFAULT_BODY_BYTE_CAP
        payload = _build_padded_json_body(case["payloadBytes"])

        def urlopen(request: object, timeout: float) -> FakeHttpResponse:
            return FakeHttpResponse(payload, headers={})

        snapshot, _etag = fetch_config(host=TEST_HOST, api_key="epk_test", timeout=1.0, urlopen=urlopen)
        assert "K" in snapshot


class TestSseLineSizeCap:
    def test_oversized_sse_line_is_rejected_not_buffered_unbounded(self) -> None:
        case = _case("oversized-sse-line-without-terminator-is-capped")
        parser = SseFrameParser(max_line_bytes=case["recommendedCapBytes"])
        huge_unterminated_line = _build_unterminated_sse_line(case["lineBytes"])
        with pytest.raises(SseLineTooLongError):
            parser.push(huge_unterminated_line)

    def test_sse_line_under_the_cap_parses_normally(self) -> None:
        case = _case("sse-line-under-the-cap-parses-normally")
        parser = SseFrameParser(max_line_bytes=case["recommendedCapBytes"])
        frames = parser.push(f"event: {case['event']}\ndata: {case['data']}\n\n")
        assert len(frames) == 1
        assert frames[0].event == case["expectedFrame"]["event"]
        assert frames[0].data == case["expectedFrame"]["data"]


class TestJsonDepthBomb:
    def test_deeply_nested_array_is_memory_safe_python_maps_recursion_error_to_network_error(self) -> None:
        case = _case("json-depth-bomb-nested-arrays-is-memory-safe")
        depth = case["depth"]
        depth_bomb = ("[" * depth) + ("]" * depth)

        def urlopen(request: object, timeout: float) -> FakeHttpResponse:
            return FakeHttpResponse(depth_bomb.encode("utf-8"), headers={})

        # Not a hard requirement to reject (file description: "no-crash-no-hang-no-oom" is
        # satisfied either way) — Python's C-accelerated `json` module raises `RecursionError`
        # around this depth, caught and mapped to `NetworkError` (verified, real behavior).
        with pytest.raises(NetworkError, match="invalid JSON response"):
            fetch_config(host=TEST_HOST, api_key="epk_test", timeout=1.0, urlopen=urlopen)


class TestMalformedJson:
    @pytest.mark.parametrize(
        "name",
        [
            "unterminated-string-value-is-rejected-safely",
            "invalid-unicode-escape-is-rejected-safely",
            "trailing-garbage-after-valid-json-is-rejected",
        ],
    )
    def test_malformed_json_vector(self, name: str) -> None:
        case = _case(name)

        def urlopen(request: object, timeout: float) -> FakeHttpResponse:
            return FakeHttpResponse(case["input"].encode("utf-8"), headers={})

        with pytest.raises(NetworkError):
            fetch_config(host=TEST_HOST, api_key="epk_test", timeout=1.0, urlopen=urlopen)
