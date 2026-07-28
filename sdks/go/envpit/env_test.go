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
	if !containsStr(result.Set, key) {
		t.Fatalf("result.Set = %v, want it to contain %s", result.Set, key)
	}
	if containsStr(result.Skipped, key) {
		t.Fatalf("result.Skipped = %v, should NOT contain %s (it was newly set)", result.Skipped, key)
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
	if !containsStr(result.Skipped, key) {
		t.Fatalf("result.Skipped = %v, want it to contain %s", result.Skipped, key)
	}
	if containsStr(result.Set, key) {
		t.Fatalf("result.Set = %v, should NOT contain %s (it was skipped, not set)", result.Set, key)
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
	if !containsStr(result.Set, key) {
		t.Fatalf("result.Set = %v, want it to contain %s", result.Set, key)
	}
}

// ---- MergeIntoEnv: precise per-key control (the only available secret-safety primitive,

// since the resolve wire format carries no isSecret flag — see doc comment / README) ------

func TestMergeIntoEnvWithOnlyMergesAllowlistedKeysOnly(t *testing.T) {
	envKeyCounter++
	pub := fmt.Sprintf("ENVPIT_MERGE_TEST_PUB_%d", envKeyCounter)
	sec := fmt.Sprintf("ENVPIT_MERGE_TEST_SEC_%d", envKeyCounter)
	t.Cleanup(func() { os.Unsetenv(pub); os.Unsetenv(sec) })
	os.Unsetenv(pub)
	os.Unsetenv(sec)

	client := newLoadedClient(t, fmt.Sprintf(`{%q:"public-value",%q:"secret-value"}`, pub, sec))

	result := client.MergeIntoEnv(WithOnly(pub))

	if got := os.Getenv(pub); got != "public-value" {
		t.Fatalf("os.Getenv(%s) = %q, want %q", pub, got, "public-value")
	}
	if _, ok := os.LookupEnv(sec); ok {
		t.Fatalf("os.LookupEnv(%s) found a value — WithOnly must exclude keys not in the allowlist", sec)
	}
	if !containsStr(result.Set, pub) || containsStr(result.Set, sec) {
		t.Fatalf("result.Set = %v, want exactly [%s]", result.Set, pub)
	}
}

func TestMergeIntoEnvWithExcludeSkipsDenylistedKeys(t *testing.T) {
	envKeyCounter++
	pub := fmt.Sprintf("ENVPIT_MERGE_TEST_PUB2_%d", envKeyCounter)
	sec := fmt.Sprintf("ENVPIT_MERGE_TEST_SEC2_%d", envKeyCounter)
	t.Cleanup(func() { os.Unsetenv(pub); os.Unsetenv(sec) })
	os.Unsetenv(pub)
	os.Unsetenv(sec)

	client := newLoadedClient(t, fmt.Sprintf(`{%q:"public-value",%q:"secret-value"}`, pub, sec))

	result := client.MergeIntoEnv(WithExclude(sec))

	if got := os.Getenv(pub); got != "public-value" {
		t.Fatalf("os.Getenv(%s) = %q, want %q", pub, got, "public-value")
	}
	if _, ok := os.LookupEnv(sec); ok {
		t.Fatalf("os.LookupEnv(%s) found a value — WithExclude must skip denylisted keys", sec)
	}
	if !containsStr(result.Set, pub) || containsStr(result.Set, sec) {
		t.Fatalf("result.Set = %v, want exactly [%s]", result.Set, pub)
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
	if containsStr(result.Set, nullKey) || containsStr(result.Skipped, nullKey) {
		t.Fatalf("result = %+v, a null cell should appear in neither Set nor Skipped", result)
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

	if !sort.StringsAreSorted(result.Set) {
		t.Fatalf("result.Set = %v, want sorted output", result.Set)
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
	if !containsStr(result.Set, key) {
		t.Fatalf("result.Set = %v, want it to contain %s", result.Set, key)
	}
}
