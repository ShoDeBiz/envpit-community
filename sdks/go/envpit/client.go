package envpit

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	trueValues     = map[string]bool{"true": true, "1": true, "yes": true, "on": true}
	falseValues    = map[string]bool{"false": true, "0": true, "no": true, "off": true}
	integerPattern = regexp.MustCompile(`^-?\d+$`)
)

// subscriberBufferSize — per-subscriber buffered channel capacity (Sara §3.2/ADR-S3-04): a
// slow/abandoned consumer must never block the SDK's dispatch path. Non-blocking send; on full,
// the event is dropped (state is always current via Get*, so a dropped notification self-heals
// exactly like a missed SSE frame does — the poll backstop, INV-SDK-8).
const subscriberBufferSize = 16

// Client is the SDK's core, instantiated client (Sara §2.2: "the instantiated client is the
// primitive in every language"). Construct one with NewClient or the package-level Load sugar.
type Client struct {
	apiKey       string
	host         string
	pollInterval time.Duration
	timeout      time.Duration
	httpClient   *http.Client
	logger       Logger

	ctx    context.Context
	cancel context.CancelFunc

	mu       sync.RWMutex
	snapshot ConfigSnapshot
	// secretKeys are the key NAMES (never values) the CURRENTLY-LOADED snapshot's fetch flagged
	// is_secret=true (bd:envpit-durd) — read by MergeIntoEnv (env.go) and exposed read-only via
	// SecretKeys() below. Updated alongside snapshot on every successful load/refresh; left
	// untouched (stale-while-revalidate, INV-SDK-4) on a failed background refresh, same as
	// snapshot itself.
	secretKeys       []string
	fetchedAt        time.Time
	lastErr          error
	etag             string
	lastChangeAt     time.Time
	refreshMode      RefreshMode
	realtimeSince    time.Time
	sawFirstRealtime bool

	// Coalescing single-refresher goroutine (Sara §4, ADR-S3-06): every background refresh
	// (poll tick / push signal / reconnect catch-up) funnels through ONE goroutine consuming
	// triggerCh (buffer 1). A trigger arriving while a refresh is already in flight fills the
	// one buffered slot — the buffered slot itself IS the "run once more after the current run
	// finishes" rerun flag; a second concurrent trigger on top of that hits the channel's
	// non-blocking-send default case and is coalesced into a no-op (the pending slot already
	// guarantees a catch-up run). At most one HTTP request is ever in flight, which makes
	// out-of-order-refresh resolution impossible BY CONSTRUCTION rather than guarded by a
	// generation counter (Node/Python's mechanism) — see doRefresh/runRefresher below.
	triggerCh chan triggerMsg

	changeSubs *subRegistry[ChangeEvent]
	connSubs   *subRegistry[ConnectionEvent]
	errSubs    *subRegistry[error]

	realtime *realtimeTransport

	closeOnce       sync.Once
	wg              sync.WaitGroup
	loggerPanicOnce sync.Once
}

type triggerMsg struct {
	trigger ChangeTrigger
}

// String / GoString — AC-SEC-SDK3-1: Go leaks struct contents (including unexported fields) via
// %v/%+v/%#v reflection-based formatting by DEFAULT unless a type overrides these. Client holds
// both the API key and the config snapshot — the two highest-value leak targets in the whole
// SDK — so both verbs are covered explicitly.
func (c *Client) String() string {
	c.mu.RLock()
	keys := len(c.snapshot)
	c.mu.RUnlock()
	return fmt.Sprintf("envpit.Client(host=%q, keys=%d, apiKey=<redacted>)", c.host, keys)
}

func (c *Client) GoString() string { return c.String() }

