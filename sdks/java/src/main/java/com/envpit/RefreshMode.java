package com.envpit;

/** Reports what's currently keeping the client's snapshot fresh. */
public enum RefreshMode {
    REALTIME,
    POLLING,
    /** The poll interval was zero/non-positive: no background refresh of any kind (INV-SDK-8). */
    OFF
}
