# CONFORMANCE.md

The master behavioral checklist every EnvPit SDK language must satisfy — normative, per
`outputs/SPEC-envpit-0t2z-3-1a-architecture.md` §1/§5.3 (main `envpit` repo). These are the
invariants that can't be expressed as static input/output data (that's `test-vectors/*.json`'s
job) — concurrency, lifecycle, and cross-cutting properties. **The shipped Node SDK is the
reference implementation**; every ID below cites the Node source that implements it and the Node
test(s) that assert it.

## Rule (per language, once a language starts implementation)

Every language's test suite MUST contain at least one test per `INV-SDK-N` ID below, with the ID
in the test's own name (e.g. `it('INV-SDK-5: ...')` / `func TestINV_SDK_5_...` /
`test_inv_sdk_5_...`). This is what makes a future CI job's ID-grep gate possible (Sara §5.3/§5.5
— not yet wired in this repo; tracked as a Slice-0 hand-off item, not built here). A language
"skipping" an invariant silently is exactly the failure mode this rule exists to make impossible.

## Node coverage legend

- **FULL** — a dedicated Vitest test asserts this invariant directly.
- **PARTIAL** — asserted as a side effect of other tests, or only one sub-case is directly tested.
- **GAP (documented)** — a real, negative/structural property not practical to assert with a
  positive Vitest test (e.g. "no disk I/O ever happens") — enforced by code review / a future
  grep-lint gate instead (Sentinel `THREATMODEL-envpit-0t2z-3.md` AC-SEC-SDK3-4), not a Slice-0
  blocker.

---

### INV-SDK-1 — `load()` is the only entry point; first-load failure is fatal; `load()` never fires `change`

**Statement:** There is no two-step construct-then-start API. `EnvpitClient.load(options)` (or
the language-idiomatic equivalent) either resolves with a fully-initialized, immediately-readable
client, or rejects/throws — there is no way to observe a half-initialized client. Resolving
`load()` itself never fires a `change` event, even if this is conceptually the "first" data.

**Node evidence:** `src/client.ts:99-103` (`static async load()`), `:295-297` (first-load failure
re-thrown, not swallowed).

**Node tests (FULL):**
- `test/vectors/error-mapping.vectors.test.ts` — every `AuthenticationError`/`NetworkError`
  first-load case rejects `load()` itself (no client object ever escapes).
- `test/realtime.test.ts:98` — "does NOT fire `change` on `load()` itself... (AC-U3)".

---

### INV-SDK-2 — every `get*()` after load is a synchronous, in-memory read; never a network call

**Statement:** Once `load()` has resolved, every typed getter call is synchronous (no
await/Promise in languages where that distinction exists) and never issues an HTTP request.

**Node evidence:** `src/client.ts:196-246` (`get`/`getString`/`getInt`/`getBoolean`/`readRaw` —
all read `this.snapshot`, never call `fetchConfig`).

**Node tests (FULL):** `test/vectors/getters.vectors.test.ts` (25 cases) — every getter call in
every case is a plain synchronous function call against an already-`fakeFetch`-loaded client;
`fakeFetch`'s single queued response (consumed once, at `load()`) would throw
`"no response configured"` if any getter triggered a second fetch.

---

### INV-SDK-3 — memory-only cache; never persisted to disk

**Statement:** The resolved config snapshot, and everything derived from it, lives only in
process memory. No SDK writes it (or any part of it) to a file, temp file, or any other
persistent store, under any code path including debug/diagnostic paths.

**Node evidence:** `src/client.ts:56` (`private snapshot: ConfigSnapshot | null`, plain field, no
serialization anywhere in `src/`) — the entire `src/` tree has zero `fs`/file-I/O imports.

**Node tests: GAP (documented).** A negative property ("no code path anywhere writes a file") is
not practically provable with a positive Vitest assertion. Enforced by
`outputs/THREATMODEL-envpit-0t2z-3.md` AC-SEC-SDK3-4's recommended no-file-write grep/lint gate
(not yet wired — no CI exists in this repo, Slice-0 hand-off) plus code review. Every future
language MUST re-verify this per its own filesystem-trap list (Sentinel §10.4 / F4: no
`shelve`/`pickle`/tempfile in Python, no `os.WriteFile`/`os.Create` in Go, no
`Files.write`/`FileOutputStream`/`File.createTempFile` in Java) and record an `INV-SDK-3`-named
test asserting its chosen HTTP client has no response-disk-cache enabled (Java: `java.net.http`
has none by construction, unlike `OkHttp` — a security-positive constraint already decided,
Sara §2.3).

