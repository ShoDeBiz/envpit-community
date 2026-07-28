package envpit

import (
	"os"
	"sort"
)

// MergeIntoEnv writes this Client's CURRENTLY-LOADED snapshot into the process's real
// environment via os.Setenv — so code you already have that calls os.Getenv("DATABASE_URL")
// (the Go idiom; unlike Spring's @Value or Node's process.env there is no framework-level
// config convention to hook into instead, see the package doc / README "Framework
// integration" section) starts seeing EnvPit-managed values with ZERO changes to that code.
//
// # Boot-time snapshot, not a live view (owner directive, bd:envpit-yvyr concern #2)
//
// This call captures whatever Client.CacheInfo() would report RIGHT NOW and writes it once.
// It is never called for you automatically (Load/NewClient never touch os.Environ on their
// own) and it never re-runs itself — a later poll tick, SSE push, or reconnect catch-up that
// changes the in-memory snapshot does NOT reach back into os.Environ. This is not a
// limitation specific to this SDK: it is the same boot-time-resolved contract every other
// language's native mechanism already has (process.env is a plain object snapshot once
// Node's bootstrap assigns to it; a Spring @Value-injected field is resolved once at
// bean-construction time, unless you additionally opt into @RefreshScope). A process that
// needs live-updated values must keep reading through Client.Get*/Client.Changes(ctx)
// instead of os.Getenv for those specific keys.
//
// # Existing process.env values always win (owner directive, bd:envpit-yvyr concern #1a)
//
// By default MergeIntoEnv only fills GAPS: a key already present in os.Environ (checked via
// os.LookupEnv at call time, so an intentionally-empty-string override still counts as
// "present") is left completely untouched — MergeIntoEnv never clobbers a value your
// orchestrator, a `.env` loader, or a `docker run -e` flag already set. Pass WithOverride()
// to invert that and let EnvPit's values win instead.
//
// # Secrets are excluded by default (bd:envpit-durd unblocks bd:envpit-yvyr concern #1b)
//
// GET /api/v1/config now returns the `{values, secretKeys}` envelope (bd:envpit-durd,
// AC-SEC-E11) — secretKeys names every is_secret=true key, so this call CAN and DOES tell
// secrets apart today. The zero-option call is the SAFE one: a key named in the currently-
// loaded snapshot's secret-key set (Client.SecretKeys()) is never written unless the caller
// opts in via WithIncludeSecrets(). This inverts the pre-durd contract (documented in an
// earlier revision of this comment, now stale and removed per the lesson that an outlived
// assumption in a comment is itself a bug class this project tracks): before durd, the wire
// carried no per-key secret signal at all, so a bare MergeIntoEnv() call merged EVERY
// resolved value, secrets included, with no way to exclude them short of WithOnly/WithExclude.
//
// Per-key check order (test-vectors/env-merge.json's own documented order, asserted, not
// incidental):
//  1. A null value is absent — never written, never counted in ANY result list.
//  2. A secret-flagged key is skipped (SkippedSecrets) UNLESS WithIncludeSecrets() was passed.
//  3. A key already present in os.Environ is skipped (SkippedExisting) UNLESS WithOverride()
//     was passed.
//  4. Otherwise it is written (Merged).
//
// The secret check runs BEFORE the existing-key check: a secret that also happens to already
// be present in os.Environ is reported as SkippedSecrets, not SkippedExisting — reporting it
// as SkippedExisting would (incorrectly) tell the caller "set this yourself and EnvPit will
// stop skipping it," when in fact WithOverride() alone can never smuggle a secret through;
// WithIncludeSecrets() is required regardless of override.
//
// WithIncludeSecrets() writes decrypted secret values into the process environment, which is
// inherited by every child process, serialized whole by many APM/crash reporters, and
// readable at /proc/<pid>/environ on Linux. Naming it at the call site IS the acknowledgment
// — there is no second flag to pass.
//
// # WithOnly / WithExclude compose WITH the secret filter, never around it
//
// WithOnly(keys...) is an allowlist — merge ONLY the named keys, nothing else; WithExclude
// (keys...) is a denylist — merge everything EXCEPT the named keys. Both are evaluated as an
// ADDITIONAL, independent filter, checked before the null/secret/existing pipeline above: a
// key must survive WithOnly/WithExclude to even reach the secret check. This is a deliberate
// design choice (not incidental order): WithOnly listing a secret-flagged key's name does NOT
// pull it through — it still needs WithIncludeSecrets() to actually merge, exactly as if
// WithOnly had not been passed at all. There is no way to use WithOnly/WithExclude to bypass
// the secret filter; they can only ever narrow what WithIncludeSecrets()/the default excludes
// down to further. Covered by this SDK's own Go-local tests (env_test.go) — env-merge.json
// deliberately does not cover WithOnly/WithExclude at all (no Node/Java equivalent).
func (c *Client) MergeIntoEnv(opts ...MergeOption) MergeResult {
	cfg := &mergeConfig{}
	for _, opt := range opts {
		opt(cfg)
	}

	c.mu.RLock()
	snapshot := c.snapshot
	secretKeys := make(map[string]struct{}, len(c.secretKeys))
	for _, k := range c.secretKeys {
		secretKeys[k] = struct{}{}
	}
	c.mu.RUnlock()

	result := MergeResult{}
	for key, value := range snapshot {
		if cfg.only != nil {
			if _, allowed := cfg.only[key]; !allowed {
				continue
			}
		}
		if cfg.exclude != nil {
			if _, excluded := cfg.exclude[key]; excluded {
				continue
			}
		}

		if value == nil {
			// Unset cell (never written, or explicitly cleared) — readRaw's own
			// missing-vs-null equivalence: nothing to merge, and not an error either. Checked
			// first: a null secret carries no value to withhold, so it must never inflate
			// SkippedSecrets (test-vectors/env-merge.json's
			// "null-secret-value-is-absent-not-a-skipped-secret").
			continue
		}

		if _, isSecret := secretKeys[key]; isSecret && !cfg.includeSecrets {
			result.SkippedSecrets = append(result.SkippedSecrets, key)
			continue
		}

		if !cfg.override {
			if _, exists := os.LookupEnv(key); exists {
				result.SkippedExisting = append(result.SkippedExisting, key)
				continue
			}
		}

		if err := os.Setenv(key, *value); err != nil {
			// os.Setenv can fail (EINVAL on POSIX) for a key/value containing '=' or a NUL
			// byte — a real, reachable condition for a corrupted or binary secret value,
			// not a contrived one. Reported, never panicked, never silently dropped
			// (matches the SDK's existing "never swallow" posture — see
			// client.go's reportOrFallback for the equivalent pattern on GetIntOr/GetBoolOr).
			if result.Errors == nil {
				result.Errors = make(map[string]error)
			}
			result.Errors[key] = err
			continue
		}
		result.Merged = append(result.Merged, key)
	}

	sort.Strings(result.Merged)
	sort.Strings(result.SkippedExisting)
	sort.Strings(result.SkippedSecrets)
	return result
}

