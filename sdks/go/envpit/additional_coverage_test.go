package envpit

import (
	"context"
	"errors"
	"log/slog"
	"testing"
	"time"
)

// ---- GetBoolOr / GetIntOr — the Go-only Or-family fallback paths ------------------------------

func TestGetBoolOrAllPaths(t *testing.T) {
	client := newLoadedClient(t, `{"A":"true","B":"maybe"}`, WithLogger(newCapturingLogger()))

	if got := client.GetBoolOr("A", false); !got {
		t.Fatal("expected true")
	}
	if got := client.GetBoolOr("MISSING", true); !got {
		t.Fatal("expected the default (true) for a missing key")
	}

	logger := newCapturingLogger()
	client2 := newLoadedClient(t, `{"B":"maybe"}`, WithLogger(logger))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errs := client2.Errors(ctx)

	if got := client2.GetBoolOr("B", true); !got {
		t.Fatal("expected the default (true) for an unparsable value")
	}
	if logger.lastWarn() == "" {
		t.Fatal("expected a warn line for the unparsable Or-family fallback")
	}
	select {
	case err := <-errs:
		var w *orFallbackWarning
		if !errors.As(err, &w) {
			t.Fatalf("expected *orFallbackWarning on Errors(ctx), got %T", err)
		}
	case <-time.After(time.Second):
		t.Fatal("expected the fallback to also surface on Errors(ctx)")
	}
}

func TestGetIntOrUnparsableIntegerReturnsDefaultAndReports(t *testing.T) {
	logger := newCapturingLogger()
	client := newLoadedClient(t, `{"PORT":"not-a-port"}`, WithLogger(logger))
	if got := client.GetIntOr("PORT", 9999); got != 9999 {
		t.Fatalf("GetIntOr = %d, want 9999", got)
	}
	if logger.lastWarn() == "" {
		t.Fatal("expected a warn line")
	}
}

// ---- Connections/Errors channels + Dropped counters -------------------------------------------

func TestConnectionsChannelReceivesModeTransitions(t *testing.T) {
	client := newLoadedClient(t, `{"K":"v"}`)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	conns := client.Connections(ctx)

	client.handleConnectionModeChange(ModeRealtime, ReasonConnected, time.Now())

	select {
	case e := <-conns:
		if e.Mode != ModeRealtime {
			t.Fatalf("unexpected event: %+v", e)
		}
	case <-time.After(time.Second):
		t.Fatal("expected a connection event")
	}
	if client.ConnectionsDropped() != 0 {
		t.Fatalf("expected 0 drops, got %d", client.ConnectionsDropped())
	}
}

func TestChangesDroppedCountsAFullBuffer(t *testing.T) {
	client := newLoadedClient(t, `{"K":"v0"}`, WithLogger(newCapturingLogger()))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_ = client.Changes(ctx) // never drained — will fill up and start dropping

	// Fire more change events than the buffer (16) can hold.
	for i := 0; i < subscriberBufferSize+5; i++ {
		client.dispatchChange(ChangeEvent{ChangedKeys: []string{"K"}})
	}
	if client.ChangesDropped() == 0 {
		t.Fatal("expected ChangesDropped() > 0")
	}
}

func TestErrorsDroppedCountsAFullBufferAndConnectionsDispatchWarns(t *testing.T) {
	logger := newCapturingLogger()
	client := newLoadedClient(t, `{"K":"v0"}`, WithLogger(logger))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_ = client.Errors(ctx)
	_ = client.Connections(ctx)

	for i := 0; i < subscriberBufferSize+5; i++ {
		client.dispatchError(errors.New("boom"))
		client.dispatchConnection(ConnectionEvent{Mode: ModePolling})
	}
	if client.ErrorsDropped() == 0 {
		t.Fatal("expected ErrorsDropped() > 0")
	}
	if client.ConnectionsDropped() == 0 {
		t.Fatal("expected ConnectionsDropped() > 0")
	}
}

// ---- errors.go sentinel Is() coverage for all 4 classes ---------------------------------------

func TestAllFourErrorClassesSatisfyTheirOwnSentinel(t *testing.T) {
	cases := []struct {
		err      error
		sentinel error
	}{
		{newAuthenticationError("x"), ErrAuthentication},
		{newNetworkError("x"), ErrNetwork},
		{newMissingKeyError("K"), ErrMissingKey},
		{newTypeMismatchError("K", "integer", "x"), ErrTypeMismatch},
	}
	for _, c := range cases {
		if !errors.Is(c.err, c.sentinel) {
			t.Fatalf("%T does not satisfy errors.Is against its own sentinel", c.err)
		}
		var envpitErr EnvpitError
		if !errors.As(c.err, &envpitErr) {
			t.Fatalf("%T does not satisfy the EnvpitError interface", c.err)
		}
	}
}

// ---- default slog-backed Logger ---------------------------------------------------------------

func TestDefaultSlogLoggerImplementsAllFourLevelsWithoutPanicking(t *testing.T) {
	l := newSlogLogger(slog.Default())
	l.Debug("debug line")
	l.Info("info line")
	l.Warn("warn line")
	l.Error("error line")
}

func TestNewClientDefaultsToASlogBackedLoggerWhenWithLoggerIsNeverCalled(t *testing.T) {
	// No WithLogger call at all — must default to a visible-by-default slog logger (Uma
	// SPEC-envpit-0t2z-3-1b-ux.md §3.2), not silence, and must not panic during construction.
	rt := &fakeTransport{configFn: fetchQueue(t, `{"K":"v"}`)}
	client, err := NewClient(context.Background(), WithAPIKey("epk_test"), WithPollInterval(0), WithHTTPClient(fakeHTTPClient(rt)))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if client.logger == nil {
		t.Fatal("expected a non-nil default logger")
	}
}

// ---- sse_parser default cap ---------------------------------------------------------------

func TestNewSSEFrameParserDefaultsMaxLineBytesWhenNonPositive(t *testing.T) {
	p := newSSEFrameParser(0)
	if p.maxLineBytes != defaultMaxSSELineBytes {
		t.Fatalf("expected default cap %d, got %d", defaultMaxSSELineBytes, p.maxLineBytes)
	}
	p2 := newSSEFrameParser(-5)
	if p2.maxLineBytes != defaultMaxSSELineBytes {
		t.Fatalf("expected default cap %d, got %d", defaultMaxSSELineBytes, p2.maxLineBytes)
	}
}

// ---- package-level sugar: remaining getters + subscribe delegation ----------------------------

func TestPackageLevelRemainingSugarDelegates(t *testing.T) {
	Close()
	defer Close()

	rt := &fakeTransport{configFn: fetchQueue(t, `{"PORT":"8080","FLAG":"true"}`)}
	if _, err := Load(context.Background(), WithAPIKey("epk_test"), WithPollInterval(0),
		WithHTTPClient(fakeHTTPClient(rt)), WithLogger(nil)); err != nil {
		t.Fatal(err)
	}

	if got, err := GetInt("PORT"); err != nil || got != 8080 {
		t.Fatalf("GetInt = %d, %v", got, err)
	}
	if got := GetIntOr("MISSING", 1); got != 1 {
		t.Fatalf("GetIntOr = %d, want 1", got)
	}
	if got, err := GetBool("FLAG"); err != nil || !got {
		t.Fatalf("GetBool = %v, %v", got, err)
	}
	if got := GetBoolOr("MISSING", true); !got {
		t.Fatal("GetBoolOr should return the default")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_ = Changes(ctx)
	_ = Connections(ctx)
	_ = Errors(ctx)
}
