package com.envpit;

import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Default {@link EnvpitLogger} implementation — zero-dependency, backed by stdlib {@code
 * java.util.logging} (Uma SPEC-envpit-0t2z-3-1b-ux.md §3.3 flag #4/#5.4, ratified). JUL's root
 * logger defaults to level INFO with a console handler at level INFO, so {@code info}/{@code
 * warn}/{@code error} lines are visible on stderr with zero application setup — matching Python's
 * "observable by default" named-logger posture rather than Node's silent-unless-injected one.
 * {@code debug} maps to {@link Level#FINE}, which is filtered out by default (opt-in via standard
 * JUL configuration), matching the "debug is quiet by default" convention used elsewhere in this
 * SDK's diagnostics cadence (INV-SDK-10).
 */
final class JulEnvpitLogger implements EnvpitLogger {

    private final Logger delegate;

    JulEnvpitLogger() {
        this.delegate = Logger.getLogger("envpit");
    }

    @Override
    public void debug(String message) {
        delegate.log(Level.FINE, message);
    }

    @Override
    public void info(String message) {
        delegate.log(Level.INFO, message);
    }

    @Override
    public void warn(String message) {
        delegate.log(Level.WARNING, message);
    }

    @Override
    public void error(String message) {
        delegate.log(Level.SEVERE, message);
    }
}
