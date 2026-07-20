"""INV-SDK-3 / AC-SEC-SDK3-4 (`THREATMODEL-envpit-0t2z-3.md` F4, `CONFORMANCE.md`'s
GAP-documented negative property): "no code path anywhere writes a file" isn't provable with a
positive test, so this is a grep/lint-style gate over the RUNTIME source tree (never over
`tests/`, which is test-only code and never bundled/imported by the shipped package) — the
mechanism `CONFORMANCE.md` itself names as the closing move for this invariant.
"""

from __future__ import annotations

import re
from pathlib import Path

SRC_ROOT = Path(__file__).resolve().parents[1] / "src" / "envpit"

# Each pattern targets a concrete disk-write capability the Python-specific trap list
# (Sentinel F4 / CONFORMANCE.md INV-SDK-3) names explicitly.
FORBIDDEN_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("open(...) in a write/append/exclusive-create mode", re.compile(r"""\bopen\([^)]*["'][wxa]""")),
    ("tempfile module", re.compile(r"\btempfile\b")),
    ("pickle module", re.compile(r"\bpickle\b")),
    ("shelve module", re.compile(r"\bshelve\b")),
    ("Path.write_text/write_bytes", re.compile(r"\.write_(text|bytes)\(")),
    ("os.write / os.open write flags", re.compile(r"\bos\.write\(")),
]


def test_inv_sdk_3_and_ac_sec_sdk3_4_no_runtime_source_file_writes_to_disk() -> None:
    offenders = []
    for path in sorted(SRC_ROOT.rglob("*.py")):
        text = path.read_text(encoding="utf-8")
        for label, pattern in FORBIDDEN_PATTERNS:
            if pattern.search(text):
                offenders.append((str(path.relative_to(SRC_ROOT)), label))
    assert offenders == [], f"disk-write-capable pattern(s) found in runtime source: {offenders}"


def test_inv_sdk_3_http_client_has_no_response_disk_cache_enabled() -> None:
    """`urllib.request` (this SDK's only HTTP client, ADR-S3-02) has no response-disk-cache
    concept to opt into at all — unlike e.g. `requests-cache` or a browser-style HTTP cache.
    Positive, source-grepped confirmation that no such library was ever added, and that
    `urllib.request` (the stdlib module actually used) is the sole HTTP import across the
    whole runtime tree."""
    disk_cache_libraries = ("requests_cache", "cachecontrol", "diskcache")
    http_stack_used: set = set()
    for path in sorted(SRC_ROOT.rglob("*.py")):
        content = path.read_text(encoding="utf-8")
        for lib in disk_cache_libraries:
            assert lib not in content, f"{lib} referenced in {path.name} — a disk-cache-capable HTTP stack"
        if "urllib.request" in content:
            http_stack_used.add("urllib.request")
        if "import requests" in content or "import httpx" in content or "import aiohttp" in content:
            http_stack_used.add("third-party")
    assert http_stack_used == {"urllib.request"}
