package com.envpit;

/**
 * {@code getInt}/{@code getBoolean} could not coerce the stored string value into the requested
 * type. {@link #getRawValue()} is the ONE documented INV-SDK-11 carve-out in the whole SDK
 * (shipped-Node/Python parity, ADR-S3-01; Sentinel THREATMODEL-envpit-0t2z-3.md F6): values
 * reaching typed getters are overwhelmingly non-secret ports/flags, and the echo has real
 * debugging value. No other error type in this SDK repeats this pattern.
 */
public final class TypeMismatchException extends EnvpitException {

    private final String key;
    private final String expectedType;
    private final String rawValue;

    public TypeMismatchException(String key, String expectedType, String rawValue) {
        super("Config key \"" + key + "\" is not a valid " + expectedType + " (got \"" + rawValue + "\").");
        this.key = key;
        this.expectedType = expectedType;
        this.rawValue = rawValue;
    }

    /** The key name whose value did not parse. Never a config value. */
    public String getKey() {
        return key;
    }

    /** The type that was requested (e.g. {@code "integer"}, {@code "boolean"}). */
    public String getExpectedType() {
        return expectedType;
    }

    /**
     * The raw offending value, verbatim. THE one documented carve-out to this SDK's
     * value-free-message rule (INV-SDK-11) — see the class doc comment.
     */
    public String getRawValue() {
        return rawValue;
    }
}