// MergeResult reports exactly what one MergeIntoEnv call did, for logging/observability —
// every field is sorted where order isn't otherwise meaningful, so two calls over the same
// input snapshot produce byte-identical output. Field names match the shared
// test-vectors/env-merge.json vocabulary (merged/skippedExisting/skippedSecrets) rather than
// this SDK's own pre-durd Set/Skipped naming, now that there are three distinct reasons a key
// can be skipped-or-not rather than one.
type MergeResult struct {
	// Merged lists the key names actually written into os.Environ by this call.
	Merged []string
	// SkippedExisting lists key names left untouched because os.Environ already had a value
	// for them and WithOverride() was not passed.
	SkippedExisting []string
	// SkippedSecrets lists key names excluded because the server flagged them is_secret=true
	// (Client.SecretKeys()) and WithIncludeSecrets() was not passed. Takes priority over
	// SkippedExisting: a secret that is ALSO already present in os.Environ is reported here,
	// never in SkippedExisting (see MergeIntoEnv's doc comment on check order).
	SkippedSecrets []string
	// Errors maps a key name to the os.Setenv error encountered while merging it (e.g. a
	// value containing a NUL byte). nil when every attempted key merged cleanly. A key that
	// appears here does NOT also appear in Merged.
	Errors map[string]error
}

