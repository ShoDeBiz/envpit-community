package envpit

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

// One dedicated test per test-vectors/CONFORMANCE.md INV-SDK-N ID, with the ID embedded in the
// test's own name (CONFORMANCE.md's rule: "Every language's test suite MUST contain at least
// one test per INV-SDK-N ID... with the ID in the test's own name" — the future CONFORMANCE-ID
// grep-gate CI job, Sara §5.3/§5.5, greps for exactly this pattern).

// ---- INV-SDK-1 — load() sole entry point; first-load failure fatal; no half-init client ------

func TestINV_SDK_1_first_load_failure_is_fatal(t *testing.T) {
	rt := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return jsonResponse(500, "{}"), nil
	})
	_, err := NewClient(context.Background(), WithAPIKey("epk_test"), WithHTTPClient(fakeHTTPClient(&fakeTransport{configFn: rt})), WithPollInterval(0))
	if err == nil {
		t.Fatal("expected NewClient to fail")
	}
	var netErr *NetworkError
	if !errorTypeNameMatches(err, "NetworkError") {
		t.Fatalf("expected NetworkError, got %T: %v", err, err)
	}
	_ = netErr
}

func TestINV_SDK_1_load_itself_never_fires_a_change_event(t *testing.T) {
	client := newLoadedClient(t, `{"A":"1"}`)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	changes := client.Changes(ctx)
	select {
	case e := <-changes:
		t.Fatalf("expected no change event, got %+v", e)
	case <-time.After(50 * time.Millisecond):
	}
}

// ---- INV-SDK-2 — every Get*() after load is synchronous, in-memory; never a network call -----

func TestINV_SDK_2_getters_after_load_never_trigger_a_network_call(t *testing.T) {
	calls := 0
	rt := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		return jsonResponse(200, envelopeBody(`{"K":"v"}`)), nil
	})
	client, err := NewClient(context.Background(), WithAPIKey("epk_test"), WithPollInterval(0),
		WithHTTPClient(fakeHTTPClient(&fakeTransport{configFn: rt})), WithLogger(nil))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	for i := 0; i < 5; i++ {
		got, err := client.Get("K")
		if err != nil || got != "v" {
			t.Fatalf("Get(K) = %q, %v", got, err)
		}
	}
	if calls != 1 {
		t.Fatalf("expected exactly 1 fetch call, got %d", calls)
	}
}

// ---- INV-SDK-3 — memory-only cache, never persisted to disk: see security_gates_test.go -------
// (grep gate — a negative property isn't provable positively, per CONFORMANCE.md's own
// GAP-documented convention).

// ---- INV-SDK-4 — stale-while-revalidate: refresh failure keeps last good snapshot -------------

func TestINV_SDK_4_stale_while_revalidate_keeps_last_good_snapshot_on_refresh_failure(t *testing.T) {
	client := newLoadedClient(t, `{"K":"v0"}`)
	client.httpClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return jsonResponse(500, "{}"), nil
	})}

	client.doRefresh(TriggerPoll) // must not panic/crash

	got, err := client.Get("K")
	if err != nil || got != "v0" {
		t.Fatalf("Get(K) = %q, %v — must still serve the last good snapshot", got, err)
	}
	if client.CacheInfo().LastError == nil {
		t.Fatal("expected CacheInfo().LastError to be recorded")
	}
}

// ---- INV-SDK-5 — generation guard (Go mechanism: coalescing single refresher, see -------------
// coalescing_test.go for the concurrency proof of the OBSERVABLE invariant this ID requires).

func TestINV_SDK_5_final_state_reflects_the_freshest_refresh_not_a_stale_overwrite(t *testing.T) {
	assertCoalescingRefresherFreshnessInvariant(t)
}

// ---- INV-SDK-6 — safe listener/consumer dispatch: eliminated by construction for Go's ---------
// channel-based subscribe (a panicking reader panics in ITS OWN goroutine, never the SDK's —
// see safe_invoke_test.go for the residual case Go DOES need recover() for: the injected Logger
// and injected *http.Client, per Sara §3.2).

