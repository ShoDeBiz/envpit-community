package com.envpit;

import java.util.function.Consumer;

/**
 * The SDK's ONE safety-wrapper shape, used both for per-listener dispatch ({@code
 * EnvpitClient.invokeSafely}) and for invoking the injected {@link EnvpitLogger} ({@code
 * EnvpitClient.safeLog}) — extracted into a standalone, directly unit-testable utility so the
 * "{@code catch (Exception)}, never {@code catch (Throwable)}" contract has its own dedicated,
 * unambiguous test (see {@code SafetyWrapperTest}) rather than being provable only indirectly
 * through background-thread dispatch timing.
 *
 * <p>Deliberately {@code catch (Exception)}: a {@link Throwable} catch would also catch {@link
 * Error} subclasses ({@link OutOfMemoryError}, {@link StackOverflowError}, etc.) — the "Java
 * over-catch trap" Sara flagged (SPEC-envpit-0t2z-3-1a-architecture.md §3.3) — which must be
 * allowed to propagate out of this method, not be silently swallowed by a listener/logger safety
 * wrapper. bd:envpit-r59g class: this is Java's version of Node's SafeEmitter / Python's
 * lock-guarded safety / Go's {@code recover()}-based {@code safeInvoke}, scoped correctly to
 * avoid the over-catch trap.
 */
final class SafeInvoke {

    private SafeInvoke() {
    }

    /**
     * Runs {@code action}. If it throws a {@link RuntimeException} (or any checked-but-unlikely
     * {@link Exception}, though {@code Runnable#run} can only declare unchecked ones), {@code
     * onCaught} is invoked with it and this method returns normally. If it throws an {@link
     * Error}, this method does NOT catch it — it propagates straight out, exactly as if this
     * wrapper were not present.
     */
    static void invoke(Runnable action, Consumer<Exception> onCaught) {
        try {
            action.run();
        } catch (Exception e) {
            onCaught.accept(e);
        }
    }
}
