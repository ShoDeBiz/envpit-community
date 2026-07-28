"""Flask integration (bd:envpit-yvyr) — Flask's own idiom for programmatic config loading is
`app.config` (a `dict` subclass; `from_mapping`/`from_object`/`from_pyfile` all funnel into it).
`init_app(app)` merges the resolved EnvPit snapshot into `app.config`, the same shape any other
Flask extension's `init_app(app)` hook takes.

Requires `flask` installed (`pip install envpit[flask]`) — this module is never imported by the
core `envpit` package, so importing it explicitly is the only place that dependency is needed.
"""

from __future__ import annotations

from collections.abc import Collection
from typing import TYPE_CHECKING

from .._environ_merge import merge_snapshot
from ..client import EnvpitClient
from ..types import MergeResult

if TYPE_CHECKING:
    from flask import Flask


def init_app(
    app: Flask,
    *,
    client: EnvpitClient | None = None,
    override: bool = False,
    include_secrets: bool = False,
    only: Collection[str] | None = None,
    exclude: Collection[str] | None = None,
) -> MergeResult:
    """Merges `client`'s (or the module-level default client's) current snapshot into
    `app.config`. A key already present in `app.config` wins by default — pass `override=True`
    if EnvPit values should take precedence over whatever was set before this call (e.g. call
    `init_app` LAST if you want it authoritative, matching Flask's own "later call wins"
    convention for `from_mapping`/`from_object`).

    Same secret-exclusion default as `EnvpitClient.populate_environ()` (bd:envpit-yvyr,
    bd:envpit-durd): a key flagged `is_secret=true` server-side is excluded from `app.config` by
    default — pass `include_secrets=True` to opt in. `only=`/`exclude=` narrow the merge further
    by name (see `_environ_merge.py`'s module docstring for the exact check order) but cannot pull
    a secret through without `include_secrets=True`.

    Returns a `MergeResult` — three SORTED, values-free key-name tuples (never values)."""
    resolved_client = client
    if resolved_client is None:
        from .. import _require_default

        resolved_client = _require_default()

    return merge_snapshot(
        resolved_client.snapshot(),
        app.config,
        override=override,
        only=only,
        exclude=exclude,
        secret_keys=resolved_client._known_secret_keys(),
        include_secrets=include_secrets,
    )