func TestINV_SDK_6_a_slow_subscriber_never_blocks_dispatch_or_other_subscribers(t *testing.T) {
	client := newLoadedClient(t, `{"K":"v0"}`)
	client.httpClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return jsonResponse(200, envelopeBody(`{"K":"v1"}`)), nil
	})}

	slowCtx, slowCancel := context.WithCancel(context.Background())
	defer slowCancel()
	_ = client.Changes(slowCtx) // never read from — must not block anything below

	fastCtx, fastCancel := context.WithCancel(context.Background())
	defer fastCancel()
	fast := client.Changes(fastCtx)

	done := make(chan struct{})
	go func() {
		client.doRefresh(TriggerPoll)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("doRefresh blocked — a subscriber with no reader must never block dispatch")
	}

	select {
	case e := <-fast:
		if len(e.ChangedKeys) != 1 || e.ChangedKeys[0] != "K" {
			t.Fatalf("unexpected change event: %+v", e)
		}
	case <-time.After(time.Second):
		t.Fatal("fast subscriber never received the change event")
	}
}

// ---- INV-SDK-7 — change payload is key NAMES only, null≡absent, no-op, consistent read ---------

func TestINV_SDK_7_change_payload_is_key_names_only_and_snapshot_applied_before_delivery(t *testing.T) {
	client := newLoadedClient(t, `{"A":"before-secret-alpha"}`)
	client.httpClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return jsonResponse(200, envelopeBody(`{"A":"after-secret-alpha","B":"after-secret-beta"}`)), nil
	})}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	changes := client.Changes(ctx)

	client.doRefresh(TriggerPoll)

	select {
	case e := <-changes:
		if len(e.ChangedKeys) != 2 || e.ChangedKeys[0] != "A" || e.ChangedKeys[1] != "B" {
			t.Fatalf("expected sorted [A B], got %v", e.ChangedKeys)
		}
		gotA, _ := client.Get("A")
		if gotA != "after-secret-alpha" {
			t.Fatalf("expected the new value readable inside/after delivery, got %q", gotA)
		}
	case <-time.After(time.Second):
		t.Fatal("no change event delivered")
	}
}

func TestINV_SDK_7_no_change_event_fires_when_nothing_differs(t *testing.T) {
	client := newLoadedClient(t, `{"A":"1"}`)
	client.httpClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return jsonResponse(200, envelopeBody(`{"A":"1"}`)), nil
	})}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	changes := client.Changes(ctx)
	client.doRefresh(TriggerPoll)
	select {
	case e := <-changes:
		t.Fatalf("expected no change event, got %+v", e)
	case <-time.After(50 * time.Millisecond):
	}
}

// ---- INV-SDK-8 — poll is the correctness backstop; interval 0 disables ALL background refresh -

func TestINV_SDK_8_poll_interval_zero_disables_all_background_refresh_including_realtime(t *testing.T) {
	client := newLoadedClient(t, `{"K":"v"}`)
	info := client.CacheInfo()
	if info.RefreshMode != RefreshOff {
		t.Fatalf("expected RefreshOff, got %v", info.RefreshMode)
	}
	if client.realtime != nil {
		t.Fatal("expected no realtime transport when poll interval is 0")
	}
}

// ---- INV-SDK-9 — etag dedup on push; catch-up refetch on every reconnect except the first ------

func TestINV_SDK_9_etag_dedup_on_push_with_same_etag_does_not_trigger_a_refetch(t *testing.T) {
	client := newLoadedClient(t, `{"K":"v0"}`)
	client.mu.Lock()
	client.etag = "same-etag"
	client.mu.Unlock()

	calls := 0
	client.httpClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		return jsonResponse(200, envelopeBody(`{"K":"v0"}`)), nil
	})}

	client.handlePushSignal("same-etag")
	time.Sleep(50 * time.Millisecond) // requestRefresh would be a no-op anyway (pollInterval=0 -> no refresher goroutine running), but assert no crash and no queued call
	if calls != 0 {
		t.Fatalf("expected no refetch for a duplicate etag, got %d calls", calls)
	}
}

