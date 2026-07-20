"""`envpit-community/test-vectors/` loader — one level above `sdks/` (repo root), resolved from
THIS file's own location, matching `sdks/node/test/vector-loader.ts`'s approach. Test-code
only: never imported by `src/envpit/**`, so this adds zero runtime footprint to the published
package (bd:envpit-0t2z.3 Slice 0 / Python being the first consumer)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

TEST_VECTORS_ROOT = Path(__file__).resolve().parents[3] / "test-vectors"


def load_vectors(name: str) -> Any:
    """Loads and parses one `test-vectors/<name>.json` file. `name` includes the `.json`
    extension, e.g. `load_vectors('sse-frames.json')`."""
    path = TEST_VECTORS_ROOT / name
    return json.loads(path.read_text(encoding="utf-8"))
