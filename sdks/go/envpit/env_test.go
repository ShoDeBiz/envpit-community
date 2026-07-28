package envpit

import (
	"context"
	"fmt"
	"os"
	"sort"
	"testing"
)

// ---- test helpers -----------------------------------------------------------------------

func containsStr(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

// envKeyCounter namespaces every merge-test's env var key to its own test run so parallel/CI
// runs never collide with a real ambient environment variable or with each other.
var envKeyCounter int

// ---- MergeIntoEnv: gap-fill (default, no override) --------------------------------------

func TestMergeIntoEnvWritesNewKeyNotAlreadyInProcessEnv(t *testing.T) {
	envKeyCounter++
	key := fmt.Sprintf("ENVPIT_MERGE_TEST_NEW_%d", envKeyCounter)
	t.Cleanup(func() { os.Unsetenv(key) })
	os.Unsetenv(key) // ensure absent

	client := newLoadedClient(t, fmt.Sprintf(`{%q:"from-envpit"}`, key))

	result := client.MergeIntoEnv()

	got, ok := os.LookupEnv(key)
	if !ok || got != "from-envpit" {
		t.Fatalf("os.LookupEnv(%s) = (%q, %v), want (\"from-envpit\", true)", key, got, ok)
	}
	if !containsStr(result.Merged, key) {
		t.Fatalf("result.Merged = %v, want it to contain %s", result.Merged, key)
	}
	if containsStr(result.SkippedExisting, key) {
		t.Fatalf("result.SkippedExisting = %v, should NOT contain %s (it was newly set)", result.SkippedExisting, key)
	}
}

func TestMergeIntoEnvDoesNotOverrideExistingProcessEnvByDefault(t *testing.T) {
	envKeyCounter++
	key := fmt.Sprintf("ENVPIT_MERGE_TEST_EXIST_%d", envKeyCounter)
	t.Cleanup(func() { os.Unsetenv(key) })
	if err := os.Setenv(key, "already-here"); err != nil {
		t.Fatalf("test setup Setenv failed: %v", err)
	}

	client := newLoadedClient(t, fmt.Sprintf(`{%q:"from-envpit"}`, key))

	result := client.MergeIntoEnv() // no WithOverride()

	got := os.Getenv(key)
	if got != "already-here" {
		t.Fatalf("os.Getenv(%s) = %q, want %q (existing process env must win by default)", key, got, "already-here")
	}
	if !containsStr(result.SkippedExisting, key) {
		t.Fatalf("result.SkippedExisting = %v, want it to contain %s", result.SkippedExisting, key)
	}
	if containsStr(result.Merged, key) {
		t.Fatalf("result.Merged = %v, should NOT contain %s (it was skipped, not merged)", result.Merged, key)
	}
}

func TestMergeIntoEnvWithOverrideOverwritesExistingProcessEnv(t *testing.T) {
	envKeyCounter++
	key := fmt.Sprintf("ENVPIT_MERGE_TEST_OVERRIDE_%d", envKeyCounter)
	t.Cleanup(func() { os.Unsetenv(key) })
	if err := os.Setenv(key, "already-here"); err != nil {
		t.Fatalf("test setup Setenv failed: %v", err)
	}

	client := newLoadedClient(t, fmt.Sprintf(`{%q:"from-envpit"}`, key))

	result := client.MergeIntoEnv(WithOverride())

	got := os.Getenv(key)
	if got != "from-envpit" {
		t.Fatalf("os.Getenv(%s) = %q, want %q (WithOverride must let EnvPit win)", key, got, "from-envpit")
	}
	if !containsStr(result.Merged, key) {
		t.Fatalf("result.Merged = %v, want it to contain %s", result.Merged, key)
	}
}

// ---- MergeIntoEnv: secrets excluded by default (bd:envpit-durd) --------------------------
//
// The shared cross-language behavior (secrets excluded unless WithIncludeSecrets, secret check
// before existing check, etc.) is covered by TestVectorsEnvMerge (vectors_test.go) against
// test-vectors/env-merge.json. This section covers Go-local surface the shared vectors
// deliberately don't (WithOnly/WithExclude interaction — no Node/Java equivalent) plus
// SecretKeys() itself.

// newLoadedClientWithSecrets builds a client the same way newLoadedClient does, then directly
// installs a secret-key set on it (same-package access) — the shared vector suite doesn't cover
// WithOnly/WithExclude, so tests exercising that interaction need their own way to mark keys
// secret without duplicating a real server-shaped envelope by hand for every case.
func newLoadedClientWithSecrets(t *testing.T, valuesJSON string, secretKeys ...string) *Client {
	t.Helper()
	client := newLoadedClient(t, valuesJSON)
	client.mu.Lock()
	client.secretKeys = secretKeys
	client.mu.Unlock()
	return client
}

func TestMergeIntoEnvWithOnlyCannotPullASecretThroughWithoutIncludeSecrets(t *testing.T) {
	envKeyCounter++
	pub := fmt.Sprintf("ENVPIT_MERGE_TEST_ONLYSEC_PUB_%d", envKeyCounter)
	sec := fmt.Sprintf("ENVPIT_MERGE_TEST_ONLYSEC_SEC_%d", envKeyCounter)
	t.Cleanup(func() { os.Unsetenv(pub); os.Unsetenv(sec) })
	os.Unsetenv(pub)
	os.Unsetenv(sec)

	client := newLoadedClientWithSecrets(t,
		fmt.Sprintf(`{%q:"public-value",%q:"secret-value"}`, pub, sec), sec)

	// Naming the secret explicitly in WithOnly must NOT pull it through — WithIncludeSecrets()
	// is still required regardless of what WithOnly allowlists.
	result := client.MergeIntoEnv(WithOnly(pub, sec))

	if got := os.Getenv(pub); got != "public-value" {
		t.Fatalf("os.Getenv(%s) = %q, want %q", pub, got, "public-value")
	}
	if _, ok := os.LookupEnv(sec); ok {
		t.Fatalf("os.LookupEnv(%s) found a value — WithOnly naming a secret must not merge it without WithIncludeSecrets()", sec)
	}
	if !containsStr(result.Merged, pub) || containsStr(result.Merged, sec) {
		t.Fatalf("result.Merged = %v, want exactly [%s]", result.Merged, pub)
	}
	if !containsStr(result.SkippedSecrets, sec) {
		t.Fatalf("result.SkippedSecrets = %v, want it to contain %s", result.SkippedSecrets, sec)
	}
}

func TestMergeIntoEnvWithOnlyPlusIncludeSecretsMergesAnAllowlistedSecret(t *testing.T) {
	envKeyCounter++
	sec := fmt.Sprintf("ENVPIT_MERGE_TEST_ONLYSEC2_%d", envKeyCounter)
	t.Cleanup(func() { os.Unsetenv(sec) })
	os.Unsetenv(sec)

	client := newLoadedClientWithSecrets(t, fmt.Sprintf(`{%q:"secret-value"}`, sec), sec)

	result := client.MergeIntoEnv(WithOnly(sec), WithIncludeSecrets())

	if got := os.Getenv(sec); got != "secret-value" {
		t.Fatalf("os.Getenv(%s) = %q, want %q (WithOnly + WithIncludeSecrets together must merge it)", sec, got, "secret-value")
	}
	if !containsStr(result.Merged, sec) {
		t.Fatalf("result.Merged = %v, want it to contain %s", result.Merged, sec)
	}
}

func TestMergeIntoEnvWithExcludeStillObeysTheSecretFilterForNonExcludedKeys(t *testing.T) {
	envKeyCounter++
	pub := fmt.Sprintf("ENVPIT_MERGE_TEST_EXCLSEC_PUB_%d", envKeyCounter)
	sec := fmt.Sprintf("ENVPIT_MERGE_TEST_EXCLSEC_SEC_%d", envKeyCounter)
	other := fmt.Sprintf("ENVPIT_MERGE_TEST_EXCLSEC_OTHER_%d", envKeyCounter)
	t.Cleanup(func() { os.Unsetenv(pub); os.Unsetenv(sec); os.Unsetenv(other) })
	os.Unsetenv(pub)
	os.Unsetenv(sec)
	os.Unsetenv(other)

	client := newLoadedClientWithSecrets(t,
		fmt.Sprintf(`{%q:"public-value",%q:"secret-value",%q:"other-value"}`, pub, sec, other), sec)

	// Excluding an unrelated key must not change the secret filter's outcome for `sec`.
	result := client.MergeIntoEnv(WithExclude(other))

	if got := os.Getenv(pub); got != "public-value" {
		t.Fatalf("os.Getenv(%s) = %q, want %q", pub, got, "public-value")
	}
	if _, ok := os.LookupEnv(sec); ok {
		t.Fatalf("os.LookupEnv(%s) found a value — the secret filter must still apply under WithExclude", sec)
	}
	if _, ok := os.LookupEnv(other); ok {
		t.Fatalf("os.LookupEnv(%s) found a value — WithExclude must still skip denylisted keys", other)
	}
	if !containsStr(result.Merged, pub) {
		t.Fatalf("result.Merged = %v, want it to contain %s", result.Merged, pub)
	}
	if !containsStr(result.SkippedSecrets, sec) {
		t.Fatalf("result.SkippedSecrets = %v, want it to contain %s", result.SkippedSecrets, sec)
	}
}

func TestClientSecretKeysReturnsASortedCopySafeToLogAndDoesNotAliasInternalState(t *testing.T) {
	client := newLoadedClientWithSecrets(t, `{"A":"1","B":"2"}`, "B", "A")

	got := client.SecretKeys()
	want := []string{"A", "B"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("SecretKeys() = %v, want %v (sorted)", got, want)
	}

	// Mutating the returned slice must not corrupt the client's own state (it's a copy).
	got[0] = "MUTATED"
	again := client.SecretKeys()
	if again[0] != "A" {
		t.Fatalf("SecretKeys() returned an aliased slice — second call = %v, want [A B] unaffected by the first call's mutation", again)
	}
}

func TestClientSecretKeysIsEmptyNotNilWhenNothingIsSecret(t *testing.T) {
	client := newLoadedClient(t, `{"A":"1"}`)
	got := client.SecretKeys()
	if got == nil {
		t.Fatal("SecretKeys() = nil, want an empty (non-nil) slice when nothing is secret")
	}
	if len(got) != 0 {
		t.Fatalf("SecretKeys() = %v, want empty", got)
	}
}

// ---- MergeIntoEnv: WithOnly / WithExclude allowlist/denylist (non-secret keys) ------------

func TestMergeIntoEnvWithOnlyMergesAllowlistedKeysOnly(t *testing.T) {
	envKeyCounter++
	pub := fmt.Sprintf("ENVPIT_MERGE_TEST_PUB_%d", envKeyCounter)
	other := fmt.Sprintf("ENVPIT_MERGE_TEST_OTHER_%d", envKeyCounter)
	t.Cleanup(func() { os.Unsetenv(pub); os.Unsetenv(other) })
	os.Unsetenv(pub)
	os.Unsetenv(other)

	client := newLoadedClient(t, fmt.Sprintf(`{%q:"public-value",%q:"other-value"}`, pub, other))

	result := client.MergeIntoEnv(WithOnly(pub))

	if got := os.Getenv(pub); got != "public-value" {
		t.Fatalf("os.Getenv(%s) = %q, want %q", pub, got, "public-value")
	}
	if _, ok := os.LookupEnv(other); ok {
		t.Fatalf("os.LookupEnv(%s) found a value — WithOnly must exclude keys not in the allowlist", other)
	}
	if !containsStr(result.Merged, pub) || containsStr(result.Merged, other) {
		t.Fatalf("result.Merged = %v, want exactly [%s]", result.Merged, pub)
	}
}

func TestMergeIntoEnvWithExcludeSkipsDenylistedKeys(t *testing.T) {
	envKeyCounter++
	pub := fmt.Sprintf("ENVPIT_MERGE_TEST_PUB2_%d", envKeyCounter)
	other := fmt.Sprintf("ENVPIT_MERGE_TEST_OTHER2_%d", envKeyCounter)
	t.Cleanup(func() { os.Unsetenv(pub); os.Unsetenv(other) })
	os.Unsetenv(pub)
	os.Unsetenv(other)

	client := newLoadedClient(t, fmt.Sprintf(`{%q:"public-value",%q:"other-value"}`, pub, other))

	result := client.MergeIntoEnv(WithExclude(other))

	if got := os.Getenv(pub); got != "public-value" {
		t.Fatalf("os.Getenv(%s) = %q, want %q", pub, got, "public-value")
	}
	if _, ok := os.LookupEnv(other); ok {
		t.Fatalf("os.LookupEnv(%s) found a value — WithExclude must skip denylisted keys", other)
	}
	if !containsStr(result.Merged, pub) || containsStr(result.Merged, other) {
		t.Fatalf("result.Merged = %v, want exactly [%s]", result.Merged, pub)
	}
}

func TestMergeIntoEnvSkipsUnsetNilValuedKeys(t *testing.T) {
	envKeyCounter++
	nullKey := fmt.Sprintf("ENVPIT_MERGE_TEST_NULL_%d", envKeyCounter)
	t.Cleanup(func() { os.Unsetenv(nullKey) })
	os.Unsetenv(nullKey)

	client := newLoadedClient(t, fmt.Sprintf(`{%q:null}`, nullKey))

	result := client.MergeIntoEnv()

	if _, ok := os.LookupEnv(nullKey); ok {
		t.Fatalf("os.LookupEnv(%s) found a value — a null/unset cell must never be written", nullKey)
	}
	if containsStr(result.Merged, nullKey) || containsStr(result.SkippedExisting, nullKey) || containsStr(result.SkippedSecrets, nullKey) {
		t.Fatalf("result = %+v, a null cell should appear in none of Merged/SkippedExisting/SkippedSecrets", result)
	}
}

// ---- MergeIntoEnv: boot-time snapshot, not a live view -----------------------------------

func TestMergeIntoEnvIsABootTimeSnapshotNotLiveUpdated(t *testing.T) {
	envKeyCounter++
	key := fmt.Sprintf("ENVPIT_MERGE_TEST_LIVE_%d", envKeyCounter)
	t.Cleanup(func() { os.Unsetenv(key) })
	os.Unsetenv(key)

	rt := &fakeTransport{configFn: fetchQueue(t,
		fmt.Sprintf(`{%q:"boot-value"}`, key),
		fmt.Sprintf(`{%q:"changed-value"}`, key),
	)}
	client, err := NewClient(context.Background(), WithAPIKey("epk_test"), WithPollInterval(0), WithHTTPClient(fakeHTTPClient(rt)), WithLogger(nil))
	if err != nil {
		t.Fatalf("NewClient failed: %v", err)
	}
	t.Cleanup(client.Close)

	client.MergeIntoEnv()
	if got := os.Getenv(key); got != "boot-value" {
		t.Fatalf("os.Getenv(%s) = %q immediately after merge, want %q", key, got, "boot-value")
	}

	// A later in-memory refresh (poll/push/reconnect) must NOT reach back into os.Environ —
	// MergeIntoEnv is a one-time snapshot write, matching every other language's native
	// mechanism (process.env, Spring @Value) being boot-time-resolved.
	client.doRefresh(TriggerPoll)

	newVal, err := client.Get(key)
	if err != nil || newVal != "changed-value" {
		t.Fatalf("client.Get(%s) after refresh = %q, %v — want the in-memory snapshot to have moved on", key, newVal, err)
	}
	if got := os.Getenv(key); got != "boot-value" {
		t.Fatalf("os.Getenv(%s) = %q after an in-memory refresh, want it to STILL be %q (MergeIntoEnv is boot-time only)", key, got, "boot-value")
	}
}

// ---- MergeIntoEnv: os.Setenv failure is reported, never panics ---------------------------

func TestMergeIntoEnvReportsSetenvErrorsWithoutPanickingAndStillMergesOtherKeys(t *testing.T) {
	envKeyCounter++
	badKey := fmt.Sprintf("ENVPIT_MERGE_TEST_BAD_%d", envKeyCounter)
	goodKey := fmt.Sprintf("ENVPIT_MERGE_TEST_GOOD_%d", envKeyCounter)
	t.Cleanup(func() { os.Unsetenv(badKey); os.Unsetenv(goodKey) })
	os.Unsetenv(badKey)
	os.Unsetenv(goodKey)

	// A NUL byte in the value makes the underlying syscall.Setenv reject it (EINVAL) on
	// POSIX — a real, reachable failure mode (a corrupted/binary secret value), not a
	// contrived one.
	client := newLoadedClient(t, fmt.Sprintf(`{%q:"has\u0000nul",%q:"fine"}`, badKey, goodKey))

	var result MergeResult
	func() {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("MergeIntoEnv panicked: %v", r)
			}
		}()
		result = client.MergeIntoEnv()
	}()

	if result.Errors == nil || result.Errors[badKey] == nil {
		t.Fatalf("result.Errors = %+v, want a recorded error for %s", result.Errors, badKey)
	}
	if got := os.Getenv(goodKey); got != "fine" {
		t.Fatalf("os.Getenv(%s) = %q, want %q — one bad key must not block the rest of the merge", goodKey, got, "fine")
	}
}

