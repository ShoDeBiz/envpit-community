package com.envpit;

/**
 * Registered via {@link EnvpitClient#onConnection(ConnectionListener)}. Same dispatch-thread and
 * safe-invocation guarantees as {@link ChangeListener}.
 */
@FunctionalInterface
public interface ConnectionListener {
    void onConnection(ConnectionEvent event);
}
