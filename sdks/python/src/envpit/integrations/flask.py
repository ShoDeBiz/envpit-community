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

if TYPE_CHECKING:
    from flask import Flask


def init_app(
    app: Flask,
    *,
    client: EnvpitClient | None = None,
    override: bool = False,
    exclude: Collection[str] | None = None,
) -> set[str]:
    """Merges `client`'s (or the module-level default client's) current snapshot into
    `app.config`. A key already present in `app.config` wins by default — pass `override=True`
    if EnvPit values should take precedence over whatever was set before this call (e.g. call
    `init_app` LAST if you want it authoritative, matching Flask's own "later call wins"
    convention for `from_mapping`/`from_object`).

    Same secret-filtering limitation as `EnvpitClient.populate_environ()` (bd:envpit-yvyr): the
    wire protocol carries no `is_secret` flag, so nothing is auto-excluded by name — use
    `exclude=` for anything you don't want landing in `app.config`.

    Returns the set of key NAMES actually written (never values)."""
    resolved_client = client
    if resolved_client is None:
        from .. import _require_default

        resolved_client = _require_default()

    combined_exclude = frozenset(exclude or ()) | resolved_client._known_secret_keys()
    return merge_snapshot(
        resolved_client.snapshot(), app.config, override=override, exclude=combined_exclude
    )
