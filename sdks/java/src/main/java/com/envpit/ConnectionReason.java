package com.envpit;

/** Explains why {@link ConnectionMode} is what it is. */
public enum ConnectionReason {
    CONNECTED,
    SERVER_RECONNECT,
    NETWORK,
    SHUTDOWN
}
