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
// # Secrets are NOT filtered by this call today — read before enabling in production
//
// bd:envpit-yvyr's owner directive was "ordinary config merges by default; anything
// flagged isSecret is EXCLUDED unless the caller opts in, loudly". That cannot be
// implemented today: GET /api/v1/config (the only endpoint this SDK's transport layer ever
// calls — fetchConfig in transport.go) returns a FLAT `{key: value}` map with every
// is_secret=true cell already decrypted server-side and mixed in indistinguishably from
// plain config (apps/api/src/config-management/config.service.ts,
// resolveEnvironmentSecretsInternal — the row's own `isSecret` flag is read and then
// discarded, never serialized into the response). This is true of every shipped SDK
// language, not a Go-specific gap, and confirmed against the frozen cross-language
// test-vector ground truth (test-vectors/snapshot-diff.json: "ConfigSnapshot maps
// (Record<string, string|null>)" — no secret flag in the shape at all).
//
// Consequence: MergeIntoEnv() with no options merges EVERY currently-resolved key,
// including decrypted secrets, into the real process environment — which is inherited by
// every child process, readable at /proc/<pid>/environ, and commonly serialized whole by
// crash reporters/APM agents on panic. Do not call it bare in a process that holds
// EnvPit-managed secrets unless you have accepted that exposure.
//
// THE FILTER SEAM (for when the server starts sending an isSecret flag, or for callers who
// already know their own schema): WithOnly(keys...) is an allowlist — merge ONLY the named
// keys, nothing else, regardless of what else is in the snapshot; WithExclude(keys...) is a
// denylist — merge everything EXCEPT the named keys. Both are plain key-NAME predicates
// evaluated in mergeConfig below; NO heuristic is applied to the key name itself (an
// owner-corrected requirement — "DATABASE_URL" carrying an embedded password does not
// match any *_SECRET-shaped naming convention, so guessing by name is explicitly rejected,
// not just unimplemented). The day the wire protocol adds a per-key secret flag to
// ConfigSnapshot, the natural next step is a THIRD predicate option (e.g.
// WithExcludeSecrets()) built on that flag — this file is deliberately structured so that
// only readSnapshotForMerge below needs to change to read the new flag; the gap-fill/
// override/Only/Exclude logic in MergeIntoEnv itself does not.
func (c *Client) MergeIntoEnv(opts ...MergeOption) MergeResult {
	cfg := &mergeConfig{}
	for _, opt := range opts {
		opt(cfg)
	}

	c.mu.RLock()
	snapshot := c.snapshot
	c.mu.RUnlock()

	result := MergeResult{}
	for key, value := range snapshot {
		if value == nil {
			// Unset cell (never written, or explicitly cleared) — readRaw's own
			// missing-vs-null equivalence: nothing to merge, and not an error either.
			continue
		}
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
		if !cfg.override {
			if _, exists := os.LookupEnv(key); exists {
				result.Skipped = append(result.Skipped, key)
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
		result.Set = append(result.Set, key)
	}

	sort.Strings(result.Set)
	sort.Strings(result.Skipped)
	return result
}

// MergeResult reports exactly what one MergeIntoEnv call did, for logging/observability —
// every field is sorted where order isn't otherwise meaningful, so two calls over the same
// input snapshot produce byte-identical output.
type MergeResult struct {
	// Set lists the key names actually written into os.Environ by this call.
	Set []string
	// Skipped lists key names left untouched because os.Environ already had a value for
	// them and WithOverride() was not passed.
	Skipped []string
	// Errors maps a key name to the os.Setenv error encountered while merging it (e.g. a
	// value containing a NUL byte). nil when every attempted key merged cleanly. A key that
	// appears here does NOT also appear in Set.
	Errors map[string]error
}

// mergeConfig accumulates MergeOptions before MergeIntoEnv applies them. Unexported —
// callers only ever see the MergeOption functions themselves (mirrors clientConfig/Option in
// options.go).
type mergeConfig struct {
	override bool
	only     map[string]struct{}
	exclude  map[string]struct{}
}

// MergeOption configures a single MergeIntoEnv call — the same functional-options idiom as
// NewClient's Option (options.go).
type MergeOption func(*mergeConfig)

// WithOverride lets EnvPit's value win over one already present in os.Environ. Without this
// option (the default), an existing process.env-style value always wins — MergeIntoEnv only
// fills gaps.
func WithOverride() MergeOption {
	return func(c *mergeConfig) { c.override = true }
}

// WithOnly restricts MergeIntoEnv to an explicit allowlist of key names — every other key in
// the snapshot is skipped, as if it were never fetched at all. This is the SAFEST way to
// call MergeIntoEnv in a process that also holds EnvPit-managed secrets: list only the
// non-secret keys you actually want in os.Environ (see MergeIntoEnv's doc comment on why the
// SDK cannot make this choice for you today). Calling WithOnly more than once, or with
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
// normally. Prefer WithOnly when you can enumerate the keys you DO want (an allowlist fails
// safe when a new key is added to the environment later; a denylist does not).
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
