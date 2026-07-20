package envpit

import (
	"context"
	"net/http"
	"testing"
	"time"
)

// safeInvoke (client.go) is the SDK's ONE recover() call site (Sara §3.2). These tests prove a
// panicking Logger and a panicking injected *http.Client RoundTripper cannot crash the test
// process/refresh goroutine — the two user-supplied interfaces the SDK itself invokes.

func TestSafeInvokeRecoversAPanic(t *testing.T) {
	panicked := safeInvoke(func() { panic("boom") })
	if !panicked {
		t.Fatal("expected safeInvoke to report a panic")
	}
}

func TestSafeInvokeDoesNotReportWhenFnDoesNotPanic(t *testing.T) {
	panicked := safeInvoke(func() {})
	if panicked {
		t.Fatal("expected safeInvoke to report no panic")
	}
}

// panickingLogger panics on every call — an adversarial injected Logger.
type panickingLogger struct{}

func (panickingLogger) Debug(string) { panic("logger panic: debug") }
func (panickingLogger) Info(string)  { panic("logger panic: info") }
func (panickingLogger) Warn(string)  { panic("logger panic: warn") }
func (panickingLogger) Error(string) { panic("logger panic: error") }

func TestSafeInvoke_PanickingLoggerDoesNotCrashTheProcess(t *testing.T) {
	// Trigger a background-refresh-failure warn log (routes through Client.safeLog) with a
	// panicking logger installed — must not crash the test process, and the client must keep
	// working afterward (the panic is contained to that one log call).
	client := newLoadedClient(t, `{"K":"v0"}`, WithLogger(panickingLogger{}))
	client.httpClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return jsonResponse(500, "{}"), nil
	})}

	done := make(chan struct{})
	go func() {
		defer close(done)
		client.doRefresh(TriggerPoll) // internally calls safeLog("warn", ...) via a panicking logger
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("doRefresh hung — a panicking logger must not deadlock the refresh path")
	}

	// The client must still be fully functional afterward.
	got, err := client.Get("K")
	if err != nil || got != "v0" {
		t.Fatalf("client unusable after a logger panic: Get(K) = %q, %v", got, err)
	}
}

// panickingRoundTripper panics on every RoundTrip call — an adversarial injected *http.Client
// (Sara §3.2: "the injected http.Client edge cases" — the other user-supplied interface the SDK
// itself invokes).
type panickingRoundTripper struct{}

func (panickingRoundTripper) RoundTrip(*http.Request) (*http.Response, error) {
	panic("round tripper panic")
}

func TestSafeInvoke_PanickingHTTPClientDoesNotCrashNewClient(t *testing.T) {
	_, err := NewClient(context.Background(),
		WithAPIKey("epk_test"), WithPollInterval(0),
		WithHTTPClient(&http.Client{Transport: panickingRoundTripper{}}), WithLogger(nil))
	if err == nil {
		t.Fatal("expected an error")
	}
	if !errorTypeNameMatches(err, "NetworkError") {
		t.Fatalf("expected NetworkError, got %T: %v", err, err)
	}
}

func TestSafeInvoke_PanickingHTTPClientOnBackgroundRefreshIsContained(t *testing.T) {
	client := newLoadedClient(t, `{"K":"v0"}`)
	client.httpClient = &http.Client{Transport: panickingRoundTripper{}}

	done := make(chan struct{})
	go func() {
		defer close(done)
		client.doRefresh(TriggerPoll)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("doRefresh hung after a panicking HTTP client")
	}

	got, err := client.Get("K")
	if err != nil || got != "v0" {
		t.Fatalf("client unusable after an HTTP client panic: Get(K) = %q, %v", got, err)
	}
	if client.CacheInfo().LastError == nil {
		t.Fatal("expected the panic to be recorded as a background-refresh failure")
	}
}
