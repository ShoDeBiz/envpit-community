package com.envpit;

/** Reports the realtime channel's state. */
public enum ConnectionMode {
    /** The SSE connection is open and receiving pushes. */
    REALTIME,
    /** Relying on the poll interval only (never opened, or currently degraded). */
    POLLING
}
