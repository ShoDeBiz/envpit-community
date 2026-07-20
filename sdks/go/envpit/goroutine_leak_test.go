package envpit

import (
	"context"
	"runtime"
	"testing"
	"time"
)

// Chris's M-1 (outputs/REVIEW-envpit-0t2z-3-go.md, tracked as bd:envpit-b9r1's Go slice):
// the shipped suite never asserted the create->subscribe->Close leak-free guarantee via
// runtime.NumGoroutine() — behavior was correct (verified live by both Chris and Quinn during
// review), but nothing in CI would catch a future regression (e.g. subRegistry.subscribe's
// two-case select dropping the clientCtx arm, or a future watcher goroutine that forgets to
// select on it). This ports Chris's own temporary harness into the permanent suite.

// stableGoroutineCount samples runtime.NumGoroutine() after letting any recently-spawned/exiting
// goroutines settle — a single raw sample right after an operation is flaky (finalizers, GC
// workers, and the watcher goroutines this very test is trying to measure all exit
// asynchronously). Settles once the count is unchanged across a few consecutive samples.
func stableGoroutineCount(t *testing.T) int {
	t.Helper()
	var last, stableStreak int
	for i := 0; i < 200; i++ {
		runtime.Gosched()
		if i%10 == 0 {
			runtime.GC()
		}
		n := runtime.NumGoroutine()
		if n == last {
			stableStreak++
			if stableStreak >= 5 {
				return n
			}
		} else {
			stableStreak = 0
		}
		last = n
		time.Sleep(2 * time.Millisecond)
	}
	return last
}

// TestGoroutineLeak_CreateSubscribeCloseCyclesReturnToBaseline ports Chris's temp harness #1:
// 20x create -> subscribe(Changes/Connections/Errors) -> Close, asserting NumGoroutine() returns
// exactly to baseline every cycle (not just "doesn't grow unbounded" — an exact return proves
// Close() really does stop the poll goroutine, the coalescing refresher goroutine, and every
// per-subscriber watcher goroutine, not merely that they eventually get GC'd).
func TestGoroutineLeak_CreateSubscribeCloseCyclesReturnToBaseline(t *testing.T) {
	baseline := stableGoroutineCount(t)

	const cycles = 20
	for i := 0; i < cycles; i++ {
		rt := &fakeTransport{
			configFn: fetchQueue(t, `{"K":"v0"}`),
			eventsFn: neverConnectEvents(t),
		}
		client, err := NewClient(context.Background(),
			WithAPIKey("epk_test"), WithPollInterval(50*time.Millisecond),
			WithHTTPClient(fakeHTTPClient(rt)), WithLogger(nil))
		if err != nil {
			t.Fatalf("cycle %d: NewClient failed: %v", i, err)
		}

		ctx, cancel := context.WithCancel(context.Background())
		_ = client.Changes(ctx)
		_ = client.Connections(ctx)
		_ = client.Errors(ctx)

		client.Close()
		cancel()

		got := stableGoroutineCount(t)
		if got != baseline {
			t.Fatalf("cycle %d: goroutine count did not return to baseline after Close(): baseline=%d got=%d",
				i, baseline, got)
		}
	}
}

// TestGoroutineLeak_NeverCancelledSubscriberCtxStillClosesOnClientClose ports Chris's temp
// harness #2: subRegistry.subscribe's doc comment claims a subscriber whose OWN ctx is
// context.Background() (never cancelled) still has its watcher goroutine reaped by Close() —
// clientCtx is the second arm of subscribe's select specifically so this case can't leak.
// Regression-locks that specific two-arm select, not just the common "caller cancels ctx" path.
func TestGoroutineLeak_NeverCancelledSubscriberCtxStillClosesOnClientClose(t *testing.T) {
	baseline := stableGoroutineCount(t)

	rt := &fakeTransport{
		configFn: fetchQueue(t, `{"K":"v0"}`),
		eventsFn: neverConnectEvents(t),
	}
	client, err := NewClient(context.Background(),
		WithAPIKey("epk_test"), WithPollInterval(50*time.Millisecond),
		WithHTTPClient(fakeHTTPClient(rt)), WithLogger(nil))
	if err != nil {
		t.Fatalf("NewClient failed: %v", err)
	}

	// Deliberately context.Background() — never cancelled by this test. The ONLY thing that may
	// ever stop these watcher goroutines is Client.Close().
	changes := client.Changes(context.Background())
	conns := client.Connections(context.Background())
	errs := client.Errors(context.Background())

	client.Close()

	// All three channels must close (not just "goroutine count settles") — closing is the actual
	// documented contract; a leaked watcher goroutine would also leave these channels open forever.
	assertChannelClosed(t, "Changes", changes)
	assertChannelClosed(t, "Connections", conns)
	assertChannelClosed(t, "Errors", errs)

	got := stableGoroutineCount(t)
	if got != baseline {
		t.Fatalf("goroutine count did not return to baseline after Close() with a never-cancelled subscriber ctx: baseline=%d got=%d",
			baseline, got)
	}
}

func assertChannelClosed[T any](t *testing.T, name string, ch <-chan T) {
	t.Helper()
	select {
	case _, ok := <-ch:
		if ok {
			t.Fatalf("%s channel delivered a value instead of closing", name)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("%s channel did not close within 2s of Client.Close()", name)
	}
}
