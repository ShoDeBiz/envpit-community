"""Consumes `test-vectors/env-merge.json` (16 cases, bd:envpit-yvyr + bd:envpit-durd) — drives the
REAL `envpit._environ_merge.merge_snapshot` (the shared core behind `EnvpitClient.populate_environ`,
`integrations.flask.init_app`, and `integrations.django.load_into_settings`) directly against each
vector's `snapshot`/`existing`/`options`, exactly as the vector file's own ground-truth pointer
describes for the Node sibling.

Only options every language shares (`override`, `includeSecrets`) are exercised here — Python's
own local `only=`/`exclude=` additions are intentionally NOT covered by this shared file (see its
`notes.languageLocalOptions`) and get their own Python-local coverage in
`tests/test_populate_environ.py` instead."""

from __future__ import annotations

import pytest

from envpit._environ_merge import merge_snapshot

from ._vectors import load_vectors

VECTORS = load_vectors("env-merge.json")["cases"]


@pytest.mark.parametrize("case", VECTORS, ids=[c["name"] for c in VECTORS])
def test_env_merge_vector(case: dict) -> None:
    snapshot = case["snapshot"]
    options = case["options"]
    target: dict[str, str] = dict(case["existing"])

    result = merge_snapshot(
        snapshot["values"],
        target,
        override=options.get("override", False),
        only=None,
        exclude=None,
        secret_keys=snapshot["secretKeys"],
        include_secrets=options.get("includeSecrets", False),
    )

    expected = case["expected"]
    assert list(result.merged) == expected["merged"]
    assert list(result.skipped_existing) == expected["skippedExisting"]
    assert list(result.skipped_secrets) == expected["skippedSecrets"]
