package com.envpit;

/**
 * Registered via {@link EnvpitClient#onChange(ChangeListener)}. Invoked on the SDK's single
 * daemon dispatch thread — never the caller's thread, never one thread per listener. A throwing
 * listener is caught and logged; it never prevents any other registered listener from running,
 * and never crashes the SDK or the host process (INV-SDK-6 / bd:envpit-r59g class).
 *
 * <p>Runs on a shared background thread: keep this fast. Hand off heavy work to your own executor.
 */
@FunctionalInterface
public interface ChangeListener {
    void onChange(ChangeEvent event);
}
