package envpit

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"
)

// ---- Close idempotency + context-cancellation-as-unsubscribe --------------------------------

func TestCloseIsIdempotentAndSafeToCallConcurrently(t *testing.T) {
	client := newLoadedClient(t, `{"K":"v"}`)
	var wg2 = make(chan struct{}, 10)
	for i := 0; i < 10; i++ {
		go func() {
			client.Close()
			wg2 <- struct{}{}
		}()
	}
	for i := 0; i < 10; i++ {
		select {
		case <-wg2:
		case <-time.After(2 * time.Second):
			t.Fatal("concurrent Close() calls did not all return")
		}
	}
	// Get* still works after Close (only background refresh/dispatch stop, per doc comment).
	got, err := client.Get("K")
	if err != nil || got != "v" {
		t.Fatalf("Get(K) after Close = %q, %v", got, err)
	}
}

func TestChangesChannelClosesOnContextCancellation(t *testing.T) {
	client := newLoadedClient(t, `{"K":"v"}`)
	ctx, cancel := context.WithCancel(context.Background())
	ch := client.Changes(ctx)
	cancel()
	if !waitUntil(t, time.Second, func() bool {
		select {
		case _, ok := <-ch:
			return !ok
		default:
			return false
		}
	}) {
		t.Fatal("Changes(ctx) channel did not close after ctx was cancelled")
	}
}

func TestChangesChannelClosesOnClientClose(t *testing.T) {
	client := newLoadedClient(t, `{"K":"v"}`)
	ch := client.Changes(context.Background()) // never cancelled by the caller
	client.Close()
	if !waitUntil(t, time.Second, func() bool {
		select {
		case _, ok := <-ch:
			return !ok
		default:
			return false
		}
	}) {
		t.Fatal("Changes(ctx) channel did not close after Client.Close()")
	}
}

// ---- errors.Is / errors.As idiom (Sara §2.2: both idioms served) ----------------------------

func TestErrorsIsSentinelIdiom(t *testing.T) {
	client := newLoadedClient(t, `{}`)
	_, err := client.Get("MISSING")
	if !errors.Is(err, ErrMissingKey) {
		t.Fatalf("expected errors.Is(err, ErrMissingKey), got %v", err)
	}
}

func TestErrorsAsTypedClassIdiom(t *testing.T) {
	client := newLoadedClient(t, `{}`)
	_, err := client.Get("MISSING_KEY_NAME")
	var mk *MissingKeyError
	if !errors.As(err, &mk) {
		t.Fatalf("expected errors.As to succeed, got %v", err)
	}
	if mk.Key != "MISSING_KEY_NAME" {
		t.Fatalf("mk.Key = %q, want MISSING_KEY_NAME", mk.Key)
	}
}

func TestNetworkErrorUnwrapsToTheUnderlyingCause(t *testing.T) {
	rt := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		<-r.Context().Done()
		return nil, r.Context().Err()
	})
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err := fetchConfig(ctx, &http.Client{Transport: rt}, "https://example.test", "epk_test")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected errors.Is(err, context.DeadlineExceeded) to hold through the NetworkError wrapper, got %v", err)
	}
}

// ---- package-level sugar (Load/Get/GetOr/.../Close) ------------------------------------------

func TestPackageLevelSugarDelegatesToTheDefaultClient(t *testing.T) {
	Close() // ensure a clean slate regardless of test run order
	defer Close()

	rt := &fakeTransport{configFn: fetchQueue(t, `{"K":"v1"}`)}
	client, err := Load(context.Background(), WithAPIKey("epk_test"), WithPollInterval(0),
		WithHTTPClient(fakeHTTPClient(rt)), WithLogger(nil))
	if err != nil {
		t.Fatal(err)
	}
	if got, err := Get("K"); err != nil || got != "v1" {
		t.Fatalf("Get(K) = %q, %v", got, err)
	}
	if client.CacheInfo().Etag != Cache().Etag {
		t.Fatal("package-level Cache() must delegate to the same default client")
	}
}

func TestPackageLevelLoadReplacesAndClosesThePreviousDefault(t *testing.T) {
	Close()
	defer Close()

	rt1 := &fakeTransport{configFn: fetchQueue(t, `{"K":"first"}`)}
	first, err := Load(context.Background(), WithAPIKey("epk_test"), WithPollInterval(time.Hour),
		WithHTTPClient(fakeHTTPClient(rt1)), WithLogger(nil))
	if err != nil {
		t.Fatal(err)
	}

	rt2 := &fakeTransport{configFn: fetchQueue(t, `{"K":"second"}`)}
	_, err = Load(context.Background(), WithAPIKey("epk_test"), WithPollInterval(0),
		WithHTTPClient(fakeHTTPClient(rt2)), WithLogger(nil))
	if err != nil {
		t.Fatal(err)
	}

	if got, _ := Get("K"); got != "second" {
		t.Fatalf("expected the new default's value, got %q", got)
	}

	// The outgoing default's background work must be stopped, not orphaned (bd:envpit-igc0's
	// lesson, carried over from Python) — proven the same way TestINV_SDK_11 proves it: Close()
	// (called internally on `first` by the second Load) must have already torn down its
	// goroutines, so calling Close() again here must return immediately (idempotent, no hang).
	done := make(chan struct{})
	go func() {
		first.Close()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("the outgoing default client was not closed by the subsequent Load() call")
	}
}

func TestPackageLevelOrFamilyPanicsWithNoDefaultClient(t *testing.T) {
	Close()
	defer Close()

	defer func() {
		if recover() == nil {
			t.Fatal("expected GetOr to panic when no default client has been Load()ed")
		}
	}()
	GetOr("K", "fallback")
}
