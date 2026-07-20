package envpit

import (
	"context"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"strings"
	"testing"
)

// Chris's M-2 (outputs/REVIEW-envpit-0t2z-3-go.md, tracked as bd:envpit-b9r1's Go slice): no
// property-based/fuzz-style test framework was used anywhere in the Go SDK for pure functions
// like diffSnapshots/GetInt/GetBool's parsers, despite Chris's own note that "testing/quick or
// native go test -fuzz would be free, zero-dep." This file adds both: a deterministic randomized
// property test for diffSnapshots (porting Chris's own "2000 randomized snapshot pairs" temp
// check into the permanent suite) and native go test -fuzz targets for the GetInt/GetBool
// parsers (fuzzing strings is natively supported; ConfigSnapshot's map[string]*string shape is
// not a fuzzable native type, hence the randomized-property approach for diffSnapshots instead).

// ---- diffSnapshots: randomized property test --------------------------------------------------

// randomConfigSnapshot builds a small random ConfigSnapshot, including nil entries (present-but-
// null) and absent keys, from a shared small key/value alphabet — deliberately narrow so repeated
// random pairs actually exercise the "both missing", "one missing one present", and "both
// present, equal/different" branches of diffSnapshots frequently rather than almost always
// landing on "both present, different" with a huge random alphabet.
func randomConfigSnapshot(rng *rand.Rand) ConfigSnapshot {
	keys := []string{"A", "B", "C", "D", "E"}
	values := []string{"v0", "v1", "v2"}

	snap := make(ConfigSnapshot)
	for _, k := range keys {
		switch rng.Intn(3) {
		case 0:
			// absent entirely
		case 1:
			snap[k] = nil // present-but-null
		case 2:
			v := values[rng.Intn(len(values))]
			snap[k] = &v
		}
	}
	return snap
}

func sameStringSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	seen := make(map[string]int, len(a))
	for _, s := range a {
		seen[s]++
	}
	for _, s := range b {
		seen[s]--
	}
	for _, count := range seen {
		if count != 0 {
			return false
		}
	}
	return true
}

// TestDiffSnapshotsProperty_SymmetricAndIdempotent asserts two invariants that must hold for
// EVERY pair of snapshots, not just the hand-picked cases in test-vectors/snapshot-diff.json:
//  1. Symmetric: diffSnapshots(a, b) and diffSnapshots(b, a) name the exact same set of changed
//     keys (which key "changed" is direction-independent; only the changed-NAMES set is, by
//     diffSnapshots's own doc comment, ever computed — never the values).
//  2. Idempotent: diffing a snapshot against itself is always empty.
//
// Deterministic seed (not time-based) so a CI failure is always exactly reproducible from the
// printed iteration/snapshots — flaky-by-design randomized tests are worse than no test.
func TestDiffSnapshotsProperty_SymmetricAndIdempotent(t *testing.T) {
	rng := rand.New(rand.NewSource(20260720))

	const iterations = 2000
	for i := 0; i < iterations; i++ {
		a := randomConfigSnapshot(rng)
		b := randomConfigSnapshot(rng)

		forward := diffSnapshots(a, b)
		backward := diffSnapshots(b, a)
		if !sameStringSet(forward, backward) {
			t.Fatalf("iteration %d: diffSnapshots not symmetric\n a=%v\n b=%v\n forward=%v\n backward=%v",
				i, a, b, forward, backward)
		}

		if got := diffSnapshots(a, a); len(got) != 0 {
			t.Fatalf("iteration %d: diffSnapshots(a, a) not empty: %v (a=%v)", i, got, a)
		}
		if got := diffSnapshots(b, b); len(got) != 0 {
			t.Fatalf("iteration %d: diffSnapshots(b, b) not empty: %v (b=%v)", i, got, b)
		}
	}
}

// ---- GetInt/GetIntOr, GetBool/GetBoolOr: native fuzz targets ----------------------------------

// singleShotConfigRoundTripper serves the same canned config body to every GET .../api/v1/config
// call. Fuzz targets below only ever trigger ONE real fetch (at NewClient time, poll disabled) —
// every subsequent fuzz case mutates the client's in-memory snapshot directly instead of
// refetching — but this stays a fresh reader per call rather than a fixed queue-of-one, so it
// can't "run out" if that assumption ever changes.
type singleShotConfigRoundTripper struct{ body string }