// NewClient is the SDK's core constructor (Sara §2.2: "wraps envpit.NewClient... functional
// options"). Fetches the environment's config once (returns an error on failure — no cache
// exists yet to fall back to — INV-SDK-1: first-load failure is fatal, no half-initialized
// client is ever returned) and — unless the poll interval is 0 — starts the background poll
// goroutine AND the realtime (SSE) connection goroutine. ctx bounds/cancels only the initial
// synchronous fetch; once NewClient returns, background work runs until Close() (independent of
// ctx's own lifetime — a request-scoped ctx passed here must not silently kill a
// longer-lived client's background refresh).
//
// Prefer the package-level Load sugar for the common single-client case; use NewClient directly
// when your program needs more than one independent client (e.g. multiple projects/environments
// — see the package examples).
func NewClient(ctx context.Context, opts ...Option) (*Client, error) {
	cfg := defaultConfig()
	for _, opt := range opts {
		opt(cfg)
	}

	apiKey := cfg.apiKey
	if apiKey == "" {
		apiKey = os.Getenv("ENVPIT_API_KEY")
	}
	if apiKey == "" {
		return nil, newAuthenticationError(
			"envpit: no API key found — set the ENVPIT_API_KEY environment variable, or pass envpit.WithAPIKey(...) to Load")
	}

	logger := cfg.logger
	if !cfg.loggerSet {
		logger = newSlogLogger(slog.Default())
	}

	c := &Client{
		apiKey:       apiKey,
		host:         strings.TrimRight(cfg.host, "/"),
		pollInterval: cfg.pollInterval,
		timeout:      cfg.timeout,
		httpClient:   cfg.httpClient,
		logger:       logger,
		changeSubs:   newSubRegistry[ChangeEvent](),
		connSubs:     newSubRegistry[ConnectionEvent](),
		errSubs:      newSubRegistry[error](),
		triggerCh:    make(chan triggerMsg, 1),
	}
	c.ctx, c.cancel = context.WithCancel(context.Background())
	if c.pollInterval > 0 {
		c.refreshMode = RefreshPolling
	} else {
		c.refreshMode = RefreshOff
	}

	// First load: synchronous, on the calling goroutine. No concurrent trigger source exists yet
	// (the poll goroutine and realtime transport haven't started), so this is trivially safe
	// without going through the coalescing channel — and it must be synchronous so NewClient
	// only ever returns a fully-initialized client or an error (INV-SDK-1).
	firstCtx, firstCancel := context.WithTimeout(ctx, c.timeout)
	result, err := c.doFetch(firstCtx)
	firstCancel()
	if err != nil {
		c.cancel()
		return nil, err
	}

	c.mu.Lock()
	c.snapshot = result.snapshot
	c.secretKeys = result.secretKeys
	c.fetchedAt = time.Now()
	c.etag = result.etag
	c.mu.Unlock()

	if c.pollInterval > 0 {
		c.wg.Add(2)
		go c.pollLoop()
		go c.runRefresher()

		c.realtime = newRealtimeTransport(realtimeParams{
			host:           c.host,
			apiKey:         c.apiKey,
			httpClient:     c.httpClient,
			pollInterval:   c.pollInterval,
			onChangeSignal: c.handlePushSignal,
			onModeChange:   c.handleConnectionModeChange,
			onLog:          c.safeLog,
		})
		c.wg.Add(1)
		go func() {
			defer c.wg.Done()
			c.realtime.run(c.ctx)
		}()
	}

	return c, nil
}

// Close stops the background poll goroutine AND the realtime (SSE) connection, and closes every
// still-open Changes/Connections/Errors channel. Idempotent. The last snapshot remains valid to
// read (Get* on a closed client still returns the last known values — Close only stops future
// background refresh and notification delivery).
func (c *Client) Close() {
	c.closeOnce.Do(func() {
		c.cancel() // aborts any in-flight HTTP request (config fetch or SSE connection) promptly
		c.wg.Wait()
		c.changeSubs.closeAll()
		c.connSubs.closeAll()
		c.errSubs.closeAll()
	})
}

// ---- getters --------------------------------------------------------------

// Get reads a raw string value. Returns *MissingKeyError if the key is absent/null and no
// default is desired — use GetOr for a default-taking variant.
func (c *Client) Get(key string) (string, error) {
	raw, ok := c.readRaw(key)
	if !ok {
		return "", newMissingKeyError(key)
	}
	return raw, nil
}

