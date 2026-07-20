package com.envpit;

import java.time.Duration;
import java.time.Instant;

/**
 * A point-in-time view of the client's in-memory cache — the pull-style equivalent of the
 * onChange/onConnection/onError push-style listener registrations.
 *
 * @param fetchedAt     when the currently-served snapshot was fetched. Always set once {@code
 *                       load()} has returned successfully.
 * @param age            {@code Duration.between(fetchedAt, now)}, computed at the moment {@link
 *                       EnvpitClient#cacheInfo()} was called.
 * @param lastError      the error from the most recent FAILED refresh attempt, or {@code null}
 *                       whenever the most recent refresh (or the initial load) succeeded.
 * @param etag           the ETag response header captured from the currently-served snapshot's
 *                       fetch, or {@code ""} if the server didn't send one.
 * @param refreshMode    what's currently keeping the snapshot fresh.
 * @param realtimeSince  when the realtime channel most recently became connected, or {@code null}
 *                       whenever {@code refreshMode != REALTIME}.
 * @param lastChangeAt   when the currently-served snapshot last differed from the one before it
 *                       (i.e. the last time a {@code change} event fired), or {@code null} if no
 *                       change has been observed since load.
 */
public record CacheInfo(
        Instant fetchedAt,
        Duration age,
        EnvpitException lastError,
        String etag,
        RefreshMode refreshMode,
        Instant realtimeSince,
        Instant lastChangeAt) {
}
