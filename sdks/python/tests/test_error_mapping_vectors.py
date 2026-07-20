"""Consumes `test-vectors/error-mapping.json` (9 cases) — drives the REAL
`envpit.transport.fetch_config` (not a re-implementation of the mapping) through a fake
`urlopen`, exactly the way Node's equivalent vector test drives the real `fetchConfig()`
through a fake `fetchImpl`. R3 (SPEC-envpit-0t2z-3-1a-architecture.md §9): the shipped 4-type
taxonomy — 404/429/5xx all collapse into `NetworkError`, NOT a special type (ADR-S3-08)."""

from __future__ import annotations

import urllib.error

import pytest

from envpit.errors import AuthenticationError, NetworkError
from envpit.transport import fetch_config

from ._utils import FakeHttpResponse
from ._vectors import load_vectors

VECTORS = load_vectors("error-mapping.json")["cases"]

ERROR_CLASSES = {"AuthenticationError": AuthenticationError, "NetworkError": NetworkError}


def _urlopen_for(condition: dict):
    if "status" in condition:
        status = condition["status"]

        def _urlopen(request, timeout):  # noqa: ANN001, ANN202
            raise urllib.error.HTTPError(request.full_url, status, "error", {}, None)

        return _urlopen

    failure = condition["transportFailure"]
    if failure == "timeout":

        def _urlopen(request, timeout):  # noqa: ANN001, ANN202
            raise TimeoutError("timed out")

        return _urlopen
    if failure == "connection-refused":

        def _urlopen(request, timeout):  # noqa: ANN001, ANN202
            raise urllib.error.URLError(ConnectionRefusedError("connection refused"))

        return _urlopen
    if failure == "invalid-json-body":

        def _urlopen(request, timeout):  # noqa: ANN001, ANN202
            return FakeHttpResponse(b"{not valid json!!", headers={})

        return _urlopen

    raise AssertionError(f"unhandled transportFailure: {failure}")


@pytest.mark.parametrize("case", VECTORS, ids=[c["name"] for c in VECTORS])
def test_error_mapping_vector(case: dict) -> None:
    urlopen = _urlopen_for(case["condition"])
    expected_cls = ERROR_CLASSES[case["expectedError"]]
    with pytest.raises(expected_cls):
        fetch_config(host="https://example.test", api_key="epk_test", timeout=1.0, urlopen=urlopen)