// ---- Result ordering (deterministic output for logging/snapshots) -----------------------

func TestMergeResultKeysAreSortedForDeterministicLogging(t *testing.T) {
	envKeyCounter++
	a := fmt.Sprintf("ENVPIT_MERGE_TEST_ZZZ_%d", envKeyCounter)
	b := fmt.Sprintf("ENVPIT_MERGE_TEST_AAA_%d", envKeyCounter)
	t.Cleanup(func() { os.Unsetenv(a); os.Unsetenv(b) })
	os.Unsetenv(a)
	os.Unsetenv(b)

	client := newLoadedClient(t, fmt.Sprintf(`{%q:"1",%q:"2"}`, a, b))
	result := client.MergeIntoEnv()

	if !sort.StringsAreSorted(result.Merged) {
		t.Fatalf("result.Merged = %v, want sorted output", result.Merged)
	}
}

// ---- package-level sugar parity -----------------------------------------------------------

func TestPackageLevelMergeIntoEnvDelegatesToDefaultClient(t *testing.T) {
	envKeyCounter++
	key := fmt.Sprintf("ENVPIT_MERGE_TEST_SUGAR_%d", envKeyCounter)
	t.Cleanup(func() { os.Unsetenv(key) })
	os.Unsetenv(key)

	rt := &fakeTransport{configFn: fetchQueue(t, fmt.Sprintf(`{%q:"sugar-value"}`, key))}
	client, err := Load(context.Background(), WithAPIKey("epk_test"), WithPollInterval(0), WithHTTPClient(fakeHTTPClient(rt)), WithLogger(nil))
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	t.Cleanup(Close)
	_ = client

	result := MergeIntoEnv()

	if got := os.Getenv(key); got != "sugar-value" {
		t.Fatalf("os.Getenv(%s) = %q, want %q via package-level MergeIntoEnv", key, got, "sugar-value")
	}
	if !containsStr(result.Merged, key) {
		t.Fatalf("result.Merged = %v, want it to contain %s", result.Merged, key)
	}
}

func TestPackageLevelSecretKeysDelegatesToDefaultClient(t *testing.T) {
	rt := &fakeTransport{configFn: fetchQueue(t, `{"A":"1","B":"2"}`)}
	_, err := Load(context.Background(), WithAPIKey("epk_test"), WithPollInterval(0), WithHTTPClient(fakeHTTPClient(rt)), WithLogger(nil))
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	t.Cleanup(Close)

	defaultMu.RLock()
	defaultClient.mu.Lock()
	defaultClient.secretKeys = []string{"B"}
	defaultClient.mu.Unlock()
	defaultMu.RUnlock()

	if got := SecretKeys(); len(got) != 1 || got[0] != "B" {
		t.Fatalf("SecretKeys() = %v, want [B] via package-level delegation", got)
	}
}