// GetOr reads a raw string value, returning def if the key is absent/null.
func (c *Client) GetOr(key, def string) string {
	raw, ok := c.readRaw(key)
	if !ok {
		return def
	}
	return raw
}

// GetInt parses the value as a base-10 integer. Returns *MissingKeyError if absent, or
// *TypeMismatchError if it isn't a valid integer.
func (c *Client) GetInt(key string) (int, error) {
	raw, ok := c.readRaw(key)
	if !ok {
		return 0, newMissingKeyError(key)
	}
	trimmed := strings.TrimSpace(raw)
	if !integerPattern.MatchString(trimmed) {
		return 0, newTypeMismatchError(key, "integer", raw)
	}
	n, err := strconv.Atoi(trimmed)
	if err != nil {
		return 0, newTypeMismatchError(key, "integer", raw)
	}
	return n, nil
}

// GetIntOr parses the value as a base-10 integer, returning def if the key is absent/null.
//
// Go-only semantic (Sara §2.2/R4, encoded as an explicit vector row rather than silent drift):
// a PRESENT-but-unparsable value does NOT silently return def as if it were merely missing —
// Node/Python's default-on-missing-only rule still applies (an unparsable value is a real data
// problem, not an absent one). Instead def is returned AND the fallback is reported once,
// value-free (Sentinel AC-SEC-SDK3-6), via the logger and the Errors(ctx) channel — the caller
// is never silently handed a value that doesn't match what's actually stored.
func (c *Client) GetIntOr(key string, def int) int {
	raw, ok := c.readRaw(key)
	if !ok {
		return def
	}
	trimmed := strings.TrimSpace(raw)
	if !integerPattern.MatchString(trimmed) {
		c.reportOrFallback(key, "integer")
		return def
	}
	n, err := strconv.Atoi(trimmed)
	if err != nil {
		c.reportOrFallback(key, "integer")
		return def
	}
	return n
}

// GetBool parses the value as a boolean (case-insensitive true/false, 1/0, yes/no, on/off).
// Returns *MissingKeyError if absent, or *TypeMismatchError for anything else.
func (c *Client) GetBool(key string) (bool, error) {
	raw, ok := c.readRaw(key)
	if !ok {
		return false, newMissingKeyError(key)
	}
	normalized := strings.ToLower(strings.TrimSpace(raw))
	if trueValues[normalized] {
		return true, nil
	}
	if falseValues[normalized] {
		return false, nil
	}
	return false, newTypeMismatchError(key, "boolean", raw)
}

// GetBoolOr parses the value as a boolean, returning def if the key is absent/null. See
// GetIntOr's doc comment for the Go-only present-but-unparsable-value semantic.
func (c *Client) GetBoolOr(key string, def bool) bool {
	raw, ok := c.readRaw(key)
	if !ok {
		return def
	}
	normalized := strings.ToLower(strings.TrimSpace(raw))
	if trueValues[normalized] {
		return true
	}
	if falseValues[normalized] {
		return false
	}
	c.reportOrFallback(key, "boolean")
	return def
}

func (c *Client) reportOrFallback(key, expectedType string) {
	w := &orFallbackWarning{Key: key, ExpectedType: expectedType}
	c.safeLog("warn", w.Error())
	c.dispatchError(w)
}

func (c *Client) readRaw(key string) (string, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.snapshot == nil {
		// Structurally unreachable via the public API: NewClient/Load never return a client
		// without a successful first fetch. Kept as a defensive guard, not a documented failure
		// mode (mirrors Node/Python's identical "should be unreachable" guard).
		panic("envpit: config not loaded yet — this should be unreachable via envpit.NewClient/envpit.Load")
	}
	v, ok := c.snapshot[key]
	if !ok || v == nil {
		return "", false
	}
	return *v, true
}

// SecretKeys returns the key NAMES (never values) the CURRENTLY-LOADED snapshot's fetch flagged
// is_secret=true (bd:envpit-durd) — a sorted copy, safe to log verbatim, so a caller can write
// their own filter (e.g. against Get*) without re-fetching or re-deriving it from MergeIntoEnv's
// result lists. Empty, never nil, when nothing in the current snapshot is flagged secret.
func (c *Client) SecretKeys() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make([]string, len(c.secretKeys))
	copy(out, c.secretKeys)
	sort.Strings(out)
	return out
}