func (rt singleShotConfigRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Path != configPath {
		return nil, fmt.Errorf("singleShotConfigRoundTripper: unexpected path %s (fuzz targets only call %s)", r.URL.Path, configPath)
	}
	return &http.Response{
		StatusCode: 200,
		Status:     "200 OK",
		Body:       io.NopCloser(strings.NewReader(rt.body)),
		Header:     make(http.Header),
	}, nil
}

// setSnapshotValue mutates a live Client's in-memory snapshot directly (same-package access,
// under the client's own lock) — lets each fuzz case exercise the real GetInt/GetIntOr/
// GetBool/GetBoolOr methods against an arbitrary raw string without a real HTTP round trip per
// case (which would make native fuzzing far too slow to be useful).
func setSnapshotValue(c *Client, key, raw string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	v := raw
	c.snapshot[key] = &v
}

// newFuzzTargetClient builds a real, fully-initialized Client (via NewClient, poll disabled) for
// fuzz targets to reuse across every case — constructing a whole Client per fuzz case would make
// `go test -fuzz` far too slow to be practically useful.
func newFuzzTargetClient(f *testing.F) *Client {
	f.Helper()
	client, err := NewClient(context.Background(),
		WithAPIKey("epk_test"), WithPollInterval(0),
		WithHTTPClient(&http.Client{Transport: singleShotConfigRoundTripper{body: `{"K":"seed"}`}}),
		WithLogger(nil))
	if err != nil {
		f.Fatalf("newFuzzTargetClient: NewClient failed: %v", err)
	}
	return client
}

// FuzzGetIntOrAgreesWithGetInt asserts the real invariant a hand-written parser test can't fully
// cover: for ANY raw string stored under a key, GetIntOr must return the exact same parsed int as
// GetInt when GetInt succeeds, and must fall back to the caller's default when GetInt fails —
// never anything else (a silently-wrong parse, a panic, or a mismatch between the two call
// styles).
func FuzzGetIntOrAgreesWithGetInt(f *testing.F) {
	for _, seed := range []string{
		"", "0", "-1", "007", "  42  ", "\t-9\n", "abc", "1.5", "0x1F",
		"999999999999999999999999999999", "-", "+1", "٤٢", "1_000",
	} {
		f.Add(seed)
	}

	client := newFuzzTargetClient(f)
	defer client.Close()

	f.Fuzz(func(t *testing.T, raw string) {
		setSnapshotValue(client, "K", raw)

		n, err := client.GetInt("K")
		const def = 4242
		got := client.GetIntOr("K", def)

		if err == nil {
			if got != n {
				t.Fatalf("raw=%q: GetInt succeeded with %d but GetIntOr disagreed: %d", raw, n, got)
			}
			return
		}
		if _, isTypeMismatch := err.(*TypeMismatchError); !isTypeMismatch {
			t.Fatalf("raw=%q: GetInt failed with unexpected error type %T (want *TypeMismatchError, key always present): %v", raw, err, err)
		}
		if got != def {
			t.Fatalf("raw=%q: GetInt failed (%v) but GetIntOr did not fall back to def=%d: got %d", raw, err, def, got)
		}
	})
}

// FuzzGetBoolOrAgreesWithGetBool mirrors FuzzGetIntOrAgreesWithGetInt for the boolean parser.
func FuzzGetBoolOrAgreesWithGetBool(f *testing.F) {
	for _, seed := range []string{
		"", "true", "false", "TRUE", "0", "1", "yes", "no", "on", "off",
		"  true  ", "\ttrue\n", "y", "n", "2", "-1", "T", "vrai",
	} {
		f.Add(seed)
	}

	client := newFuzzTargetClient(f)
	defer client.Close()

	f.Fuzz(func(t *testing.T, raw string) {
		setSnapshotValue(client, "K", raw)

		b, err := client.GetBool("K")
		const def = true
		got := client.GetBoolOr("K", def)

		if err == nil {
			if got != b {
				t.Fatalf("raw=%q: GetBool succeeded with %v but GetBoolOr disagreed: %v", raw, b, got)
			}
			return
		}
		if _, isTypeMismatch := err.(*TypeMismatchError); !isTypeMismatch {
			t.Fatalf("raw=%q: GetBool failed with unexpected error type %T (want *TypeMismatchError, key always present): %v", raw, err, err)
		}
		if got != def {
			t.Fatalf("raw=%q: GetBool failed (%v) but GetBoolOr did not fall back to def=%v: got %v", raw, err, def, got)
		}
	})
}
