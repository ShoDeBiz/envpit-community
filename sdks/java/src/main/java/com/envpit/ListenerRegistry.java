package com.envpit;

import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Tracks every live listener for one event kind (change/connection/error). {@link
 * CopyOnWriteArrayList} per the architecture spec (Sara SPEC-envpit-0t2z-3-1a-architecture.md
 * §2.3): thread-safe, optimized for the actual access pattern here — subscribe/unsubscribe is
 * rare, iteration (dispatch) is comparatively frequent, and a listener throwing or unsubscribing
 * mid-dispatch can never corrupt the iteration or skip another listener, because {@code
 * CopyOnWriteArrayList}'s iterator is a stable snapshot of the array at the moment iteration
 * began (Sara §3.3: "Node parity — every other listener still runs").
 */
final class ListenerRegistry<T> {

    private final CopyOnWriteArrayList<T> listeners = new CopyOnWriteArrayList<>();

    Subscription add(T listener) {
        listeners.add(listener);
        return () -> listeners.remove(listener); // idempotent: a second remove() is a harmless no-op
    }

    /**
     * A stable, safe-to-iterate snapshot for dispatch — {@code CopyOnWriteArrayList} itself IS
     * that snapshot (no extra copy needed); returning it directly is intentional.
     */
    Iterable<T> forDispatch() {
        return listeners;
    }
}
