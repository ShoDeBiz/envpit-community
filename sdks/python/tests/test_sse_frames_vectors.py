"""Consumes `test-vectors/sse-frames.json` — `SseFrameParser` input chunking -> output frames
(8 cases, incl. worst-case char-by-char chunking). Ground truth: `src/envpit/sse_parser.py`."""

from __future__ import annotations

import pytest

from envpit.sse_parser import SseFrame, SseFrameParser

from ._vectors import load_vectors

VECTORS = load_vectors("sse-frames.json")["cases"]


@pytest.mark.parametrize("case", VECTORS, ids=[c["name"] for c in VECTORS])
def test_sse_frame_vector(case: dict) -> None:
    parser = SseFrameParser()
    frames = []

    if case["chunkMode"] == "char":
        for code_point in case["input"]:  # Python str iteration is already per-code-point
            frames.extend(parser.push(code_point))
    else:
        frames.extend(parser.push(case["input"]))

    expected = [SseFrame(event=f["event"], data=f["data"]) for f in case["expectedFrames"]]
    assert frames == expected
