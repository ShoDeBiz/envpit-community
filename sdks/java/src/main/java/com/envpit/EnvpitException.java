package com.envpit;

/**
 * Base class for every exception this SDK throws. Unchecked (extends {@link RuntimeException},
 * not a checked {@code Exception}) — a config read site must not be forced into try/catch
 * ceremony (Sara SPEC-envpit-0t2z-3-1a-architecture.md §2.3: "Stripe/AWS v2 precedent"). Taxonomy
 * v1 = shipped Node's 4 concrete types ({@link AuthenticationException}, {@link NetworkException},
 * {@link MissingKeyException}, {@link TypeMismatchException}) — ADR-S3-08: NotFound/RateLimit/
 * Server additions are a coordinated all-4-SDK follow-up (bd:envpit-aw7l), not something this
 * language "fixes" unilaterally.
 *
 * <p>Never echo the API key or a config VALUE in any message — key names are not secret and may
 * appear (INV-SDK-11). One documented, accepted exception: {@link TypeMismatchException} echoes
 * the raw offending value (shipped-Node/Python parity, ADR-S3-01; Sentinel
 * THREATMODEL-envpit-0t2z-3.md F6 / INV-SDK-11's one carve-out).
 *
 * <p>{@code catch (EnvpitException e)} is this SDK's one-catch-all idiom, the Java analog of
 * Node's {@code instanceof EnvpitError} / Python's {@code except EnvpitError} / Go's
 * {@code errors.As(err, &envpitErr)}.
 */
public abstract class EnvpitException extends RuntimeException {

    protected EnvpitException(String message) {
        super(message);
    }

    protected EnvpitException(String message, Throwable cause) {
        super(message, cause);
    }
}
