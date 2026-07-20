package com.envpit;

/** What caused the refresh that produced a {@link ChangeEvent}. */
public enum ChangeTrigger {
    /** An SSE {@code config-changed} notification triggered the refresh. */
    PUSH,
    /** The regular poll-interval timer triggered the refresh. */
    POLL,
    /** The realtime channel just (re)connected and a catch-up refresh found a missed change. */
    RECONNECT
}