// CacheInfo returns a point-in-time view of the client's in-memory cache.
func (c *Client) CacheInfo() CacheInfo {
	c.mu.RLock()
	defer c.mu.RUnlock()
	var age time.Duration
	if !c.fetchedAt.IsZero() {
		age = time.Since(c.fetchedAt)
	}
	return CacheInfo{
		FetchedAt:     c.fetchedAt,
		Age:           age,
		LastError:     c.lastErr,
		Etag:          c.etag,
		RefreshMode:   c.refreshMode,
		RealtimeSince: c.realtimeSince,
		LastChangeAt:  c.lastChangeAt,
	}
}

// ---- subscribe (channels, ctx-scoped — no separate unsubscribe function needed) --------------

// Changes returns a channel of ChangeEvent notifications. ctx cancellation IS the unsubscribe
// mechanism — the channel is closed when ctx is done or the client is Closed. A slow or
// abandoned reader never blocks the SDK's dispatch path (AC-GO-01): the channel is buffered
// (cap 16) with a non-blocking send; on a full buffer the event is dropped (config reads are
// unaffected, state is always current via Get* — a dropped notification self-heals exactly like
// a missed SSE frame does) and ChangesDropped() counts every drop.
func (c *Client) Changes(ctx context.Context) <-chan ChangeEvent {
	return c.changeSubs.subscribe(ctx, c.ctx, subscriberBufferSize)
}

// ChangesDropped returns the total number of ChangeEvent notifications dropped so far because a
// subscriber's buffered channel was full (see Changes's doc comment).
func (c *Client) ChangesDropped() int64 { return c.changeSubs.Dropped() }

// Connections returns a channel of ConnectionEvent notifications (realtime channel mode
// transitions only — never one per (re)connect attempt). Same ctx-scoped-unsubscribe and
// drop-on-full semantics as Changes.
func (c *Client) Connections(ctx context.Context) <-chan ConnectionEvent {
	return c.connSubs.subscribe(ctx, c.ctx, subscriberBufferSize)
}

// ConnectionsDropped returns the total number of ConnectionEvent notifications dropped so far.
func (c *Client) ConnectionsDropped() int64 { return c.connSubs.Dropped() }

// Errors returns a channel of background-refresh-failure and Or-family-fallback notifications.
// Same ctx-scoped-unsubscribe and drop-on-full semantics as Changes. Errors delivered here are
// always one of the SDK's own EnvpitError-implementing types or *orFallbackWarning — never a
// raw, unwrapped transport error (the bd:envpit-4dbm-class guarantee: this channel is exactly
// where a mid-connection reset on the background-refresh path must actually surface, not just
// the initial synchronous NewClient/Load call).
func (c *Client) Errors(ctx context.Context) <-chan error {
	return c.errSubs.subscribe(ctx, c.ctx, subscriberBufferSize)
}

// ErrorsDropped returns the total number of error notifications dropped so far.
func (c *Client) ErrorsDropped() int64 { return c.errSubs.Dropped() }

func (c *Client) dispatchChange(e ChangeEvent) {
	c.changeSubs.dispatch(e, func() {
		c.safeLog("warn",
			"envpit: dropped a change notification for a slow subscriber (buffer full) — config reads are unaffected; drain the channel faster or check Client.ChangesDropped()")
	})
}

func (c *Client) dispatchConnection(e ConnectionEvent) {
	c.connSubs.dispatch(e, func() {
		c.safeLog("warn",
			"envpit: dropped a connection notification for a slow subscriber (buffer full) — check Client.ConnectionsDropped()")
	})
}

func (c *Client) dispatchError(err error) {
	c.errSubs.dispatch(err, func() {
		c.safeLog("warn",
			"envpit: dropped an error notification for a slow subscriber (buffer full) — check Client.ErrorsDropped()")
	})
}

// ---- logging (safeInvoke — the SDK's one recover() call site, Sara §3.2) ---------------------