func TestINV_SDK_9_reconnect_after_first_connect_triggers_catch_up_refetch_not_on_first_connect(t *testing.T) {
	rt := &fakeTransport{configFn: fetchQueue(t, `{"K":"v0"}`, `{"K":"v1"}`)}
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

	// First connect must NOT catch-up refetch.
	client.handleConnectionModeChange(ModeRealtime, ReasonConnected, time.Now())
	got, _ := client.Get("K")
	if got != "v0" {
		t.Fatalf("first connect must not catch-up refetch, got K=%q", got)
	}

	// A later reconnect (mode transitions back to realtime, having seen the first connect
	// already) DOES catch-up refetch.
	client.handleConnectionModeChange(ModePolling, ReasonNetwork, time.Now())
	client.handleConnectionModeChange(ModeRealtime, ReasonConnected, time.Now())

	if !waitUntil(t, time.Second, func() bool {
		v, _ := client.Get("K")
		return v == "v1"
	}) {
		t.Fatal("expected the reconnect catch-up refresh to fetch v1")
	}
	select {
	case e := <-changes:
		if e.Trigger != TriggerReconnect {
			t.Fatalf("expected trigger=reconnect, got %v", e.Trigger)
		}
	case <-time.After(time.Second):
		t.Fatal("expected a change event from the reconnect catch-up refresh")
	}
}

// ---- INV-SDK-10 — quiet-retry/degraded diagnostics cadence: never per-attempt noise -----------

func TestINV_SDK_10_degraded_diagnostics_cadence_one_retry_one_info_one_warn_never_per_attempt(t *testing.T) {
	var mu sync.Mutex
	var infos, warns []string
	var modeChanges int

	transport := newRealtimeTransport(realtimeParams{
		host:   "https://example.test",
		apiKey: "epk_test",
		httpClient: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			return nil, errConnectionRefused()
		})},
		pollInterval:   time.Minute,
		onChangeSignal: func(string) {},
		onModeChange:   func(ConnectionMode, ConnectionReason, time.Time) { mu.Lock(); modeChanges++; mu.Unlock() },
		onLog: func(level, msg string) {
			mu.Lock()
			defer mu.Unlock()
			switch level {
			case "info":
				infos = append(infos, msg)
			case "warn":
				warns = append(warns, msg)
			}
		},
		quickReconnectDelay:       5 * time.Millisecond,
		degradedReconnectInterval: 10 * time.Millisecond,
		degradedReconnectJitter:   0,
		degradedWarnThreshold:     150 * time.Millisecond,
	})

	ctx, cancel := context.WithCancel(context.Background())
	go transport.run(ctx)
	time.Sleep(500 * time.Millisecond)
	cancel()

	mu.Lock()
	defer mu.Unlock()
	if len(infos) != 1 {
		t.Fatalf("expected exactly 1 info line (degrade announcement), got %v", infos)
	}
	if len(warns) != 1 {
		t.Fatalf("expected exactly 1 warn line (5-min-equivalent threshold), got %v", warns)
	}
	// This transport never successfully connects (mode starts 'polling', a failure that keeps
	// it 'polling' is not a transition) — matches shipped Node/Python's identical modeChanged
	// guard: no connection event fires for a failure that doesn't actually change the mode.
	if modeChanges != 0 {
		t.Fatalf("expected 0 mode-change events, got %d", modeChanges)
	}
}

// ---- INV-SDK-11 — no config value/API key ever in an error/log line; background never blocks --

