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

## Families (suiteVersion 1.0.0)

| File | What it tests | Consumed by Node today? |
|---|---|---|
| `sse-frames.json` | `SseFrameParser` input chunking -> output frames | Yes — `sdks/node/test/vectors/sse-frames.vectors.test.ts` |
| `push-payloads.json` | SSE `config-changed`/unknown-event frame -> refetch or ignore | Yes — `sdks/node/test/vectors/push-payloads.vectors.test.ts` |
| `getters.json` | Typed getter (`get`/`getInt`/`getBoolean`) value/default/error behavior | Yes — `sdks/node/test/vectors/getters.vectors.test.ts` |
| `snapshot-diff.json` | Before/after snapshot -> sorted changed key names | Yes — `sdks/node/test/vectors/snapshot-diff.vectors.test.ts` |
| `error-mapping.json` | HTTP status / transport condition -> SDK error type | Yes — `sdks/node/test/vectors/error-mapping.vectors.test.ts` |
| `hashing.json` | SHA-256 rollout-bucketing determinism | **Not yet** — forward provision for bd:envpit-0t2z.6 (Feature Flags SDK support); no shipped SDK language buckets anything today. Reserved now so Python/Go/Java prove identical bucketing against the exact ground truth (`envpit` main repo's `libs/shared/src/flag-evaluation-vectors.ts`) from day one. |

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
