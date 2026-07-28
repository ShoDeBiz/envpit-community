"""Shared merge logic for `EnvpitClient.populate_environ()` and every `integrations/*` module
(`flask.init_app`, `django.load_into_settings`) — one precedence implementation, reused against
three different target mappings (`os.environ`, `Flask.config`, a `settings.py` module namespace)
rather than three copies that could silently drift apart (bd:envpit-yvyr).

Precedence (python-dotenv-style, owner decision bd:envpit-yvyr, settled):
  - A key already present in `target` wins UNLESS `override=True`.
  - A snapshot value of `None` (an unset EnvPit variable) is never written — there's nothing to
    write, and `os.environ` can't hold `None` anyway.
  - `exclude` (explicit, by name) always wins over merging, regardless of `override`.

NOTE — secret-filtering socket (Oliver, bd:envpit-yvyr, 2026-07-28 correction, independently
verified against `apps/api/src/config-management/config-resolve.controller.ts` /
`config.service.ts` in the main `envpit` repo): the wire protocol this SDK's transport consumes
returns a flat `key -> value` map with NO `is_secret` field — there is nothing here to filter on
by name or heuristic, and doing so would be wrong in both directions (e.g. `DATABASE_URL` often
embeds a password and would NOT match a naive secret-name heuristic). `exclude` is the only
filter this module applies; callers (`EnvpitClient.populate_environ`) are responsible for folding
any future server-provided secret-key set into `exclude` before calling `merge_snapshot` — see
`EnvpitClient._known_secret_keys()`.
"""

from __future__ import annotations

from collections.abc import Collection, Mapping, MutableMapping
from typing import Any


def merge_snapshot(
    snapshot: Mapping[str, str | None],
    target: MutableMapping[str, Any],
    *,
    override: bool,
    exclude: Collection[str] | None,
) -> set[str]:
    """Merges `snapshot` into `target` in place. Returns the set of keys actually written (never
    includes values — log-safe by construction, same convention as `ChangeEvent.changed_keys`)."""
    excluded = frozenset(exclude) if exclude else frozenset()
    written: set[str] = set()
    for key, value in snapshot.items():
        if value is None:
            continue
        if key in excluded:
            continue
        if not override and key in target:
            continue
        target[key] = value
        written.add(key)
    return written
