"""AC-SEC-SDK3-2 (`THREATMODEL-envpit-0t2z-3.md` F2): adversarial size/depth caps on the parsed
HTTP response and the realtime SSE line reader — a malicious/compromised server or a
TLS-bypassed MITM must not be able to exhaust client memory.

SUPERSEDED (bd:envpit-0t2z.3 Slice-0 backfill): this file used to be the dedicated Python-side
stopgap for the body-byte-cap / SSE-line-cap / JSON-depth-bomb concerns ("No shared vector
family exists yet for these caps specifically" — that was true when this file was written; it
no longer is). That coverage now lives in the shared, language-agnostic
`test-vectors/adversarial-payloads.json`, consumed by `tests/test_adversarial_payloads_vectors.py`
(and by `sdks/node/test/vectors/adversarial-payloads.vectors.test.ts` for Node) — see that file's
module docstring for the full rationale. The four/five tests that used to live here were removed
as pure duplicates, not silently dropped (git history has them; the shared file's `notes` field
credits this file as their origin).

KEPT below: exactly one test that genuinely is NOT a cross-language-parity concern. Python's
`_parse_json_body` validates the top-level JSON value is actually an object (`isinstance(parsed,
dict)`) before returning it as a `ConfigSnapshot` — Node's `transport.ts` does NOT perform this
check (verified empirically while building the shared adversarial-payloads family: a bare JSON
array/number/string/null is silently accepted as a 'successful load', degrading every getter to
`MissingKeyError` rather than failing the load with a clear error). This is a real, discovered
Node/Python behavioral inconsistency — reported separately (not force-fit into the shared vector
file, since it isn't a crash/hang/OOM concern, Sentinel's AC-SEC-SDK3-2 scope) and flagged as its
own follow-up. Until/unless Node adopts the same validation, this specific case can't be a shared
vector (it would assert a Node behavior Node doesn't have) — it stays here as Python-only
coverage of Python's own, currently-correct, defensive validation.
"""

from __future__ import annotations

import pytest

from envpit.errors import NetworkError
from envpit.transport import fetch_config

from ._utils import FakeHttpResponse


def test_ac_sec_sdk3_2c_non_object_json_top_level_is_rejected() -> None:
    def urlopen(request: object, timeout: float) -> FakeHttpResponse:
        return FakeHttpResponse(b"[1,2,3]", headers={})

    with pytest.raises(NetworkError, match="invalid JSON response"):
        fetch_config(host="https://example.test", api_key="epk_test", timeout=1.0, urlopen=urlopen)
