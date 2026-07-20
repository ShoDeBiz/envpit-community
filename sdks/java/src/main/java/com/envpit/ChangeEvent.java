package com.envpit;

import java.time.Instant;
import java.util.List;

/**
 * Payload delivered to a {@link ChangeListener}. Log-safe by construction (INV-SDK-7): key NAMES
 * only, sorted, never values.
 */
public record ChangeEvent(List<String> changedKeys, String etag, Instant receivedAt, ChangeTrigger trigger) {

    public ChangeEvent {
        changedKeys = List.copyOf(changedKeys); // defensive immutability
    }
}
