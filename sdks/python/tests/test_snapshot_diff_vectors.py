"""Consumes `test-vectors/snapshot-diff.json` (9 cases). `_diff_snapshots` in `client.py` is a
private, module-level function (correctly so — internal implementation detail), so this drives
the REAL `EnvpitClient` through two successive fetches (before -> after, via a directly-invoked
`_refresh()`, the whitebox equivalent of Node's "advance one fake poll tick") and observes the
result the same way any real caller would: via the `change` event's `changed_keys`."""

from __future__ import annotations

import pytest

from envpit.client import EnvpitClient

from ._utils import fetch_queue
from ._vectors import load_vectors

VECTORS = load_vectors("snapshot-diff.json")["cases"]


@pytest.mark.parametrize("case", VECTORS, ids=[c["name"] for c in VECTORS])
def test_snapshot_diff_vector(case: dict) -> None:
    fetch = fetch_queue((case["before"], None), (case["after"], None))
    client = EnvpitClient.load(api_key="epk_test", poll_interval=0, _fetch_impl=fetch)
    try:
        changes = []
        client.on_change(lambda e: changes.append(e))

        client._refresh(is_first_load=False, trigger="poll")

        if case["expectedChangedKeys"]:
            assert len(changes) == 1
            assert changes[0].changed_keys == case["expectedChangedKeys"]
        else:
            assert changes == []
    finally:
        client.close()
