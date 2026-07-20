"""Consumes `test-vectors/getters.json` — the shared cross-language typed-getter behavior
suite (25 cases). Ground truth: `src/envpit/client.py` (INTEGER_PATTERN/TRUE_VALUES/
FALSE_VALUES, `_read_raw`'s null-equals-absent rule) — ported 1:1 from the shipped Node SDK."""

from __future__ import annotations

import pytest

from envpit.errors import MissingKeyError, TypeMismatchError

from ._utils import make_loaded_client
from ._vectors import load_vectors

VECTORS = load_vectors("getters.json")["cases"]

ERROR_CLASSES = {"MissingKeyError": MissingKeyError, "TypeMismatchError": TypeMismatchError}
GETTER_KIND = {"string": "get", "int": "get_int", "boolean": "get_bool"}


@pytest.mark.parametrize("case", VECTORS, ids=[c["name"] for c in VECTORS])
def test_getter_vector(case: dict) -> None:
    client = make_loaded_client(case["snapshot"])
    try:
        method = getattr(client, GETTER_KIND[case["kind"]])
        args = [case["key"]]
        if "default" in case:
            args.append(case["default"])

        expected = case["expected"]
        if "error" in expected:
            with pytest.raises(ERROR_CLASSES[expected["error"]]):
                method(*args)
        else:
            assert method(*args) == expected["value"]
    finally:
        client.close()
