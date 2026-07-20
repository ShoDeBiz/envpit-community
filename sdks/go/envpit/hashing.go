package envpit

import (
	"crypto/sha256"
	"encoding/binary"
)

// bucket is a PRIVATE forward-provision for bd:envpit-0t2z.6 (Feature Flags SDK support) — NOT
// part of the v1 public API surface (Feature Flags hasn't shipped for any SDK language yet;
// CLAUDE.md's "do not pull forward without discussion" applies).
//
// Exists solely so this SDK's test suite can prove, today, that a byte-exact port of the
// bucketing recipe test-vectors/hashing.json documents produces identical results to the
// canonical golden vectors (envpit main repo's libs/shared/src/flag-evaluation-vectors.ts) — the
// cross-language parity proof SPEC-envpit-0t2z-3-1a-architecture.md §6 asks every language to
// establish ahead of the feature itself landing, mirroring the shipped Python SDK's
// _hashing.py, which exists for the identical reason.
//
// bucket = (first 4 bytes of SHA-256(UTF-8(salt + ":" + key)), read as a BIG-ENDIAN UNSIGNED
// 32-bit integer) mod 10000. No normalization of key — no trim, no case-fold, no Unicode
// normalization; raw UTF-8 bytes as given.
func bucket(key, salt string) int {
	digest := sha256.Sum256([]byte(salt + ":" + key))
	value := binary.BigEndian.Uint32(digest[:4])
	return int(value % 10000)
}
