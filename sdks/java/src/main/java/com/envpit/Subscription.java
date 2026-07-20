package com.envpit;

/**
 * Returned by {@code onChange}/{@code onConnection}/{@code onError}. Extends {@link AutoCloseable}
 * (no checked exception on {@link #close()} — unsubscribing is always safe) so subscriptions work
 * naturally with try-with-resources, matching {@link EnvpitClient}'s own {@code AutoCloseable}
 * shape. Idempotent: closing an already-closed subscription is a no-op, never an error.
 */
public interface Subscription extends AutoCloseable {
    @Override
    void close();
}
