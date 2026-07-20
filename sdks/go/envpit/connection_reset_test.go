package envpit

import (
	"context"
	"errors"
	"net"
	"net/http"
	"testing"
	"time"
)

// bd:envpit-4dbm-class coverage — the carry-forward lesson from Python: a mid-connection TCP
// reset/disconnect (pod killed mid-request, an LB idle-timeout race, a NAT/firewall RST) must be
// caught and mapped into the SDK's typed error taxonomy — never let it escape as a raw,
// unwrapped error — on BOTH the initial-load path AND the background-refresh path, where
// specifically the error callback/channel must actually fire (Python's bug was that this
// silently didn't happen on the refresh path even after being partially fixed on the load path).
//
// TestVectorsErrorMapping's "connection-reset-mid-request-with-zero-response-bytes-is-network-
// error" case (vectors_test.go) already proves the mapping against a SYNTHETIC net.OpError
// shape; this file additionally proves it EMPIRICALLY against a real TCP socket (same
// methodology THREATMODEL-envpit-0t2z-3.md and the Python fix used: "verified empirically, not
// assumed") and proves the client-level consequences the vector alone can't exercise.

// resetListener accepts exactly one TCP connection, reads nothing from it, and closes it
// immediately — a real, empirically-observed "server accepted the connection, read the request,
// then closed with zero response bytes" mid-connection reset.
func resetListener(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to open a local TCP listener: %v", err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		conn.Close() // zero response bytes — the bd:envpit-4dbm shape
	}()
	return "http://" + ln.Addr().String()
}

func TestBdEnvpit4dbm_EmpiricalTCPResetOnFirstLoadIsWrappedAsNetworkError(t *testing.T) {
	host := resetListener(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, err := NewClient(ctx, WithAPIKey("epk_test"), WithHost(host), WithPollInterval(0), WithLogger(nil))
	if err == nil {
		t.Fatal("expected an error")
	}
	if !errorTypeNameMatches(err, "NetworkError") {
		t.Fatalf("a mid-connection reset must be wrapped as *NetworkError, not escape raw — got %T: %v", err, err)
	}
	// The documented "except EnvpitError" catch-all pattern must actually catch it.
	var envpitErr EnvpitError
	if !errors.As(err, &envpitErr) {
		t.Fatalf("expected err to satisfy the EnvpitError interface, got %T", err)
	}
}

func TestBdEnvpit4dbm_BackgroundRefreshRecordsNetworkErrorNotARawError(t *testing.T) {
	client := newLoadedClient(t, `{"K":"v0"}`)

	host := resetListener(t)
	client.host = host
	client.httpClient = &http.Client{} // real transport — must actually hit the raw TCP listener

	client.doRefresh(TriggerPoll) // hits the reset

	got, err := client.Get("K")
	if err != nil || got != "v0" {
		t.Fatalf("stale-while-revalidate broken: Get(K) = %q, %v", got, err)
	}

	lastErr := client.CacheInfo().LastError
	if lastErr == nil {
		t.Fatal("expected CacheInfo().LastError to be set")
	}
	if !errorTypeNameMatches(lastErr, "NetworkError") {
		t.Fatalf("cache_info.LastError must be *NetworkError, not the raw transport error — got %T: %v", lastErr, lastErr)
	}
}

// TestBdEnvpit4dbm_ErrorsChannelFiresOnBackgroundRefreshReset is the specific regression this
// carry-forward lesson calls out: Python's bug was that the error callback/signal silently did
// NOT fire on the refresh path even after being partially fixed on the initial-load path. Prove
// it fires here, in Go, from day one.
func TestBdEnvpit4dbm_ErrorsChannelFiresOnBackgroundRefreshReset(t *testing.T) {
	client := newLoadedClient(t, `{"K":"v0"}`)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errs := client.Errors(ctx)

	host := resetListener(t)
	client.host = host
	client.httpClient = &http.Client{} // real transport — must actually hit the raw TCP listener

	client.doRefresh(TriggerPoll) // hits the reset

	select {
	case err := <-errs:
		if err == nil {
			t.Fatal("received a nil error")
		}
		if !errorTypeNameMatches(err, "NetworkError") {
			t.Fatalf("expected *NetworkError on Errors(ctx), got %T: %v", err, err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Errors(ctx) never fired for a mid-connection reset on the background-refresh path — this is exactly the Python bug this SDK must not rediscover")
	}
}

// TestBdEnvpit4dbm_SelfHealsOnceTheConnectionStopsResetting is the full end-to-end sanity via
// the real background-refresh machinery: a reset that stops happening is recovered from
// automatically, same as any other transient network failure (INV-SDK-4).
func TestBdEnvpit4dbm_SelfHealsOnceTheConnectionStopsResetting(t *testing.T) {
	resetHost := resetListener(t)

	rt := &fakeTransport{
		configFn: fetchQueue(t, `{"K":"v_recovered"}`),
	}
	// First: load succeeds against the fake transport. Then swap the client onto the
	// reset-producing host for one failing background refresh, then swap back to the fake
	// transport for recovery — proves both halves (breaks correctly, heals correctly) without
	// needing two separate listeners racing on timing.
	client := newLoadedClient(t, `{"K":"v0"}`)
	client.host = resetHost
	client.httpClient = &http.Client{} // real transport — must actually hit the raw TCP listener
	client.doRefresh(TriggerPoll)
	if client.CacheInfo().LastError == nil {
		t.Fatal("expected the reset to be recorded as a failure first")
	}

	client.httpClient = fakeHTTPClient(rt)
	client.host = "https://example.test"
	client.doRefresh(TriggerPoll)

	got, err := client.Get("K")
	if err != nil || got != "v_recovered" {
		t.Fatalf("expected self-heal to v_recovered, got %q, %v", got, err)
	}
	if client.CacheInfo().LastError != nil {
		t.Fatalf("expected LastError to clear after a successful refresh, got %v", client.CacheInfo().LastError)
	}
}
