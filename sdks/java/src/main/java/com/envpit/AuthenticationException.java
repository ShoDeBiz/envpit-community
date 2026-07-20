package com.envpit;

/**
 * The server rejected the API key (HTTP 401/403), or no API key was found at all when
 * {@code EnvpitClient.builder()...load()} was called. Message copy is byte-for-byte the
 * {@code java} column of {@code test-vectors/error-messages.json} (Uma
 * SPEC-envpit-0t2z-3-1b-ux.md §2.2).
 */
public final class AuthenticationException extends EnvpitException {

    public AuthenticationException(String message) {
        super(message);
    }
}