---

### INV-SDK-4 — stale-while-revalidate: a refresh failure keeps the last good snapshot, recorded on cache-info, never thrown

**Statement:** After the first successful load, a background refresh that fails must NOT evict
the cache, throw, or propagate to any caller. The failure is recorded (`cacheInfo.lastError` or
equivalent) and the last good snapshot keeps serving reads.

**Node evidence:** `src/client.ts:284-304` (`refresh()`'s catch block — `isFirstLoad ||
this.snapshot === null` is the ONLY case that re-throws; every subsequent failure just records
`lastError` and logs a warn).

**Node tests (FULL):** `test/client.test.ts:43` — "keeps serving the last good snapshot when a
later refresh fails, and records the error on cacheInfo".

---

### INV-SDK-5 — generation guard: a superseded refresh outcome (success OR failure) is discarded, never applied

**Statement:** Every refresh claims a monotonically increasing generation number before its
request is issued. Its outcome is applied to client state only if its generation is still the
newest issued when the outcome arrives; a superseded outcome (even a *failure*) must not clobber
newer state, must not fire `change`/`error`, and must not touch `cacheInfo.lastError`.
(bd:envpit-1mvf — the failure-path half is the part a naive port forgets.)

**Node evidence:** `src/client.ts:72` (`refreshGeneration` field), `:248-305` (`refresh()` — the
generation check appears on BOTH the success path, `:264`, and the failure path, `:289`).

**Node tests (FULL) — the 3 adversarial cases, each an independently-verified sub-case:**
- `test/realtime-adversarial.test.ts:418` — out-of-order resolution (newer settles first).
- `test/realtime-adversarial.test.ts:481` — in-issue-order resolution (older settles first, still
  discarded — proves it's generation-based, not merely "last response wins").
- `test/realtime-adversarial.test.ts:530` — stale FAILURE after a newer success must not clobber
  `lastError` or fire a spurious `error` event.

---

### INV-SDK-6 — safe listener/consumer dispatch: user code can never crash the SDK/host, and never blocks other subscribers

**Statement:** A listener/callback/handler that throws (synchronously or, in languages with a
distinct async-rejection failure mode, asynchronously) must be caught, reported through the
injected logger (never rethrown to the SDK's own caller), and must never prevent any other
registered listener for the same or a different event from running. In languages where subscribe
is channel-based rather than callback-based (Go, per Sara §2.2/§3.2), the equivalent property is
structural: user code runs in the user's own goroutine, never the SDK's dispatch path.

**Node evidence:** `src/emitter.ts:44-61` (`SafeEmitter.emit()` — try/catch around the sync
invoke, plus an `isThenable` check + `.catch()` on the returned value for async listener
rejections, `:54-56`; bd:envpit-r59g fix).

**Node tests (FULL):**
- `test/realtime.test.ts:294` — sync-throwing listener, other listener still runs, logged.
- `test/realtime.test.ts:327` — async listener REJECTION does not become an unhandled promise
  rejection (regression test for bd:envpit-r59g, asserts against Node's own
  `process.on('unhandledRejection', ...)`).
- `test/realtime-adversarial.test.ts:146` — throwing `connection` listener, independently
  re-verified.
- `test/realtime-adversarial.test.ts:195` — throwing `error` listener doesn't block the failed
  refresh from being recorded.
- `test/realtime-adversarial.test.ts:219` — two throwing `change` listeners + one healthy one;
  healthy one always runs, order preserved, both throws logged.

---

### INV-SDK-7 — `change` payload is key NAMES only (sorted), null≡absent, no-op when nothing differs, snapshot applied before delivery

**Statement:** A `change` event's payload contains only the sorted list of key names that
differ — never values. A key absent from one snapshot and a key present-with-null in the other
are equivalent (no change). No event fires when a refetch finds nothing different. The new
snapshot is already the one `get*()` returns from INSIDE a listener invoked for that change (no
torn/inconsistent read).

**Node evidence:** `src/client.ts:266-283` (snapshot swap happens BEFORE `diffSnapshots`+`emit`),
`:312-321` (`diffSnapshots` — `?? null` equivalence, `.sort()`).

**Node tests (FULL):**
- `test/realtime.test.ts:55` — new value already readable INSIDE the `change` handler.
- `test/realtime.test.ts:98` — no event when a refetch finds nothing different.
- `test/realtime.test.ts:116` — `JSON.stringify(event)` never contains a config VALUE substring.
- `test/realtime-adversarial.test.ts:343` — byte-identical refetch content (different etag) does
  NOT fire `change`.
- `test/realtime-adversarial.test.ts:378` — a newly-materialized null-valued key does NOT fire
  `change` (null≡absent).
- `test/vectors/snapshot-diff.vectors.test.ts` (9 cases) — the pure diff algorithm, isolated from
  push/etag semantics, against `test-vectors/snapshot-diff.json`.

---

### INV-SDK-8 — realtime is an optimization; the poll timer is the correctness backstop; `pollIntervalMs 0` = no background refresh at all

**Statement:** Whatever the realtime/SSE channel's state (connected, degraded, unsupported), the
poll timer independently guarantees bounded staleness. Setting the poll interval to `0` (or the
language's equivalent "off" sentinel) disables ALL background refresh, including realtime — not
just polling.

**Node evidence:** `src/client.ts:88` (`refreshMode = pollIntervalMs > 0 ? 'polling' : 'off'`),
`:105-128` (`bootstrap()` — the realtime transport is only constructed inside the
`pollIntervalMs > 0` branch).

**Node tests (FULL):**
- `test/realtime.test.ts:149` — a change delivered via poll-only (realtime never available)
  carries the identical shape to one delivered via push.
- `test/realtime.test.ts:455` — `pollIntervalMs: 0` reports `cacheInfo.refreshMode === 'off'`.
- `test/realtime-adversarial.test.ts:584` — while realtime is degraded, the poll timer alone
  still delivers a real `change` event.

---

### INV-SDK-9 — etag dedup on push; catch-up refetch on every reconnect except the first post-load connect

**Statement:** A `config-changed` push whose etag already matches the client's current etag must
not trigger a refetch (dedup). A realtime (re)connect triggers a catch-up refresh EXCEPT the very
first realtime connect immediately after `load()` (that data is already fresh — firing there
would be a wasted duplicate of the bootstrap fetch).

**Node evidence:** `src/client.ts:130-135` (`handlePushSignal` — the `pushedEtag === this.etag`
early return), `:137-152` (`handleConnectionModeChange` — `sawFirstRealtimeConnect` gate).

**Node tests:**
- **FULL (catch-up-on-reconnect):** `test/realtime.test.ts:417` — reconnecting after a genuinely
  degraded episode triggers a catch-up refresh with `trigger: 'reconnect'`.
- **FULL (etag dedup):** `test/conformance.test.ts:32` — `INV-SDK-9` — new in Slice 0 (this exact
  case had no prior dedicated test; added while writing this document).

---

### INV-SDK-10 — quiet-retry/degraded diagnostics cadence: one silent retry, one info on degrade, one warn at 5 min, one info on restore — never per-attempt noise

**Statement:** A single disconnect gets exactly one silent, immediate retry before any log line
or `connection` event fires. If still failing, exactly one `info` line + one `connection` event
announces degraded mode. If still degraded after 5 minutes, exactly one `warn` line (not
repeated). Recovery logs exactly one `info` line. No log line or event fires per individual retry
attempt.

**Node evidence:** `src/realtime-transport.ts:229-283` (`onFailure`/`declareDegraded`/
`scheduleWarnTimer` — each guarded by a "this episode" boolean so it fires at most once).

**Node tests (FULL):**
- `test/realtime.test.ts:174` — severed stream: exactly one `info`, zero `warn` before 5 min.
- `test/realtime.test.ts:223` — exactly one `warn` after the 5-minute threshold.
- `test/realtime.test.ts:256` — a routine server-initiated rotation (AC-U6) logs only at
  `debug`, never flips mode, never fires a `connection` event (the "quiet" half of this
  invariant — an expected disconnect must not be noisy either).

---

### INV-SDK-11 — no config value and no API key ever appears in any error message or log line; background work never keeps the host process alive

**Statement:** No thrown error, no log line, and no default string representation of a
client/options object ever contains a config VALUE or the API key. Background timers/threads
must not prevent the host process from exiting when it otherwise would.

**Node evidence:** `src/client.ts:113` (`this.timer.unref?.()`),
`src/realtime-transport.ts:235,281,288` (all retry/warn timers `.unref()`'d).

**Node tests:**
- **FULL (API key never in a thrown error message):** `test/conformance.test.ts:81` —
  `INV-SDK-11` — new in Slice 0, sweeps `AuthenticationError`/`NetworkError`/`MissingKeyError`/
  `TypeMismatchError` messages for the injected API key substring.
- **PARTIAL (config value never in a `change` payload):** `test/realtime.test.ts:116` — covers
  the `change` event specifically, not every log line.
- **GAP (documented) — one KNOWN, ACCEPTED exception:** `src/errors.ts:57`
  (`TypeMismatchError`'s message echoes the raw offending value: `` `...(got "${rawValue}")` ``).
  Flagged and accepted by Sentinel (`outputs/THREATMODEL-envpit-0t2z-3.md` F6): shipped Node wins
  per ADR-S3-01, values reaching typed getters are overwhelmingly non-secret ports/flags, and the
  echo has real debugging value. **New surfaces introduced by future languages must NOT repeat
  this pattern outside this one documented carve-out** — e.g. the Go `Or`-family's log line
  (Sara §2.2 draft) must omit the value entirely (AC-SEC-SDK3-6), which is exactly why this
  invariant has a documented exception rather than a silent one.
- **GAP (documented) — `.unref()`/daemon-thread non-blocking behavior:** not directly asserted by
  any test (the test suite's own clean exit is indirect evidence, not a positive assertion).
  Each language's future implementation should add its own `INV-SDK-11`-tagged test proving a
  loaded, still-polling client does not prevent process exit (Node: assert `timer.unref` was
  called via a spy, or run a genuine subprocess exit-code check).

---

### INV-SDK-12 — `ENVPIT_API_KEY` auto-detect, explicit option wins; auth header is `X-Api-Key`, never `Authorization`

**Statement:** If no API key is explicitly supplied, the SDK reads it from the `ENVPIT_API_KEY`
environment variable. An explicitly-passed key always wins over the environment variable. Every
authenticated request (config fetch AND realtime connect) sends the key via an `X-Api-Key`
header — never `Authorization` (ADR-M5-03: API keys are a separate trust boundary from session
auth).

**Node evidence:** `src/client.ts:75-80` (constructor — `options.apiKey ?? process.env[...]`),
`src/transport.ts:50` (`'X-Api-Key': apiKey`), `src/realtime-transport.ts:130` (same header on
the SSE connect).

**Node tests:**
- **FULL (env-var auto-detect + explicit-option-wins):** `test/client.test.ts:17` — "apiKey
  resolution" describe block (both directions: missing key rejects; env var alone succeeds).
- **FULL (header name, not `Authorization`):** `test/conformance.test.ts:65` — `INV-SDK-12` —
  new in Slice 0, asserts the literal `x-api-key` header value and the absence of an
  `authorization` header on the config fetch.

---

## Summary — Node coverage by invariant

| ID | Statement (short) | Node coverage |
|---|---|---|
| INV-SDK-1 | `load()` sole entry point, fatal-first-load, no boot `change` | FULL |
| INV-SDK-2 | `get*()` synchronous, never a network call | FULL |
| INV-SDK-3 | memory-only, never persisted to disk | GAP (documented — grep-gate, not Vitest) |
| INV-SDK-4 | stale-while-revalidate on refresh failure | FULL |
| INV-SDK-5 | generation guard (success + failure paths) | FULL |
| INV-SDK-6 | safe listener dispatch, never crashes host | FULL |
| INV-SDK-7 | `change` = key names only, null≡absent, no-op, consistent read | FULL |
| INV-SDK-8 | poll is the correctness backstop; `0` = fully off | FULL |
| INV-SDK-9 | etag dedup on push; reconnect catch-up (not on first connect) | FULL |
| INV-SDK-10 | quiet-retry/degraded diagnostics cadence | FULL |
| INV-SDK-11 | no value/API-key in errors/logs; non-blocking background work | PARTIAL (one documented carve-out + one unasserted sub-case) |
| INV-SDK-12 | env-var auto-detect, explicit wins, `X-Api-Key` header | FULL |