// safeInvoke recovers a panic from fn. This is the SDK's ONE recover() call site (Sara §3.2:
// "wraps those invocations in defer func(){ recover() }()... the only recover() in the SDK, in
// one named function, with a comment citing envpit-r59g"): the two user-supplied interfaces the
// SDK itself invokes (the injected Logger, and the injected *http.Client's RoundTripper via
// WithHTTPClient) must never be able to crash the background refresh/dispatch goroutine.
// User-registered CHANGE/CONNECTION/ERROR handlers are, by contrast, never invoked by the SDK at
// all — the caller ranges over a channel in their own goroutine, so a panic there is the
// caller's own ordinary Go panic with their own ordinary stack trace (Sara §3.2: "eliminated by
// construction" — the strongest argument for channel-idiom over callback-registration in Go).
func safeInvoke(fn func()) (panicked bool) {
	defer func() {
		if r := recover(); r != nil {
			panicked = true
		}
	}()
	fn()
	return false
}

func (c *Client) safeLog(level, message string) {
	if c.logger == nil {
		return
	}
	var fn func(string)
	switch level {
	case "debug":
		fn = c.logger.Debug
	case "info":
		fn = c.logger.Info
	case "warn":
		fn = c.logger.Warn
	case "error":
		fn = c.logger.Error
	default:
		return
	}
	if panicked := safeInvoke(func() { fn(message) }); panicked {
		// Cannot report through the logger that just panicked (Uma SPEC-envpit-0t2z-3-1b-ux.md
		// §3.2: "obviously cannot be reported through the logger that just panicked") — one line
		// direct to stderr, once per process, then suppressed.
		c.loggerPanicOnce.Do(func() {
			fmt.Fprintln(os.Stderr,
				"envpit: the injected logger panicked while handling an SDK log line; further logger panics will be suppressed")
		})
	}
}

// ---- internal refresh machinery (INV-SDK-4/5) --------------------------------------------

func (c *Client) doFetch(ctx context.Context) (fetchResult, error) {
	var result fetchResult
	var fetchErr error
	// safeInvoke: the injected *http.Client's RoundTripper is user-supplied code the SDK
	// invokes directly (Sara §3.2) — a panic there must not crash the refresh goroutine.
	if panicked := safeInvoke(func() {
		result, fetchErr = fetchConfig(ctx, c.httpClient, c.host, c.apiKey)
	}); panicked {
		fetchErr = newNetworkError("envpit: the injected HTTP client panicked while fetching config")
	}
	return result, fetchErr
}

func (c *Client) handlePushSignal(etag string) {
	c.mu.RLock()
	duplicate := c.etag != "" && etag == c.etag
	c.mu.RUnlock()
	if duplicate {
		return
	}
	c.requestRefresh(TriggerPush)
}

func (c *Client) handleConnectionModeChange(mode ConnectionMode, reason ConnectionReason, since time.Time) {
	c.mu.Lock()
	c.refreshMode = RefreshMode(mode)
	if mode == ModeRealtime {
		c.realtimeSince = since
	} else {
		c.realtimeSince = time.Time{}
	}
	sawFirst := c.sawFirstRealtime
	if mode == ModeRealtime {
		c.sawFirstRealtime = true
	}
	c.mu.Unlock()

	c.dispatchConnection(ConnectionEvent{Mode: mode, Since: since, Reason: reason})

	// Self-healing catch-up: refetch whenever the channel (re)connects, in case a change was
	// missed while it was down. Skipped on the very first realtime connect right after load —
	// that data is already fresh, and firing it there would just be a wasted duplicate of the
	// bootstrap fetch (INV-SDK-9).
	if mode == ModeRealtime && sawFirst {
		c.requestRefresh(TriggerReconnect)
	}
}

// requestRefresh signals the coalescing refresher goroutine — see triggerCh's doc comment on
// Client.
func (c *Client) requestRefresh(trigger ChangeTrigger) {
	select {
	case <-c.ctx.Done():
		return
	default:
	}
	select {
	case c.triggerCh <- triggerMsg{trigger: trigger}:
	default:
		// A trigger is already pending (buffer full) — coalesced: the refresher goroutine will
		// run a catch-up refresh anyway once it drains the pending slot.
	}
}

