package com.envpit;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * PRIVATE forward-provision for bd:envpit-0t2z.6 (Feature Flags SDK support) — NOT part of the v1
 * public API surface (Feature Flags hasn't shipped for any SDK language yet; CLAUDE.md's "do not
 * pull forward without discussion" applies). Exists solely so this SDK's test suite can prove,
 * today, that a byte-exact port of {@code test-vectors/hashing.json}'s documented bucketing recipe
 * produces identical results to the canonical golden vectors — the cross-language parity proof
 * SPEC-envpit-0t2z-3-1a-architecture.md §6 asks every language to establish ahead of the feature
 * itself landing, mirroring the shipped Python {@code _hashing.py} / Go {@code hashing.go}.
 *
 * <p>{@code bucket = (first 4 bytes of SHA-256(UTF-8(salt + ":" + key)), read as a BIG-ENDIAN
 * UNSIGNED 32-bit integer) mod 10000}. No normalization of {@code key} — no trim, no case-fold, no
 * Unicode normalization; raw UTF-8 bytes as given. SHA-256 is on the JCA's list of algorithms
 * every conforming Java platform is REQUIRED to implement (Sara §6), so {@link
 * NoSuchAlgorithmException} here is unreachable on any conforming JVM — still declared/wrapped
 * defensively rather than silently assumed.
 *
 * <p><b>The JVM signed-int trap (test-vectors/hashing.json's {@code algorithm.notes}):</b> the
 * 32-bit read MUST be unsigned. {@code java.nio.ByteBuffer.getInt()} returns a signed {@code int}
 * — reading the big-endian bytes and masking with {@code & 0xFFFFFFFFL} into a {@code long} before
 * the {@code % 10000} is the fix; skipping the mask would silently produce a negative bucket for
 * roughly half of all possible digests.
 */
final class Hashing {

    private Hashing() {
    }

    static int bucket(String key, String salt) {
        byte[] digest;
        try {
            MessageDigest sha256 = MessageDigest.getInstance("SHA-256");
            digest = sha256.digest((salt + ":" + key).getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("envpit: SHA-256 is required on every conforming JVM but was unavailable", e);
        }
        long unsigned = ((digest[0] & 0xFFL) << 24)
                | ((digest[1] & 0xFFL) << 16)
                | ((digest[2] & 0xFFL) << 8)
                | (digest[3] & 0xFFL);
        return (int) (unsigned % 10000);
    }
}
