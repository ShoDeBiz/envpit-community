"""Explicit demonstration that secret-flagged keys did NOT reach Django's settings — asserted
against the REAL `django.conf.settings` object (after Django has fully booted and frozen the
module into `LazySettings`), not against the `MergeResult` summary `load_into_settings()`
returned inside `settings.py`, which could itself be wrong.

Run:
    set -a; . ~/.envpit-example.env; set +a
    python verify.py
"""

from __future__ import annotations

import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "exampleproject.settings")

import django  # noqa: E402

django.setup()

from django.conf import settings  # noqa: E402

loaded_keys = sorted(settings.ENVPIT_MERGE_RESULT.merged)
skipped_secret_keys = sorted(settings.ENVPIT_MERGE_RESULT.skipped_secrets)

print("[envpit-django-example] merged into settings:", loaded_keys)
print("[envpit-django-example] secret-flagged keys (names only):", settings.ENVPIT_KNOWN_SECRET_KEYS)
print("[envpit-django-example] skipped as secret (per MergeResult):", skipped_secret_keys)
print(
    "[envpit-django-example] secret exclusion had an observable effect in this account:",
    settings.ENVPIT_SECRET_EXCLUSION_HAD_OBSERVABLE_EFFECT,
    "-- True means a secret WITH a value was withheld; False means every secret-flagged key is\n"
    "unset here, so the null check filtered it as absent before the secret check ran",
)

# The actual assertion: against the real settings object, not the summary above.
leaked = [k for k in settings.ENVPIT_KNOWN_SECRET_KEYS if hasattr(settings, k)]
assert not leaked, f"FAIL: secret-flagged keys reached django.conf.settings: {leaked}"
print("[envpit-django-example] OK -- no secret-flagged key is an attribute of django.conf.settings")

for key in loaded_keys:
    assert hasattr(settings, key), f"FAIL: {key} was reported merged but is not on settings"
print("[envpit-django-example] OK -- every reported-merged key IS a real settings attribute")
