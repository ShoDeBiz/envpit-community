"""Shared merge logic for `EnvpitClient.populate_environ()` and every `integrations/*` module
(`flask.init_app`, `django.load_into_settings`) — one precedence implementation, reused against
three different target mappings (`os.environ`, `Flask.config`, a `settings.py` module namespace)
rather than three copies that could silently drift apart (bd:envpit-yvyr).

Precedence (`test-vectors/env-merge.json` is the authoritative, cross-language spec — 16 cases,
all consumed by `tests/test_env_merge_vectors.py`; this function must not diverge from it), per
key, in this exact order:
  1. `only=` (a Python-local allowlist, no Node/Java equivalent, mirroring Go's `WithOnly`) —
     a key not named in `only` (when given) is skipped as if it were never fetched at all.
     Uncounted in every result list.
  2. `exclude=` (a Python-local denylist, mirroring Go's `WithExclude`) — an explicitly excluded
     key is always skipped, uncounted, regardless of every other option.
  3. A `None` value (an unset EnvPit variable) is never written — there's nothing to write, and
     `os.environ` can't hold `None` anyway. Uncounted.
  4. A key in `secret_keys` is skipped into `skipped_secrets` UNLESS `include_secrets=True`. This
     check runs BEFORE the existing-key check (step 5) — a secret already present in `target` is
     reported as `skipped_secrets`, not `skipped_existing`, because that's the reason that
     actually governs it; `override=True` alone never smuggles a secret through.
  5. A key already present in `target` wins into `skipped_existing` UNLESS `override=True`.
  6. Otherwise the key is written and reported in `merged`.

`only=`/`exclude=` interaction with secrets (owner decision, this file, bd:envpit-durd): `only=`
narrows the CANDIDATE set considered at all — it does not bypass the secret check. Naming a secret
key in `only=` still routes it through step 4, so it lands in `skipped_secrets` unless
`include_secrets=True` is ALSO passed. `only=`/`exclude=` are not part of the shared vector file
(see its own `notes.languageLocalOptions`) — they get Python-local coverage in
`tests/test_populate_environ.py` instead.
"""

from __future__ import annotations

from collections.abc import Collection, Mapping, MutableMapping
from typing import Any

from .types import MergeResult


def merge_snapshot(
    values: Mapping[str, str | None],
    target: MutableMapping[str, Any],
    *,
    override: bool,
    only: Collection[str] | None = None,
    exclude: Collection[str] | None = None,
    secret_keys: Collection[str] = (),
    include_secrets: bool = False,
) -> MergeResult:
    """Merges `values` into `target` in place. See the module docstring for the exact check
    order. Returns a `MergeResult` — three SORTED, values-free key-name tuples."""
    only_set = frozenset(only) if only is not None else None
    excluded = frozenset(exclude) if exclude else frozenset()
    secrets = frozenset(secret_keys)

    merged: list[str] = []
    skipped_existing: list[str] = []
    skipped_secrets: list[str] = []

    for key, value in values.items():
        if only_set is not None and key not in only_set:
            continue
        if key in excluded:
            continue
        if value is None:
            continue
        if key in secrets and not include_secrets:
            skipped_secrets.append(key)
            continue
        if key in target and not override:
            skipped_existing.append(key)
            continue
        target[key] = value
        merged.append(key)

    return MergeResult(
        merged=tuple(sorted(merged)),
        skipped_existing=tuple(sorted(skipped_existing)),
        skipped_secrets=tuple(sorted(skipped_secrets)),
    )
