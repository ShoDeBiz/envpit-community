"""Consumes `test-vectors/hashing.json` — the SHA-256 rollout-bucketing determinism vectors.
FORWARD PROVISION (bd:envpit-0t2z.3 Slice 0): no shipped SDK language buckets anything yet
(Feature Flags SDK support ships under bd:envpit-0t2z.6). This proves `envpit._hashing.bucket`
— a private, non-public-API helper — produces byte-exact results against the canonical golden
vectors (`envpit` main repo's `libs/shared/src/flag-evaluation-vectors.ts`), independent of any
other language's implementation, which is the actual cross-language parity proof requested for
this dispatch: Python's bucketing recipe agrees with the SAME ground truth Node/Go/Java will
each be held to when bd:envpit-0t2z.6 lands, catching any byte-slicing/endianness divergence
now rather than after four independent ports exist."""

from __future__ import annotations

import pytest

from envpit._hashing import bucket

from ._vectors import load_vectors

VECTORS = load_vectors("hashing.json")
SALT = VECTORS["salt"]
CASES = VECTORS["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["key"] or "empty-string" for c in CASES])
def test_hashing_bucket_vector(case: dict) -> None:
    assert bucket(case["key"], SALT) == case["expectedBucket"]
