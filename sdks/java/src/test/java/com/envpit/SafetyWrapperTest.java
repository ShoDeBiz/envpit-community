package com.envpit;

import org.junit.jupiter.api.Test;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The dedicated, unambiguous test {@link SafeInvoke}'s own class doc comment promises: proves
 * {@code catch (Exception)}, never {@code catch (Throwable)} — the "Java over-catch trap" Sara
 * flagged (SPEC-envpit-0t2z-3-1a-architecture.md §3.3). Catching {@link Throwable} would also
 * catch {@link Error} subclasses ({@link OutOfMemoryError}, {@link StackOverflowError}, etc.),
 * which must be allowed to propagate/crash, not be silently swallowed by a listener/logger safety
 * wrapper (bd:envpit-r59g class). This is proven directly against {@link SafeInvoke}, not only
 * indirectly through background-thread dispatch timing.
 *
 * <p>Deliberately does NOT throw a real {@link OutOfMemoryError}/{@link StackOverflowError} (that
 * would be destructive to the test JVM) — a private, purpose-built {@link Error} subtype proves
 * the identical {@code catch (Exception)} vs. {@code catch (Throwable)} branch behavior without
 * any risk to the test run itself.
 */
class SafetyWrapperTest {

    /** A deliberately inert {@link Error} subtype — never actually corrupts JVM state, unlike a real OOM/SOE. */
    private static final class MarkerError extends Error {
        MarkerError(String message) {
            super(message);
        }
    }

    @Test
    void catchesARuntimeExceptionAndRoutesItToOnCaughtWithoutPropagating() {
        AtomicReference<Exception> caught = new AtomicReference<>();
        RuntimeException thrown = new IllegalStateException("boom");

        SafeInvoke.invoke(() -> {
            throw thrown;
        }, caught::set);

        assertSame(thrown, caught.get(), "the exact exception instance must reach onCaught");
    }

    @Test
    void doesNotCatchAnErrorSubtypeItPropagatesUnmodified() {
        AtomicBoolean onCaughtWasInvoked = new AtomicBoolean(false);
        MarkerError thrown = new MarkerError("simulated fatal JVM condition");

        MarkerError propagated = assertThrows(MarkerError.class, () -> SafeInvoke.invoke(() -> {
            throw thrown;
        }, e -> onCaughtWasInvoked.set(true)));

        assertSame(thrown, propagated, "the Error instance must propagate out of SafeInvoke.invoke unmodified");
        assertFalse(onCaughtWasInvoked.get(), "onCaught must NEVER be invoked for an Error — that would be the over-catch trap");
    }

    @Test
    void aHealthyActionRunsNormallyAndNeverInvokesOnCaught() {
        AtomicBoolean ran = new AtomicBoolean(false);
        AtomicBoolean onCaughtWasInvoked = new AtomicBoolean(false);

        SafeInvoke.invoke(() -> ran.set(true), e -> onCaughtWasInvoked.set(true));

        assertTrue(ran.get());
        assertFalse(onCaughtWasInvoked.get());
    }

    @Test
    void aRuntimeExceptionCarriesItsOwnMessageThroughUnmodified() {
        AtomicReference<String> message = new AtomicReference<>();
        SafeInvoke.invoke(() -> {
            throw new IllegalArgumentException("specific-message-xyz");
        }, e -> message.set(e.getMessage()));

        assertEquals("specific-message-xyz", message.get());
    }
}
