# test-vectors/

Language-agnostic JSON fixture suite — the SAME data every EnvPit SDK's test suite loads and
asserts against, so "Python/Go/Java behave like Node" is provable by a shared file diff, not by
re-reading four separate implementations and hoping they agree.

> bd:envpit-0t2z.3 Slice 0 (blocking prerequisite, R1 per
> `outputs/SPEC-envpit-0t2z-3-1a-architecture.md` §5/§9): this directory did not exist before
> Slice 0 landed. Node's proven-shipped behavior (4 Vitest files with inline fixtures) is the
> ground truth every vector below was extracted from and cross-checked against — see each file's
> own `description`/`sourceOfTruth` field, and `suite.json`'s `sourceOfTruth` map.

## Format

Every family is one JSON file: an object with a human-readable `description`, and either a
`cases` array (data vectors) or algorithm-specific fields (`hashing.json`). Each case has a
`name` (kebab-case, used verbatim or slugified in every language's generated test name) plus
whatever inputs/expectations that family needs — see each file for its exact shape; there is no
single generic case schema across families because the families test structurally different
things (parser input/output, HTTP-condition/error-type mapping, etc.).

## Families (suiteVersion 1.2.0)

| File | What it tests | Consumed by Node today? | Consumed by Python today? |
|---|---|---|---|
| `sse-frames.json` | `SseFrameParser` input chunking -> output frames | Yes — `sdks/node/test/vectors/sse-frames.vectors.test.ts` | Yes — `sdks/python/tests/test_sse_frames_vectors.py` |
| `push-payloads.json` | SSE `config-changed`/unknown-event frame -> refetch or ignore | Yes — `sdks/node/test/vectors/push-payloads.vectors.test.ts` | Yes — `sdks/python/tests/test_push_payloads_vectors.py` |
| `getters.json` | Typed getter (`get`/`getInt`/`getBoolean`) value/default/error behavior | Yes — `sdks/node/test/vectors/getters.vectors.test.ts` | Yes — `sdks/python/tests/test_getters_vectors.py` |
| `snapshot-diff.json` | Before/after snapshot -> sorted changed key names | Yes — `sdks/node/test/vectors/snapshot-diff.vectors.test.ts` | Yes — `sdks/python/tests/test_snapshot_diff_vectors.py` |
| `error-mapping.json` | HTTP status / transport condition -> SDK error type | Yes — `sdks/node/test/vectors/error-mapping.vectors.test.ts` | Yes — `sdks/python/tests/test_error_mapping_vectors.py` |
| `hashing.json` | SHA-256 rollout-bucketing determinism | **Not yet** — forward provision for bd:envpit-0t2z.6 (Feature Flags SDK support); no shipped SDK language buckets anything today. Reserved now so Python/Go/Java prove identical bucketing against the exact ground truth (`envpit` main repo's `libs/shared/src/flag-evaluation-vectors.ts`) from day one. | Yes — `sdks/python/tests/test_hashing_vectors.py` |
| `error-messages.json` | Per-language MESSAGE TEXT/SHAPE for the 4-class error taxonomy (Uma DX spec flag #6) — a different concern from `error-mapping.json` (type only, not text) | Yes — `sdks/node/test/vectors/error-messages.vectors.test.ts` | Yes — `sdks/python/tests/test_error_messages_vectors.py` |
| `adversarial-payloads.json` | Malformed/oversized/deeply-nested JSON body + SSE line vectors (Sentinel AC-SEC-SDK3-2) — parser must never crash/hang/OOM | Partial — `sdks/node/test/vectors/adversarial-payloads.vectors.test.ts` consumes every case; 2 of 8 are documented GAP-canary assertions (Node has no body/SSE-line byte cap yet, tracked bd:envpit-aw7l) rather than hard pass/fail | Yes, fully — `sdks/python/tests/test_adversarial_payloads_vectors.py` (Python implements both caps for real) |
| `resolve-body.json` | Config-resolve 200 body -> unwrapped `{values, secretKeys}`, or rejection (bd:envpit-durd) | Yes — `sdks/node/test/vectors/resolve-body.vectors.test.ts` | Yes — `sdks/python/tests/test_resolve_body_vectors.py` |
| `env-merge.json` | Snapshot + existing env + options -> `{merged, skippedExisting, skippedSecrets}` (bd:envpit-yvyr) | Yes — `sdks/node/test/vectors/env-merge.vectors.test.ts` | Yes — `sdks/python/tests/test_env_merge_vectors.py` |

The two-column table above predates the Go and Java SDKs and is kept as-is rather than rewritten;
both new families are consumed by all FOUR languages, every case, no skips —
`sdks/go/envpit/vectors_test.go` (`TestVectorsResolveBody`, `TestVectorsEnvMerge`) and
`sdks/java/src/test/java/com/envpit/{VectorsResolveBodyTest,VectorsEnvMergeTest}.java` alongside
the Node/Python files listed.

### What changed in 1.2.0

`resolve-body.json` and `env-merge.json` are the first families whose ground truth is the SERVER
contract rather than Node's shipped behavior: when they were written, all four SDKs were still
parsing the pre-durd bare `{key: value}` map, so these files are a spec the SDKs had to be brought
UP to, not an extraction of what already worked.

`adversarial-payloads.json` was also amended: its `payloadRecipe` built a bare `{"K": pad}` map,
which the strict envelope turns into the rejected legacy shape — making its one "accept"
body-size-cap case unsatisfiable by any conforming client. Each language had independently patched
its own local helper to keep that case green, which is exactly the silent per-language divergence
this directory exists to prevent, so the recipe was corrected here instead (see that file's own
`description` for the full note).

`error-messages.json` and `adversarial-payloads.json` were backfilled after Slice 0 (bd:envpit-0t2z.3):
both were referenced in the design docs / Sentinel's threat model but did not actually land with
the original 6 families — flagged honestly by the Python implementation dispatch rather than
silently worked around with a Python-only bespoke copy of a "shared" format (see each file's own
`notes` field for what was superseded and what Python-specific coverage was deliberately kept, per
§3 below).

Not every existing Node inline test was moved here — only the vector-shaped, pure-data families.
Concurrency/lifecycle behavior (generation-guard, safe-listener dispatch, quiet-retry cadence,
etc.) genuinely isn't expressible as static input/output data; that's `CONFORMANCE.md`'s job
(normative checklist, INV-SDK-1..12), not this directory's.

## Versioning — frozen per `suiteVersion`

`suite.json`'s `suiteVersion` is the suite's own semver. **A vector file only changes as part of
a PR that updates every shipped SDK's suite together** (SPEC-envpit-0t2z-3-1a-architecture.md
§5.2) — no language silently drifts ahead of or behind what the others assert. Each SDK's test
suite should record (in its own README or CI config) which `suiteVersion` it currently passes.

## Adding a language

1. Write a tiny JSON-file loader in your language's test-only code (no runtime dependency —
   these files are never read by the shipped SDK itself, only by its tests).
2. One parameterized test per file's `cases` array, each case's `name` reflected in the
   generated test's own name (enables the future CONFORMANCE-ID + vector-coverage CI gate,
   Sara §5.3/§5.5 — not yet wired for this repo, tracked as a follow-up per Slice 0's hand-off).
3. Do not invent new cases in your language's copy of a shared file — if a case is missing,
   add it here first (touching every language in the same PR), matching real Node ground truth.

## `hashing.json` — not yet a build-gating family

Every other file above is consumed by Node's existing test suite as of Slice 0 (proof the
vectors encode real shipped behavior, not aspirational prose). `hashing.json` is the one
exception: it's included now (task explicitly calls it out, ahead of the other five) because the
bucketing recipe under-specifies badly in prose (byte-slicing/endianness is exactly where four
languages would silently diverge — SPEC-envpit-0t2z-3-1a-architecture.md §6), but no SDK language
implements bucketing yet. It becomes build-gating the moment bd:envpit-0t2z.6 (Feature Flags SDK
support) starts.
