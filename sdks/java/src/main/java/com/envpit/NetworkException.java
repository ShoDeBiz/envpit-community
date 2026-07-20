package com.envpit;

/**
 * Transport failure: DNS/connect/timeout/connection-reset (bd:envpit-4dbm-class — see {@code
 * Transport.mapTransportFailure}), a non-2xx response that isn't an auth failure, an invalid or
 * oversized JSON response body, or an oversized/malformed realtime stream. The underlying cause
 * (when there is one) is chained via the standard {@link #getCause()} — Java readers expect the
 * chain, not a flattened string (Uma SPEC-envpit-0t2z-3-1b-ux.md §2.2, "Java" column note).
 */
public final class NetworkException extends EnvpitException {

    public NetworkException(String message) {
        super(message);
    }

    public NetworkException(String message, Throwable cause) {
        super(message, cause);
    }
}
