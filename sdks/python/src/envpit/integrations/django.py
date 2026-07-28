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


def load_into_settings(
    settings_globals: MutableMapping[str, object],
    *,
    client: EnvpitClient | None = None,
    override: bool = False,
    exclude: Collection[str] | None = None,
) -> set[str]:
    """Merges `client`'s (or the module-level default client's) current snapshot into
    `settings_globals` (pass `globals()` from inside `settings.py`). A name already defined in
    `settings_globals` wins by default — pass `override=True` to let EnvPit values win instead.

    Same secret-filtering limitation as `EnvpitClient.populate_environ()` (bd:envpit-yvyr): the
    wire protocol carries no `is_secret` flag, so nothing is auto-excluded by name — use
    `exclude=` for anything (e.g. `SECRET_KEY`) you'd rather set some other way.

    Returns the set of key NAMES actually written (never values)."""
    resolved_client = client
    if resolved_client is None:
        from .. import _require_default

        resolved_client = _require_default()

    combined_exclude = frozenset(exclude or ()) | resolved_client._known_secret_keys()
    return merge_snapshot(
        resolved_client.snapshot(), settings_globals, override=override, exclude=combined_exclude
    )
