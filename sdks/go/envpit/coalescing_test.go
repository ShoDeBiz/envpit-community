package envpit

import (
	"context"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// This file proves the coalescing single-refresher goroutine design (Sara
// SPEC-envpit-0t2z-3-1a-architecture.md §4, ADR-S3-06) under REAL concurrency — real goroutines
// racing against a genuinely in-flight fetch, not a mock-level assertion. It is the Go-specific
// stand-in for Node/Python's generation-guard adversarial tests (INV-SDK-5).
//
// Important design note this file's assertions are built around: Go's mechanism does NOT
// discard a "stale" response the way Node/Python's generation counter does, because in Go's
// design there is no such thing as a stale response — at most one fetch is EVER in flight, so
// every fetch that completes reflects real, live server state at the moment it ran (Sara §4:
// "the superseded-request case Node handles by discarding, Go handles by never creating"). What
// this file proves instead is the two properties that actually matter for Go's mechanism: (1) a
// burst of concurrent triggers coalesces into AT MOST ONE extra fetch, never one per trigger,
// and (2) at most one fetch is ever observably in flight at a time — which by itself makes
// out-of-order resolution structurally impossible, satisfying INV-SDK-5's OBSERVABLE invariant
// (test-vectors/CONFORMANCE.md: "the conformance tests... assert the OBSERVABLE invariant, not
// the counter mechanism").

func assertCoalescingRefresherFreshnessInvariant(t *testing.T) {
	t.Helper()

	var callIndex int32
	reachedSecond := make(chan struct{})
	releaseSecond := make(chan struct{})

	rt := &fakeTransport{
		configFn: func(r *http.Request) (*http.Response, error) {
			switch atomic.AddInt32(&callIndex, 1) {
			case 1:
				return jsonResponse(200, envelopeBody(`{"K":"v0"}`)), nil
			case 2:
				close(reachedSecond)
				<-releaseSecond
				return jsonResponseWithEtag(200, envelopeBody(`{"K":"v1"}`), "e1"), nil
			case 3:
				return jsonResponseWithEtag(200, envelopeBody(`{"K":"v2"}`), "e2"), nil
			default:
				t.Errorf("unexpected extra fetch call — a burst of concurrent triggers must coalesce into at most one catch-up fetch, not one per trigger")
				return jsonResponse(200, envelopeBody(`{"K":"unexpected"}`)), nil
			}
		},
		eventsFn: neverConnectEvents(t),
	}

	client, err := NewClient(context.Background(),
		WithAPIKey("epk_test"), WithPollInterval(time.Hour),
		WithHTTPClient(fakeHTTPClient(rt)), WithLogger(nil))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	changes := client.Changes(ctx)

	// Kick off refresh #2 and wait until it has genuinely reached the blocked fetch — proves
	// real in-flight concurrency below, not a race-prone sleep guess.
	client.requestRefresh(TriggerPoll)
	select {
	case <-reachedSecond:
	case <-time.After(2 * time.Second):
		t.Fatal("refresh #2 never reached the blocked fetch")
	}

	// Real concurrency: 5 goroutines racing to trigger a refresh WHILE #2 is still in flight —
	// exactly the poll-tick + push + reconnect burst Sara §4 describes.
	var wg sync.WaitGroup
	triggers := []ChangeTrigger{TriggerPoll, TriggerPush, TriggerReconnect, TriggerPoll, TriggerPush}
	for _, trig := range triggers {
		wg.Add(1)
		go func(tr ChangeTrigger) {
			defer wg.Done()
			client.requestRefresh(tr)
		}(trig)
	}
	wg.Wait()

	close(releaseSecond)

	if !waitUntil(t, 2*time.Second, func() bool {
		v, _ := client.Get("K")
		return v == "v2"
	}) {
		v, _ := client.Get("K")
		t.Fatalf("final state never converged to the freshest value (v2); got %q", v)
	}

	time.Sleep(100 * time.Millisecond) // let any wrongly-issued extra fetches show up
	if final := atomic.LoadInt32(&callIndex); final != 3 {
		t.Fatalf("expected exactly 3 fetch calls (1 initial load + 1 in-flight + 1 coalesced "+
			"catch-up for the whole 5-trigger burst), got %d — coalescing failed to coalesce", final)
	}

	// Both real refreshes' change events are delivered, in order, each reflecting the ACTUAL
	// server state at the time IT ran (see file doc comment).
	first := recvChange(t, changes)
	if first.Etag != "e1" {
		t.Fatalf("expected first change event etag=e1, got %q", first.Etag)
	}
	second := recvChange(t, changes)
	if second.Etag != "e2" {
		t.Fatalf("expected second change event etag=e2, got %q", second.Etag)
	}
	select {
	case e := <-changes:
		t.Fatalf("expected exactly 2 change events total, got a 3rd: %+v", e)
	case <-time.After(100 * time.Millisecond):
	}

	if got := client.CacheInfo().Etag; got != "e2" {
		t.Fatalf("CacheInfo().Etag = %q, want e2", got)
	}
}

func recvChange(t *testing.T, ch <-chan ChangeEvent) ChangeEvent {
	t.Helper()
	select {
	case e := <-ch:
		return e
	case <-time.After(time.Second):
		t.Fatal("expected a change event, got none")
		return ChangeEvent{}
	}
}

// TestCoalescingRefresherNeverRunsMoreThanOneFetchConcurrently is the strongest, most direct
// proof available: instrument the fake fetch itself to record how many concurrent invocations
// were ever observed in flight at once, under a genuine 50-goroutine concurrent-trigger storm.
// Run with `go test -race` — this also proves the design has no data race, not just no logical
// reordering bug.
func TestCoalescingRefresherNeverRunsMoreThanOneFetchConcurrently(t *testing.T) {
	var inFlight, maxObserved, totalCalls int32

	rt := &fakeTransport{
		configFn: func(r *http.Request) (*http.Response, error) {
			n := atomic.AddInt32(&inFlight, 1)
			defer atomic.AddInt32(&inFlight, -1)
			for {
				cur := atomic.LoadInt32(&maxObserved)
				if n <= cur || atomic.CompareAndSwapInt32(&maxObserved, cur, n) {
					break
				}
			}
			atomic.AddInt32(&totalCalls, 1)
			time.Sleep(2 * time.Millisecond) // widen the race window
			return jsonResponse(200, envelopeBody(`{"K":"v"}`)), nil
		},
		eventsFn: neverConnectEvents(t),
	}
	client, err := NewClient(context.Background(),
		WithAPIKey("epk_test"), WithPollInterval(time.Hour),
		WithHTTPClient(fakeHTTPClient(rt)), WithLogger(nil))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			trig := []ChangeTrigger{TriggerPoll, TriggerPush, TriggerReconnect}[i%3]
			client.requestRefresh(trig)
		}(i)
	}
	wg.Wait()
	time.Sleep(200 * time.Millisecond) // let any coalesced catch-up run finish

	if max := atomic.LoadInt32(&maxObserved); max > 1 {
		t.Fatalf("observed %d fetches in flight concurrently — out-of-order resolution is possible", max)
	}
	t.Logf("50 concurrent triggers across 3 goroutines -> %d actual fetch calls total "+
		"(1 initial load + at most one coalesced catch-up)", atomic.LoadInt32(&totalCalls))
}

func TestCoalescingRefresherFreshnessInvariant(t *testing.T) {
	assertCoalescingRefresherFreshnessInvariant(t)
}
