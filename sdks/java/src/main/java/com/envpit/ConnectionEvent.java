package com.envpit;

import java.time.Instant;

/**
 * Payload delivered to a {@link ConnectionListener} — fires ONLY on an actual {@link
 * ConnectionMode} transition, never once per (re)connect attempt (INV-SDK-10).
 */
public record ConnectionEvent(ConnectionMode mode, Instant since, ConnectionReason reason) {
}
