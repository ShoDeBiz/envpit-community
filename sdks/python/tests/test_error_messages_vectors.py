"""Backfill (bd:envpit-0t2z.3, Slice-0 follow-up — 2 missing families flagged during this SDK's
own implementation dispatch): consumes `test-vectors/error-messages.json` — MESSAGE TEXT/SHAPE
per Uma's DX spec flag #6 (`outputs/SPEC-envpit-0t2z-3-1b-ux.md` §2.1/§2.2), a different concern
from `error-mapping.json` (error TYPE only, already consumed by `test_error_mapping_vectors.py`).
Every case drives the REAL `EnvpitClient`/`fetch_config` (not a re-implementation of message
text), matching this test suite's own existing vector-consumption convention.
"""

from __future__ import annotations

import urllib.error

import pytest

from envpit.client import EnvpitClient
from envpit.transport import fetch_config

from ._utils import FakeHttpResponse
from ._vectors import load_vectors

TEST_HOST = "https://example.test"

VECTORS = load_vectors("error-messages.json")["cases"]
NODE_ONLY_CASES = [c for c in VECTORS if not c.get("languages") or "python" in c["languages"]]
GETTER_KIND_TO_METHOD = {"string": "get", "int": "get_int", "boolean": "get_bool"}


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
            return FakeHttpResponse(b"not valid json {{", headers={})

        return _urlopen

    raise AssertionError(f"unhandled transportFailure: {failure}")


@pytest.mark.parametrize("case", NODE_ONLY_CASES, ids=[c["name"] for c in NODE_ONLY_CASES])
def test_error_message_vector(case: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    expected = case["messages"].get("python")
    if expected is None:
        pytest.skip(f'"{case["name"]}" has no python column (Go/Java-only case)')

    if case.get("apiKeyMissing"):
        monkeypatch.delenv("ENVPIT_API_KEY", raising=False)
        with pytest.raises(Exception) as exc_info:
            EnvpitClient.load(host=TEST_HOST, poll_interval=0)
        assert str(exc_info.value) == expected["message"]
        return

    if case.get("getter"):
        getter = case["getter"]
        method_name = GETTER_KIND_TO_METHOD[getter["kind"]]

        def fetch(*, host: str, api_key: str, timeout: float) -> tuple:
            return dict(getter["snapshot"]), None

        client = EnvpitClient.load(api_key="epk_test", host=TEST_HOST, poll_interval=0, _fetch_impl=fetch)
        try:
            method = getattr(client, method_name)
            with pytest.raises(Exception) as exc_info:
                method(getter["key"])
            assert str(exc_info.value) == expected["message"]
        finally:
            client.close()
        return

    if case.get("backgroundRefresh"):
        condition = case["backgroundRefresh"]["condition"]
        call_count = {"n": 0}
        logged: list[str] = []

        class _Logger:
            def warn(self, message: str) -> None:
                logged.append(message)

        def fetch(*, host: str, api_key: str, timeout: float) -> tuple:
            call_count["n"] += 1
            if call_count["n"] == 1:
                return {"K": "v0"}, None
            urlopen = _urlopen_for({"status": condition["status"]})
            # Drive the REAL transport-layer mapping so the composed message is genuine,
            # not hand-authored — matches error-messages.json's own documented composition
            # rule (background-refresh-failed's `{msg}` = the real underlying NetworkError text).
            snapshot, etag = fetch_config(host=TEST_HOST, api_key=api_key, timeout=timeout, urlopen=urlopen)
            return snapshot, etag

        client = EnvpitClient.load(
            api_key="epk_test", host=TEST_HOST, poll_interval=0, logger=_Logger(), _fetch_impl=fetch
        )
        try:
            client._refresh(is_first_load=False, trigger="poll")
            assert expected["message"] in logged
        finally:
            client.close()
        return

    if case.get("condition"):
        urlopen = _urlopen_for(case["condition"])
        with pytest.raises(Exception) as exc_info:
            fetch_config(host=TEST_HOST, api_key="epk_test", timeout=1.0, urlopen=urlopen)
        assert str(exc_info.value) == expected["message"]
        return

    raise AssertionError(f'error-messages.json case "{case["name"]}" has no recognized trigger shape')


def test_the_value_free_carve_out_is_exactly_type_mismatch_integer() -> None:
    raw_value = "abc"
    for case in NODE_ONLY_CASES:
        expected = case["messages"].get("python")
        if expected is None:
            continue
        if case["name"] == "type-mismatch-integer":
            assert case["valueFreeCarveOut"] is True
            assert f'"{raw_value}"' in expected["message"]
        else:
            assert case["valueFreeCarveOut"] is False
