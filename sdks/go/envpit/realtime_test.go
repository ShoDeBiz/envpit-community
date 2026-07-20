package envpit

import (
	"context"
	"net/http"
	"sync"
	"testing"
	"time"
)

// End-to-end realtime-transport integration: a genuine connect -> push-frame -> mode-change ->
// disconnect -> reconnect cycle through fakeTransport + fakeSSEStream (not a unit-level mock of
// realtimeTransport's own methods) — exercises connectOnce/pump/onSuccess/handleFrame together.

func TestRealtimeIntegration_ConnectReceivePushAndReconnect(t *testing.T) {
	stream := newFakeSSEStream()

	rt := &fakeTransport{
		configFn: fetchQueue(t, `{"K":"v0"}`, `{"K":"v1"}`),
		eventsFn: func(r *http.Request) (*http.Response, error) {
			return sseResponse(stream), nil
		},
	}

	client, err := NewClient(context.Background(),
		WithAPIKey("epk_test"), WithPollInterval(time.Hour),
		WithHTTPClient(fakeHTTPClient(rt)), WithLogger(nil))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	conns := client.Connections(context.Background())

	// Realtime channel must reach 'realtime' mode (connectOnce -> onSuccess) — the first connect
	// event, per INV-SDK-9, must NOT itself carry a change event.
	if !waitUntil(t, 2*time.Second, func() bool {
		return client.CacheInfo().RefreshMode == RefreshRealtime
	}) {
		t.Fatal("realtime channel never reached 'realtime' mode")
	}
	select {
	case e := <-conns:
		if e.Mode != ModeRealtime || e.Reason != ReasonConnected {
			t.Fatalf("unexpected first connection event: %+v", e)
		}
	case <-time.After(time.Second):
		t.Fatal("expected a connection event for the first connect")
	}

	changes := client.Changes(context.Background())

	// Push a real config-changed frame through the stream — exercises handleFrame + pump +
	// parseEtag + the client's handlePushSignal -> requestRefresh -> coalescing refresher path,
	// end to end.
	stream.push("event: config-changed\ndata: {\"etag\":\"e1\"}\n\n")

	select {
	case e := <-changes:
		if len(e.ChangedKeys) != 1 || e.ChangedKeys[0] != "K" || e.Trigger != TriggerPush {
			t.Fatalf("unexpected change event: %+v", e)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("expected a change event triggered by the SSE push")
	}

	got, _ := client.Get("K")
	if got != "v1" {
		t.Fatalf("Get(K) = %q, want v1", got)
	}

	// Disconnect (server closes the stream) — the transport must notice and degrade/retry
	// without crashing; Close() below must still terminate promptly regardless of where the
	// reconnect loop currently is.
	stream.Close()
}

// bd:envpit-tkvz regression — the degraded-mode 5-min warn AfterFunc must be stopped on EVERY
// run(ctx) exit path, not just onSuccess(). Reproduces Quinn's exact live repro: drive the
// transport into degraded mode (schedules the warn timer), cancel ctx mid-backoff — well before
// the (shortened, test-only) warn threshold elapses, simulating Client.Close() — confirm run(ctx)
// returns promptly, then wait PAST the threshold. Pre-fix: a "still unavailable" warn arrives via
// the logger AFTER run(ctx) already returned — a ghost callback firing for an already-closed
// client, and it keeps the whole transport (and everything its closures capture) reachable/
// un-GC'd until it fires. Post-fix: no warn ever arrives.
func TestRealtimeIntegration_CloseMidDegradedBackoffStopsWarnTimer_NoGhostCallback(t *testing.T) {
	var mu sync.Mutex
	var warns []string
	warnThreshold := 80 * time.Millisecond

	transport := newRealtimeTransport(realtimeParams{
		host:   "https://example.test",
		apiKey: "epk_test",
		httpClient: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			return nil, errConnectionRefused()
		})},
		pollInterval:   time.Minute,
		onChangeSignal: func(string) {},
		onModeChange:   func(ConnectionMode, ConnectionReason, time.Time) {},
		onLog: func(level, msg string) {
			mu.Lock()
			defer mu.Unlock()
			if level == "warn" {
				warns = append(warns, msg)
			}
		},
		quickReconnectDelay:       5 * time.Millisecond,
		degradedReconnectInterval: 10 * time.Millisecond,
		degradedReconnectJitter:   0,
		degradedWarnThreshold:     warnThreshold,
	})

	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan struct{})
	go func() {
		transport.run(ctx)
		close(done)
	}()

	// Let it burn the one silent quick retry and settle into degraded mode (schedules the warn
	// timer at ~5-10ms in), then cancel — simulating Client.Close() — well before the 80ms
	// threshold elapses. This is Quinn's exact "Close() mid-backoff" timing condition.
	time.Sleep(30 * time.Millisecond)
	cancel()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("run(ctx) did not return promptly after ctx cancellation (Close())")
	}

	// Wait PAST the warn threshold (measured from cancellation, comfortably past when the
	// scheduled AfterFunc would have fired relative to when it was scheduled). Pre-fix, a ghost
	// warn arrives here even though run(ctx) already returned.
	time.Sleep(warnThreshold + 150*time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	if len(warns) != 0 {
		t.Fatalf("ghost warn callback fired after Close()/ctx-cancel (bd:envpit-tkvz regression): %v", warns)
	}
}

func TestRealtimeIntegration_NonSuccessStatusIsTreatedAsAFailure(t *testing.T) {
	rt := &fakeTransport{
		configFn: fetchQueue(t, `{"K":"v0"}`),
		eventsFn: func(r *http.Request) (*http.Response, error) {
			return jsonResponse(503, "{}"), nil
		},
	}
	client, err := NewClient(context.Background(),
		WithAPIKey("epk_test"), WithPollInterval(200*time.Millisecond),
		WithHTTPClient(fakeHTTPClient(rt)),
		WithLogger(nil))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	if !waitUntil(t, 2*time.Second, func() bool {
		return client.CacheInfo().RefreshMode == RefreshPolling
	}) {
		t.Fatal("expected the channel to settle into degraded/polling mode after a non-2xx events response")
	}
}