// mergeConfig accumulates MergeOptions before MergeIntoEnv applies them. Unexported —
// callers only ever see the MergeOption functions themselves (mirrors clientConfig/Option in
// options.go).
type mergeConfig struct {
	override       bool
	includeSecrets bool
	only           map[string]struct{}
	exclude        map[string]struct{}
}

// MergeOption configures a single MergeIntoEnv call — the same functional-options idiom as
// NewClient's Option (options.go).
type MergeOption func(*mergeConfig)

// WithOverride lets EnvPit's value win over one already present in os.Environ. Without this
// option (the default), an existing process.env-style value always wins — MergeIntoEnv only
// fills gaps. Never smuggles a secret through on its own — WithIncludeSecrets() is still
// required regardless of WithOverride (see MergeIntoEnv's doc comment on check order).
func WithOverride() MergeOption {
	return func(c *mergeConfig) { c.override = true }
}

// WithIncludeSecrets opts a call into writing secret-flagged values (Client.SecretKeys()) into
// the real process environment — without it (the default, and the safe one), every key the
// server flagged is_secret=true is excluded regardless of WithOverride/WithOnly/WithExclude.
//
// Naming this option at the call site IS the acknowledgment of the exposure it accepts: the
// process environment is inherited by every child process the program spawns, is commonly
// captured whole by APM/crash-reporting agents on panic, and is readable by any process with
// the same UID via /proc/<pid>/environ on Linux. All three are strictly bigger exposure
// surfaces than this SDK's own in-memory cache, which nothing outside the process can read.
func WithIncludeSecrets() MergeOption {
	return func(c *mergeConfig) { c.includeSecrets = true }
}

// WithOnly restricts MergeIntoEnv to an explicit allowlist of key names — every other key in
// the snapshot is skipped, as if it were never fetched at all (silently — not counted in any
// MergeResult list, same as before WithIncludeSecrets existed). WithOnly does NOT bypass the
// secret filter: naming a secret-flagged key here still requires WithIncludeSecrets() to
// actually merge it (see MergeIntoEnv's doc comment). Calling WithOnly more than once, or with
// WithExclude, is additive/intersecting in the obvious way (a key must be in every WithOnly
// allowlist supplied and not in any WithExclude denylist to be merged).
func WithOnly(keys ...string) MergeOption {
	return func(c *mergeConfig) {
		allowed := make(map[string]struct{}, len(keys))
		for _, k := range keys {
			allowed[k] = struct{}{}
		}
		if c.only == nil {
			c.only = allowed
			return
		}
		// Intersect with any WithOnly allowlist(s) already supplied.
		for k := range c.only {
			if _, stillAllowed := allowed[k]; !stillAllowed {
				delete(c.only, k)
			}
		}
	}
}

// WithExclude denylists explicit key names from MergeIntoEnv — every other key merges
// normally (subject to the secret filter above). Prefer WithOnly when you can enumerate the
// keys you DO want (an allowlist fails safe when a new key is added to the environment later;
// a denylist does not).
func WithExclude(keys ...string) MergeOption {
	return func(c *mergeConfig) {
		if c.exclude == nil {
			c.exclude = make(map[string]struct{}, len(keys))
		}
		for _, k := range keys {
			c.exclude[k] = struct{}{}
		}
	}
}
