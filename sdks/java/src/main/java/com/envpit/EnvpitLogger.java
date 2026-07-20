package com.envpit;

/**
 * Injectable diagnostics sink. Pass one to {@code EnvpitClient.builder().logger(...)} — the
 * default (when {@code .logger(...)} is never called) is a {@link JulEnvpitLogger} backed by
 * {@code java.util.logging}, visible on stderr out of the box at WARNING+ with zero setup (Uma
 * SPEC-envpit-0t2z-3-1b-ux.md §3.3 flag #4/#5.4 — zero-dep ADR-S3-02 forecloses SLF4J as a
 * default, but a stdlib JUL adapter gives Java the same visible-by-default posture as Python's
 * named-logger default rather than a silent no-op). Pass {@code .logger(message -> {})}-shaped
 * no-ops, or {@code null}, to silence all SDK log output.
 *
 * <p>SDK log lines are always English and NEVER contain a config value or the API key (INV-SDK-11)
 * — only key names/counts/durations. An implementation that itself throws is caught by the SDK
 * (never crashes a refresh or dispatch) and reported once, directly to stderr, then suppressed.
 *
 * <p>Bridging to SLF4J is a 3-line paste (Uma §3.3):
 * <pre>{@code
 * EnvpitClient.builder().logger(new EnvpitLogger() {
 *     private final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger("envpit");
 *     public void debug(String m) { log.debug(m); }
 *     public void info(String m)  { log.info(m); }
 *     public void warn(String m)  { log.warn(m); }
 *     public void error(String m) { log.error(m); }
 * })...load();
 * }</pre>
 */
public interface EnvpitLogger {
    void debug(String message);

    void info(String message);

    void warn(String message);

    void error(String message);
}
