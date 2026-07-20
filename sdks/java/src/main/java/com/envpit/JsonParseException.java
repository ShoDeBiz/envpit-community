package com.envpit;

/**
 * Thrown by {@link Json#parse(String)} on any malformed, oversized-nesting, or otherwise unsafe
 * JSON input. Checked (not a {@link RuntimeException}) so every call site inside this SDK is
 * forced to explicitly map it onto {@link NetworkException} — never let a raw parse failure
 * escape unwrapped (mirrors the bd:envpit-4dbm-class discipline applied to transport failures).
 */
final class JsonParseException extends Exception {

    JsonParseException(String message) {
        super(message);
    }
}
