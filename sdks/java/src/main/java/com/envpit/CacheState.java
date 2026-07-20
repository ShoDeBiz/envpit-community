package com.envpit;

import java.time.Instant;

/**
 * The whole of {@link EnvpitClient}'s mutable cache state, bundled behind ONE {@code volatile}
 * reference (Sara SPEC-envpit-0t2z-3-1a-architecture.md §2.3: "{@code volatile} reference to an
 * immutable Map — lock-free reads"; generalized here from just the snapshot to the small cluster
 * of fields that must be read together consistently by {@link EnvpitClient#cacheInfo()}). Every
 * write REPLACES the whole record with a new one — never a partial in-place mutation — so a
 * concurrent reader on any thread always sees one fully-consistent generation, never a torn
 * read across fields, with no lock needed on the read path.
 */
record CacheState(
        ConfigSnapshot snapshot,
        Instant fetchedAt,
        EnvpitException lastError,
        String etag,
        RefreshMode refreshMode,
        Instant realtimeSince,
        Instant lastChangeAt) {
}