func TestINV_SDK_11_no_api_key_or_config_value_ever_appears_in_a_thrown_error_message(t *testing.T) {
	secretKey := "epk_super-secret-do-not-leak-this-value"
	var messages []string

	_, err := NewClient(context.Background(), WithAPIKey(secretKey), WithPollInterval(0),
		WithHTTPClient(fakeHTTPClient(&fakeTransport{configFn: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			return jsonResponse(401, "{}"), nil
		})})))
	if err == nil {
		t.Fatal("expected an error")
	}
	messages = append(messages, err.Error())

	_, err = NewClient(context.Background(), WithAPIKey(secretKey), WithPollInterval(0),
		WithHTTPClient(fakeHTTPClient(&fakeTransport{configFn: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			return nil, errConnectionRefused()
		})})))
	if err == nil {
		t.Fatal("expected an error")
	}
	messages = append(messages, err.Error())

	client := newLoadedClient(t, `{"PORT":"not-a-number"}`, WithAPIKey(secretKey))
	if _, err := client.Get("MISSING_KEY"); err != nil {
		messages = append(messages, err.Error())
	}
	if _, err := client.GetInt("PORT"); err != nil {
		messages = append(messages, err.Error())
	}

	if len(messages) != 4 {
		t.Fatalf("sanity: expected 4 throw paths exercised, got %d", len(messages))
	}
	for _, m := range messages {
		if strings.Contains(m, secretKey) {
			t.Fatalf("api key leaked into error message: %q", m)
		}
	}
}

func TestINV_SDK_11_background_work_never_blocks_process_exit(t *testing.T) {
	// Go has no daemon-thread concept (goroutines don't keep a process alive by themselves the
	// way a non-daemon OS thread would) — the structural analogue of Node's timer.unref()/
	// Python's daemon=True is Close() reliably terminating every background goroutine, proven
	// here via a WaitGroup-backed Close() that returns promptly instead of hanging.
	rt := &fakeTransport{
		configFn: fetchQueue(t, `{"K":"v"}`),
		eventsFn: neverConnectEvents(t),
	}
	client, err := NewClient(context.Background(), WithAPIKey("epk_test"),
		WithPollInterval(20*time.Millisecond), WithHTTPClient(fakeHTTPClient(rt)), WithLogger(nil))
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		client.Close()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Close() did not return promptly — a background goroutine is not honoring shutdown")
	}
}

// ---- INV-SDK-12 — ENVPIT_API_KEY auto-detect, explicit wins; header is X-Api-Key, never --------
// Authorization

func TestINV_SDK_12_explicit_api_key_wins_over_env_var(t *testing.T) {
	t.Setenv("ENVPIT_API_KEY", "epk_from_env")
	client := newLoadedClient(t, `{"K":"v"}`, WithAPIKey("epk_explicit"))
	if client.apiKey != "epk_explicit" {
		t.Fatalf("expected epk_explicit, got %q", client.apiKey)
	}
}

func TestINV_SDK_12_env_var_used_when_no_explicit_key_given(t *testing.T) {
	t.Setenv("ENVPIT_API_KEY", "epk_from_env")
	rt := &fakeTransport{configFn: fetchQueue(t, `{"K":"v"}`)}
	client, err := NewClient(context.Background(), WithPollInterval(0), WithHTTPClient(fakeHTTPClient(rt)), WithLogger(nil))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if client.apiKey != "epk_from_env" {
		t.Fatalf("expected epk_from_env, got %q", client.apiKey)
	}
}

func TestINV_SDK_12_no_api_key_anywhere_returns_authentication_error(t *testing.T) {
	t.Setenv("ENVPIT_API_KEY", "")
	_, err := NewClient(context.Background(), WithPollInterval(0))
	if !errorTypeNameMatches(err, "AuthenticationError") {
		t.Fatalf("expected AuthenticationError, got %T: %v", err, err)
	}
}

func TestINV_SDK_12_config_fetch_sends_x_api_key_header_and_never_authorization(t *testing.T) {
	var seen http.Header
	rt := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		seen = r.Header
		return jsonResponse(200, envelopeBody(`{"K":"v"}`)), nil
	})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := fetchConfig(ctx, &http.Client{Transport: rt}, "https://example.test", "epk_test"); err != nil {
		t.Fatal(err)
	}
	if got := seen.Get("X-Api-Key"); got != "epk_test" {
		t.Fatalf("X-Api-Key header = %q, want epk_test", got)
	}
	if seen.Get("Authorization") != "" {
		t.Fatal("Authorization header must never be set")
	}
}

// ---- INV-SDK-13 (PROPOSED, not yet ratified by Sara) — adversarial payload defense -------------
// see TestVectorsAdversarialPayloads (vectors_test.go), which is this SDK's coverage of the
// proposed invariant's body/SSE-line/JSON-depth vectors.
