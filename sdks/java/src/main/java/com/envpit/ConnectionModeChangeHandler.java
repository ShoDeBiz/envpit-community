package com.envpit;

import java.time.Instant;

/** Internal callback shape {@link RealtimeTransport} uses to report a {@link ConnectionMode} transition. */
@FunctionalInterface
interface ConnectionModeChangeHandler {
    void handle(ConnectionMode mode, ConnectionReason reason, Instant since);
}
