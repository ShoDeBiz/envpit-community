"""Consumes `test-vectors/resolve-body.json` (16 cases, bd:envpit-durd, AC-SEC-E11) — drives the
REAL `envpit.transport.fetch_config` (not a re-implementation of the envelope-validation logic)
through a fake `urlopen` that returns each vector's raw `body` JSON-encoded, exactly the way
`test_error_mapping_vectors.py` drives the same function for HTTP/transport-level failures.

The wire shape changed from a bare `{key: value}` map to the envelope `{values, secretKeys}`; a
pre-durd bare map (and every other malformed shape) maps onto the SAME `NetworkError` class
`error-mapping.json`'s `invalid-json-body` case uses — there is no dedicated "legacy server"
error type (see the vector file's own `notes.breakingChange`)."""

from __future__ import annotations

import json

import pytest

from envpit.errors import NetworkError
from envpit.transport import fetch_config

from ._utils import FakeHttpResponse
from ._vectors import load_vectors

TEST_HOST = "https://example.test"

VECTORS = load_vectors("resolve-body.json")["cases"]


def _urlopen_for(body: object):
    encoded = json.dumps(body).encode("utf-8")

    def _urlopen(request: object, timeout: float) -> FakeHttpResponse:
        return FakeHttpResponse(encoded, headers={})

    return _urlopen


@pytest.mark.parametrize("case", VECTORS, ids=[c["name"] for c in VECTORS])
def test_resolve_body_vector(case: dict) -> None:
    urlopen = _urlopen_for(case["body"])

    if "expectedError" in case:
        assert case["expectedError"] == "NetworkError"  # the only class this vector file uses
        with pytest.raises(NetworkError):
            fetch_config(host=TEST_HOST, api_key="epk_test", timeout=1.0, urlopen=urlopen)
        return

    snapshot, _etag = fetch_config(host=TEST_HOST, api_key="epk_test", timeout=1.0, urlopen=urlopen)
    expected = case["expected"]
    assert snapshot.values == expected["values"]
    assert snapshot.secret_keys == frozenset(expected["secretKeys"])