func (c *Client) pollLoop() {
	defer c.wg.Done()
	ticker := time.NewTicker(c.pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-c.ctx.Done():
			return
		case <-ticker.C:
			c.requestRefresh(TriggerPoll)
		}
	}
}

// runRefresher is the SDK's ONE refresher goroutine (Sara §4/ADR-S3-06). At most one HTTP
// request is ever in flight for this client's background refresh, which makes out-of-order
// resolution structurally impossible — no generation counter is needed (contrast Node/Python's
// counter-and-lock mechanism, which this design deliberately does NOT literally port; see
// test-vectors/CONFORMANCE.md INV-SDK-5's note that the conformance requirement is the
// OBSERVABLE invariant, not the mechanism).
func (c *Client) runRefresher() {
	defer c.wg.Done()
	for {
		select {
		case <-c.ctx.Done():
			return
		case msg := <-c.triggerCh:
			c.doRefresh(msg.trigger)
		}
	}
}

func (c *Client) doRefresh(trigger ChangeTrigger) {
	ctx, cancel := context.WithTimeout(c.ctx, c.timeout)
	result, fetchErr := c.doFetch(ctx)
	cancel()

	if fetchErr != nil {
		c.mu.Lock()
		c.lastErr = fetchErr
		c.mu.Unlock()
		// Stale-while-revalidate (INV-SDK-4): a background refresh failure never propagates as
		// an error return here (this function's caller is the refresher loop, not a caller
		// awaiting NewClient/Load) — it's recorded on CacheInfo, logged, and surfaced on
		// Errors(ctx) if it's one of the SDK's own typed errors (always true for fetchErr here —
		// bd:envpit-4dbm class: every transport failure, including a mid-connection reset, is
		// mapped to *NetworkError before it ever reaches this point, so it never escapes
		// unwrapped and this isEnvpitError check always succeeds for a real fetch failure).
		c.safeLog("warn", fmt.Sprintf(
			"envpit: background config refresh failed: %s — serving last known values", fetchErr.Error()))
		if envpitErr, ok := fetchErr.(EnvpitError); ok {
			c.dispatchError(envpitErr)
		} else {
			c.dispatchError(fetchErr)
		}
		return
	}

	c.mu.Lock()
	previous := c.snapshot
	c.snapshot = result.snapshot
	c.secretKeys = result.secretKeys
	c.fetchedAt = time.Now()
	c.lastErr = nil
	c.etag = result.etag
	c.mu.Unlock()

	if previous != nil {
		changed := diffSnapshots(previous, result.snapshot)
		if len(changed) > 0 {
			receivedAt := time.Now()
			c.mu.Lock()
			c.lastChangeAt = receivedAt
			c.mu.Unlock()
			c.dispatchChange(ChangeEvent{
				ChangedKeys: changed,
				Etag:        result.etag,
				ReceivedAt:  receivedAt,
				Trigger:     trigger,
			})
		}
	}
}

// diffSnapshots computes changed key NAMES between two in-memory snapshots — never sent over
// the wire, and never includes values (log-safe by construction, INV-SDK-7). A key absent from a
// snapshot and a key present-with-nil are treated identically ("unset"), matching readRaw's own
// missing-vs-null equivalence.
func diffSnapshots(previous, next ConfigSnapshot) []string {
	seen := make(map[string]struct{}, len(previous)+len(next))
	for k := range previous {
		seen[k] = struct{}{}
	}
	for k := range next {
		seen[k] = struct{}{}
	}
	var changed []string
	for key := range seen {
		pv, pok := previous[key]
		nv, nok := next[key]
		pMissing := !pok || pv == nil
		nMissing := !nok || nv == nil
		switch {
		case pMissing && nMissing:
			// both unset — no change
		case pMissing != nMissing:
			changed = append(changed, key)
		case *pv != *nv:
			changed = append(changed, key)
		}
	}
	sort.Strings(changed)
	return changed
}
