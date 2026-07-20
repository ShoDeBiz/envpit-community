"""Typed error hierarchy for the EnvPit Python SDK — 1:1 with the shipped Node SDK's 4-class
taxonomy (`AuthenticationError`/`NetworkError`/`MissingKeyError`/`TypeMismatchError`; ADR-S3-08 —
v1 does NOT add `NotFoundError`/`RateLimitError`/`ServerError`, a coordinated all-4-SDK follow-up
tracked as bd:envpit-aw7l). Every SDK error extends `EnvpitError` so callers can
`except EnvpitError` for a catch-all, or catch a specific subclass for precise handling.

Never echo the API key or config VALUES in any error message — key names are not secret and
may appear (INV-SDK-11). One documented, accepted exception: `TypeMismatchError` echoes the
raw offending value (shipped-Node parity, ADR-S3-01; accepted by Sentinel THREATMODEL-
envpit-0t2z-3.md F6/INV-SDK-11 as a deliberate, bounded carve-out — values reaching typed
getters are overwhelmingly non-secret ports/flags). New surfaces must NOT repeat this pattern
outside this one carve-out.
"""

from __future__ import annotations


class EnvpitError(Exception):
    """Base class for every error raised by the EnvPit SDK. `except EnvpitError` is the
    catch-all; prefer a specific subclass for precise handling."""


class AuthenticationError(EnvpitError):
    """The server rejected the API key (HTTP 401/403) — revoked, expired, mistyped, or
    IP-blocked — OR no API key was found at all when `envpit.load()` was called."""


class NetworkError(EnvpitError):
    """Transport failure: DNS/connect/timeout, a non-2xx response that isn't an auth failure,
    an invalid/oversized JSON response body, or an oversized/malformed realtime stream."""


class MissingKeyError(EnvpitError):
    """`get()`/`get_string()`/`get_int()`/`get_bool()` called for a key that isn't in the
    loaded snapshot (or whose value is `None`) and no default was supplied."""

    def __init__(self, key: str) -> None:
        super().__init__(
            f'Config key "{key}" is not set and no default value was provided. '
            f'Pass a default (e.g. client.get("{key}", "fallback")) if this key is allowed '
            "to be absent."
        )
        self.key = key


class TypeMismatchError(EnvpitError):
    """A typed getter (`get_int`/`get_bool`) could not coerce the stored string value."""

    def __init__(self, key: str, expected_type: str, raw_value: str) -> None:
        super().__init__(f'Config key "{key}" is not a valid {expected_type} (got "{raw_value}").')
        self.key = key
        self.expected_type = expected_type
