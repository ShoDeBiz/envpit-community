package com.envpit;

/**
 * {@code get}/{@code getInt}/{@code getBoolean} called for a key that isn't in the loaded
 * snapshot (or whose value is {@code null}) and no default was supplied. Carries {@link #getKey()}
 * so callers can programmatically inspect which key was missing without parsing the message.
 */
public final class MissingKeyException extends EnvpitException {

    private final String key;

    public MissingKeyException(String key) {
        super("Config key \"" + key + "\" is not set and no default value was provided. "
                + "Pass a default (e.g. client.get(\"" + key + "\", \"fallback\")) if this key is allowed to be absent.");
        this.key = key;
    }

    /** The key name that was missing. Never a config value — key names are not secret. */
    public String getKey() {
        return key;
    }
}
