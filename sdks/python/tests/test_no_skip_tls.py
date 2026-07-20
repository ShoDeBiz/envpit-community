"""AC-SEC-SDK3-3 (`THREATMODEL-envpit-0t2z-3.md` F3): v1's public API contains no option that
disables TLS certificate verification, and runtime source contains no known
disable-verification incantation. Grep gate (source scan) + a signature-introspection check on
the two public entry points (`EnvpitClient.load()` / module-level `envpit.load()`)."""

from __future__ import annotations

import inspect
import re
from pathlib import Path

from envpit.client import EnvpitClient

SRC_ROOT = Path(__file__).resolve().parents[1] / "src" / "envpit"

FORBIDDEN_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("ssl._create_unverified_context", re.compile(r"_create_unverified_context")),
    ("ssl.CERT_NONE", re.compile(r"CERT_NONE")),
    ("check_hostname disabled", re.compile(r"check_hostname\s*=\s*False")),
    ("verify=False-style flag", re.compile(r"verify\s*=\s*False")),
    ("an 'insecure' option name", re.compile(r"insecure", re.IGNORECASE)),
    ("a 'skip verify'-style option name", re.compile(r"skip.?verify", re.IGNORECASE)),
]

FORBIDDEN_PARAMETER_NAMES = {
    "verify",
    "insecure",
    "ssl_context",
    "disable_tls",
    "skip_verify",
    "no_verify",
}


def test_ac_sec_sdk3_3_no_tls_bypass_pattern_anywhere_in_runtime_source() -> None:
    offenders = []
    for path in sorted(SRC_ROOT.rglob("*.py")):
        text = path.read_text(encoding="utf-8")
        for label, pattern in FORBIDDEN_PATTERNS:
            if pattern.search(text):
                offenders.append((str(path.relative_to(SRC_ROOT)), label))
    assert offenders == [], f"TLS-bypass-capable pattern(s) found in runtime source: {offenders}"


def test_ac_sec_sdk3_3_public_load_signatures_have_no_tls_bypass_parameter() -> None:
    import envpit

    for target in (EnvpitClient.load, envpit.load):
        sig = inspect.signature(target)
        overlap = FORBIDDEN_PARAMETER_NAMES.intersection(sig.parameters.keys())
        assert overlap == set(), f"{target} exposes a TLS-bypass-shaped parameter: {overlap}"
