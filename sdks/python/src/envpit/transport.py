"""The one real HTTP call this SDK makes (Phase 1 scope — no bootstrap/handshake endpoint).
`GET {host}/api/v1/config` — the key-scope-inferred alias: auth via `X-Api-Key`,
project+environment are inferred server-side from the key itself, so the SDK never needs to
know its own project/environment id. Zero runtime dependencies — `urllib.request` only
(ADR-S3-02 / Sara §2.1: "Python stdlib urllib.request streams... sync-first keeps zero-dep
achievable").

`urlopen` is an injectable seam (test-only; not part of the documented public surface) so the
test suite can exercise this module's real status-code -> error-type mapping logic against a
fake transport, mirroring how the shipped Node SDK's tests drive the real `fetchConfig()`
through a fake `fetchImpl` rather than re-implementing the mapping in test code.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any

from .errors import AuthenticationError, NetworkError
from .types import ConfigSnapshot

CONFIG_PATH = "/api/v1/config"

#: AC-SEC-SDK3-2(a) (THREATMODEL-envpit-0t2z-3.md F2): the config-response body is read
#: incrementally and capped — an adversarial/misbehaving server sending an unbounded body must
#: not be buffered into memory without limit.
DEFAULT_BODY_BYTE_CAP = 5 * 1024 * 1024  # 5 MiB

_READ_CHUNK_BYTES = 65536


def fetch_config(
    *,
    host: str,
    api_key: str,
    timeout: float,
    body_byte_cap: int = DEFAULT_BODY_BYTE_CAP,
    urlopen: Any = urllib.request.urlopen,
) -> tuple[ConfigSnapshot, str | None]:
    url = f"{host}{CONFIG_PATH}"
    request = urllib.request.Request(url, headers={"X-Api-Key": api_key}, method="GET")

    try:
        with urlopen(request, timeout=timeout) as response:
            body = _read_capped(response, body_byte_cap, url)
            etag = response.headers.get("etag")
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            raise AuthenticationError(
                f"API key rejected (HTTP {exc.code}). It may be revoked, expired, or "
                "mistyped. Check Project → API Keys in EnvPit."
            ) from exc
        raise NetworkError(
            f"EnvPit returned HTTP {exc.code} while fetching config from {url}."
        ) from exc
    except TimeoutError as exc:
        raise NetworkError(
            f"Could not reach EnvPit at {url} (timed out). Check your network/proxy and "
            "https://status.envpit.com."
        ) from exc
    except urllib.error.URLError as exc:
        raise NetworkError(
            f"Could not reach EnvPit at {url} ({_describe_failure(exc)}). Check your "
            "network/proxy and https://status.envpit.com."
        ) from exc

    snapshot = _parse_json_body(body, url)
    return snapshot, etag


def _read_capped(response: Any, cap: int, url: str) -> bytes:
    chunks = []
    total = 0
    while True:
        chunk = response.read(_READ_CHUNK_BYTES)
        if not chunk:
            break
        total += len(chunk)
        if total > cap:
            raise NetworkError(
                f"EnvPit response from {url} exceeded the maximum allowed size ({cap} bytes)."
            )
        chunks.append(chunk)
    return b"".join(chunks)


def _parse_json_body(body: bytes, url: str) -> ConfigSnapshot:
    try:
        text = body.decode("utf-8")
        parsed = json.loads(text)
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as exc:
        # RecursionError: Python's C-accelerated json module raises this cleanly (verified) for
        # adversarial depth-bomb payloads rather than crashing — AC-SEC-SDK3-2(c).
        raise NetworkError(f"EnvPit returned an invalid JSON response from {url}.") from exc
    if not isinstance(parsed, dict):
        raise NetworkError(f"EnvPit returned an invalid JSON response from {url}.")
    return parsed


def _describe_failure(exc: urllib.error.URLError) -> str:
    reason = exc.reason
    if isinstance(reason, TimeoutError) or "timed out" in str(reason).lower():
        return "timed out"
    return str(reason)
