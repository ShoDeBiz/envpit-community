package com.envpit;

/**
 * Registered via {@link EnvpitClient#onError(ErrorListener)}. Fires for background-refresh
 * failures (post-first-load) and for the reported-fallback case — always one of this SDK's own
 * {@link EnvpitException} subtypes, never a raw, unwrapped transport exception (the
 * bd:envpit-4dbm-class guarantee applies here specifically: a mid-connection reset on the
 * background-refresh path must reach this listener as a typed {@link NetworkException}, not
 * silently fail to fire). Same dispatch-thread and safe-invocation guarantees as {@link
 * ChangeListener}. Listener-thrown exceptions here are logged only, never re-dispatched.
 */
@FunctionalInterface
public interface ErrorListener {
    void onError(EnvpitException error);
}
