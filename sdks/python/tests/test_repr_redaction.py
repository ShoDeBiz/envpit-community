"""AC-SEC-SDK3-1 (`THREATMODEL-envpit-0t2z-3.md` F1): every type that transitively holds the
API key or the config snapshot MUST implement an explicit redacting text representation, and
the conformance suite must ADVERSARIALLY confirm it — actually try to leak a secret via
printing/formatting and assert it's redacted, not just eyeball the `__repr__` source."""

from __future__ import annotations

from envpit.client import EnvpitClient
from envpit.realtime import RealtimeCallbacks, RealtimeTransport

from ._utils import FakeSseStream, fetch_queue


def test_ac_sec_sdk3_1_client_repr_str_and_fstring_never_leak_api_key_or_snapshot_values() -> None:
    secret_key = "epk_super-secret-do-not-print-me"
    secret_value = "postgres://leak-me-not:hunter2@db.internal/prod"

    client = EnvpitClient.load(
        api_key=secret_key,
        poll_interval=0,
        _fetch_impl=fetch_queue(({"DATABASE_URL": secret_value}, None)),
    )
    try:
        rendered = {
            "repr": repr(client),
            "str": str(client),
            "fstring": f"{client}",
            "percent": "%s" % (client,),  # noqa: UP031 - deliberately adversarial % formatting
            "dot_format": "{}".format(client),  # noqa: UP032 - deliberately adversarial .format()
        }
        for label, text in rendered.items():
            assert secret_key not in text, f"api key leaked via {label}: {text}"
            assert secret_value not in text, f"config value leaked via {label}: {text}"
        assert "redacted" in rendered["repr"]
    finally:
        client.close()


def test_ac_sec_sdk3_1_realtime_transport_repr_and_str_never_leak_api_key() -> None:
    secret_key = "epk_another-secret-value-do-not-print"
    transport = RealtimeTransport(
        host="https://example.test",
        api_key=secret_key,
        poll_interval_s=60,
        callbacks=RealtimeCallbacks(
            on_change_signal=lambda etag: None,
            on_mode_change=lambda mode, reason, since: None,
            on_log=lambda level, msg: None,
        ),
        opener=lambda url, headers, timeout: FakeSseStream(),
    )
    assert secret_key not in repr(transport)
    assert secret_key not in str(transport)
    assert secret_key not in f"{transport}"


def test_ac_sec_sdk3_1_client_repr_does_not_leak_via_vars_of_the_repr_string_itself() -> None:
    """Adversarial: even a caller who dumps `repr(client.__dict__)`-style debugging output
    through the SAME formatter path (not raw attribute access, which is a different, accepted
    reflection surface — see report) must not see the key inside the client's OWN __repr__."""
    secret_key = "epk_yet-another-secret"
    client = EnvpitClient.load(
        api_key=secret_key, poll_interval=0, _fetch_impl=fetch_queue(({"K": "v"}, None))
    )
    try:
        debug_dump = f"client={client!r}"
        assert secret_key not in debug_dump
    finally:
        client.close()
