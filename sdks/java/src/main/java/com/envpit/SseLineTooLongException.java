package com.envpit;

/**
 * Thrown by {@link SseFrameParser#push(String)} when a single SSE line exceeds the configured
 * character cap without a terminating newline. The caller ({@link RealtimeTransport}) treats this
 * exactly like any other stream failure — drop the connection, reconnect via the existing
 * degraded/backoff path (AC-SEC-SDK3-2(b)). No new connection states are needed.
 */
final class SseLineTooLongException extends Exception {

    SseLineTooLongException(String message) {
        super(message);
    }
}
