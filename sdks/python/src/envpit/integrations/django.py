"""Django integration (bd:envpit-yvyr) — Django has NO plugin hook for external settings sources.
Its settings loader (`django.conf.LazySettings._setup`) just imports `settings.py` as a plain
module and reads UPPERCASE module-level names off it; there is nothing like pydantic-settings'
`settings_customise_sources()` to hook into. The accepted idiom — the one `django-environ` and
`django-configurations` both use — is to populate values at the TOP of `settings.py`, before the
rest of the module reads them.

`load_into_settings(globals())`, called from inside `settings.py`, targets that module's own
namespace directly: at module scope, `globals()` IS the module's real `__dict__`, so writing into
it defines module-level settings names, exactly as `SECRET_KEY = os.environ["SECRET_KEY"]` would
— but without `os.environ`'s "everything must be a string" constraint (Django settings routinely
need real `bool`/`int`/`list` values: `client.get_bool("DEBUG")`, `client.get_int("PORT")`).

Deliberately has NO dependency on Django itself — it operates on any
`MutableMapping[str, object]`, so it needs no `django` install to import or test; it is simply
documented/intended for use against a `settings.py` module namespace.

Example (top of `settings.py`):
    import envpit
    from envpit.integrations.django import load_into_settings

    _client = envpit.load()
    load_into_settings(globals(), client=_client)

    DEBUG = DEBUG == "true"          # typed post-processing — every EnvPit value is a string
    ALLOWED_HOSTS = ALLOWED_HOSTS.split(",")
"""

from __future__ import annotations

from collections.abc import Collection, MutableMapping

from .._environ_merge import merge_snapshot
from ..client import EnvpitClient
from ..types import MergeResult


def load_into_settings(
    settings_globals: MutableMapping[str, object],
    *,
    client: EnvpitClient | None = None,
    override: bool = False,
    include_secrets: bool = False,
    only: Collection[str] | None = None,
    exclude: Collection[str] | None = None,
) -> MergeResult:
    """Merges `client`'s (or the module-level default client's) current snapshot into
    `settings_globals` (pass `globals()` from inside `settings.py`). A name already defined in
    `settings_globals` wins by default — pass `override=True` to let EnvPit values win instead.

    Same secret-exclusion default as `EnvpitClient.populate_environ()` (bd:envpit-yvyr,
    bd:envpit-durd): a key flagged `is_secret=true` server-side (e.g. `SECRET_KEY`) is excluded by
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
        settings_globals,
        override=override,
        only=only,
        exclude=exclude,
        secret_keys=resolved_client._known_secret_keys(),
        include_secrets=include_secrets,
    )
