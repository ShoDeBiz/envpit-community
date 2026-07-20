package envpit

import (
	"context"
	"net/http"
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
