"""Django settings — loads EnvPit config via `envpit.integrations.django.load_into_settings()`.

Django has NO plugin hook for external settings sources (see that module's docstring); the
accepted idiom — the same one `django-environ`/`django-configurations` use — is populating
values at the TOP of `settings.py`, before the rest of this module reads them. That is exactly
what happens below: `load_into_settings(globals())` writes `DB_URL`/`GREETING`/`MOELSOE` as
real module-level names in THIS module's own namespace, which is how
`django.conf.settings.DB_URL` etc. end up working, untouched, once Django boots.
"""

from __future__ import annotations

import os

import envpit
from envpit.integrations.django import load_into_settings

# The SDK auto-reads ENVPIT_API_KEY from the environment, but NOT ENVPIT_HOST (verified against
# envpit/client.py -- only the API key has that env-var convenience). Passed through explicitly
# here to reach this account's real, production server.
_client = envpit.load(host=os.environ.get("ENVPIT_HOST"), poll_interval=0)

# Populates DB_URL / GREETING / MOELSOE into this module's globals(). HOMER_KEY is flagged
# secret server-side and is excluded by default -- it will NOT become a module-level name here.
ENVPIT_MERGE_RESULT = load_into_settings(globals(), client=_client)

# A second merge, into a throwaway dict (NOT globals()) with include_secrets=True, isolates
# whether the exclusion did anything observable in THIS account right now.
#
# NOTE (verified the hard way — see README "awkward against a live server"): Django's settings
# loader only copies UPPERCASE module-level names onto `django.conf.settings`
# (`LazySettings._setup` -> `Settings.__init__`, confirmed against the installed `django`
# package: `for setting in dir(mod): if setting.isupper(): ...`). A first attempt at this file
# used lowercase names for these two probe values and `verify.py` could not see them on the real
# `settings` object at all (`AttributeError`) even though `load_into_settings(globals())` itself
# worked fine — the failure was in `django.conf.settings`'s own filtering, not in the SDK. They
# are UPPERCASE here for that reason, not because they are real Django settings.
_secret_probe_globals: dict[str, object] = {}
_merge_result_with_secrets = load_into_settings(
    _secret_probe_globals, client=_client, include_secrets=True
)
ENVPIT_SECRET_EXCLUSION_HAD_OBSERVABLE_EFFECT = bool(
    set(_client.known_secret_keys()) & set(_merge_result_with_secrets.merged)
)
ENVPIT_KNOWN_SECRET_KEYS = sorted(_client.known_secret_keys())

# --- Django boot minimum -- NOT sourced from EnvPit. This account has no key named SECRET_KEY;
# inventing a fake auto-wiring for one would misrepresent what load_into_settings() does (it
# merges whatever key NAMES exist in the account, nothing more).
SECRET_KEY = "django-insecure-example-only-do-not-use-in-real-deployments"  # noqa: S105
DEBUG = True
ALLOWED_HOSTS: list[str] = ["*"]
