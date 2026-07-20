package envpit

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"sync"
	"time"
)

// configEventsPath — GET {host}/api/v1/config/events, mirroring transport.go's configPath. Auth
// via X-Api-Key; project+environment inferred server-side from the key.
const configEventsPath = "/api/v1/config/events"

// The SSE event: name for a real config change, and for the server force-closing a stream
// deliberately (max-lifetime rotation, SIGTERM, revocation sweep). Any OTHER event name (e.g. a
// future flags-changed frame) is intentionally ignored — forward-compatible, out of this SDK
// slice's scope.
const (
	configChangedEventName = "config-changed"
	reconnectEventName     = "reconnect"
)

// Cadence constants — one silent, immediate retry after ANY disconnect before this transport
// "announces" degraded mode; then a degraded/backoff loop with the diagnostics cadence
// INV-SDK-10 specifies (one info on degrade, one warn after 5 min, one info on restore — never a
// line per failed attempt). Mirrors the shipped Node/Python RealtimeTransport 1:1.
const (
	defaultQuickReconnectDelay       = 1 * time.Second
	defaultDegradedReconnectInterval = 10 * time.Second
	defaultDegradedReconnectJitter   = 2 * time.Second
	defaultDegradedWarnThreshold     = 5 * time.Minute
)

const sseReadChunkBytes = 4096

type realtimeParams struct {
	host           string
	apiKey         string
	httpClient     *http.Client
	pollInterval   time.Duration
	maxLineBytes   int
	onChangeSignal func(etag string)
	onModeChange   func(mode ConnectionMode, reason ConnectionReason, since time.Time)
	onLog          func(level, message string)

	// Test-only timing overrides — zero value means "use the package default constant above".
	quickReconnectDelay       time.Duration
	degradedReconnectInterval time.Duration
	degradedReconnectJitter   time.Duration
	degradedWarnThreshold     time.Duration
}

// realtimeTransport manages exactly one logical realtime (SSE) connection to
// GET .../config/events, with transparent reconnection. EnvpitClient owns deciding WHAT to do
// with a change signal or a mode change (the callbacks in realtimeParams); this type owns the
// connection lifecycle only — Go port of the shipped Node/Python RealtimeTransport.
//
// Platform note (deliberate, matching the shipped Python SDK's own call-out): net/http's
// response body is always a streamable io.ReadCloser in every environment this SDK targets —
// there is no Go analog of Node's "this runtime's fetch returned a non-streamable body"
// structural-unsupported case, so ReasonUnsupported is never produced here (kept in the
// ConnectionReason enum only for cross-SDK type parity).
type realtimeTransport struct {
	params realtimeParams

	mu                       sync.Mutex
	mode                     ConnectionMode
	degradedSince            time.Time
	warnedThisEpisode        bool
	quickRetryUsedForEpisode bool
	expectingServerReconnect bool
	warnTimer                *time.Timer
	nextDelay                time.Duration
}

func newRealtimeTransport(p realtimeParams) *realtimeTransport {
	if p.quickReconnectDelay <= 0 {
		p.quickReconnectDelay = defaultQuickReconnectDelay
	}
	if p.degradedReconnectInterval <= 0 {
		p.degradedReconnectInterval = defaultDegradedReconnectInterval
	}
	if p.degradedWarnThreshold <= 0 {
		p.degradedWarnThreshold = defaultDegradedWarnThreshold
	}
	// degradedReconnectJitter's zero value IS a valid choice (deterministic tests) — no default
	// substitution.
	return &realtimeTransport{params: p, mode: ModePolling}
}

// AC-SEC-SDK3-1: this type holds the API key — redact it from every default formatter.
func (t *realtimeTransport) String() string {
	return fmt.Sprintf("envpit.realtimeTransport(host=%q, apiKey=<redacted>)", t.params.host)
}

func (t *realtimeTransport) GoString() string { return t.String() }

// run drives the connect/pump/reconnect loop for the transport's entire lifetime, until ctx is
// done (the client's own lifecycle context — cancelled only by Client.Close()).
//
// bd:envpit-tkvz: the degraded-mode warn timer (scheduleWarnTimer) is normally stopped by
// onSuccess() when the channel recovers, but that's only ONE of run()'s exit paths. Close()
// drives the ctx-cancellation exit paths below (:107-109 pre-fix, the post-connectOnce check, and
// the select's <-ctx.Done() case) — neither of which called stopWarnTimerLocked(), so a pending
// warn AfterFunc scheduled while degraded kept firing minutes after Close() returned (a spurious
// log line, and it kept the whole Client graph, including the config snapshot, reachable/un-GC'd
// until it fired). This defer covers every exit from run() — success, ctx-cancel, or the loop
// simply never starting because ctx was already done — not just the one path that happened to
// call it explicitly. Idempotent (stopWarnTimerLocked no-ops if no timer is pending).
func (t *realtimeTransport) run(ctx context.Context) {
	defer t.stopWarnTimer()
	for ctx.Err() == nil {
		t.connectOnce(ctx)
		if ctx.Err() != nil {
			return
		}
		delay := t.consumeDelay()
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func (t *realtimeTransport) connectOnce(ctx context.Context) {
	url := t.params.host + configEventsPath
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		if ctx.Err() != nil {
			return
		}
		t.onFailure()
		return
	}
	req.Header.Set("X-Api-Key", t.params.apiKey)
	req.Header.Set("Accept", "text/event-stream")

	resp, doErr := t.params.httpClient.Do(req)
	if doErr != nil {
		if ctx.Err() != nil {
			return
		}
		t.onFailure()
		return
	}
	if ctx.Err() != nil {
		resp.Body.Close()
		return
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		resp.Body.Close()
		t.onFailure()
		return
	}

	t.onSuccess()

	parser := newSSEFrameParser(t.params.maxLineBytes)
	buf := make([]byte, sseReadChunkBytes)
	_ = t.pump(ctx, resp.Body, parser, buf) // a read/decode error mid-stream is just a disconnect
	resp.Body.Close()

	if ctx.Err() != nil {
		return
	}
	t.onFailure()
}

func (t *realtimeTransport) pump(ctx context.Context, body io.Reader, parser *sseFrameParser, buf []byte) error {
	for {
		n, readErr := body.Read(buf)
		if n > 0 {
			frames, parseErr := parser.push(string(buf[:n]))
			for _, frame := range frames {
				t.handleFrame(frame)
				if ctx.Err() != nil {
					return ctx.Err()
				}
			}
			if parseErr != nil {
				return parseErr
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				return nil // clean EOF -> treated as a disconnect by the caller
			}
			return readErr
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
	}
}

func (t *realtimeTransport) handleFrame(frame SseFrame) {
	switch frame.Event {
	case configChangedEventName:
		if etag, ok := parseEtag(frame.Data); ok {
			t.params.onChangeSignal(etag)
		}
	case reconnectEventName:
		// The server is about to close this stream deliberately (rotation/shutdown/revocation
		// sweep) — remember that, so the next successful connect logs the quieter "reconnected
		// (server rotation)" line instead of a generic "connected" one.
		t.mu.Lock()
		t.expectingServerReconnect = true
		t.mu.Unlock()
	}
	// Unknown event name (e.g. a future flags-changed frame) — ignored by design.
}

func (t *realtimeTransport) onSuccess() {
	t.mu.Lock()
	t.quickRetryUsedForEpisode = false
	wasServerReconnect := t.expectingServerReconnect
	t.expectingServerReconnect = false
	wasDegraded := !t.degradedSince.IsZero()
	t.degradedSince = time.Time{}
	t.warnedThisEpisode = false
	t.stopWarnTimerLocked()

	modeChanged := t.mode != ModeRealtime
	since := time.Now()
	if modeChanged {
		t.mode = ModeRealtime
	}
	t.mu.Unlock()

	switch {
	case wasDegraded:
		t.params.onLog("info", "envpit: realtime channel restored")
	case wasServerReconnect:
		t.params.onLog("debug", "envpit: realtime channel reconnected (server rotation)")
	default:
		t.params.onLog("debug", "envpit: realtime config channel connected")
	}
	if modeChanged {
		t.params.onModeChange(ModeRealtime, ReasonConnected, since)
	}
}

func (t *realtimeTransport) onFailure() {
	t.mu.Lock()
	// One silent, immediate retry per episode before announcing anything.
	if !t.quickRetryUsedForEpisode && t.degradedSince.IsZero() {
		t.quickRetryUsedForEpisode = true
		t.nextDelay = t.params.quickReconnectDelay
		t.mu.Unlock()
		return
	}
	t.mu.Unlock()
	t.declareDegraded(ReasonNetwork)
	t.scheduleDegradedRetry()
}

func (t *realtimeTransport) declareDegraded(reason ConnectionReason) {
	t.mu.Lock()
	if !t.degradedSince.IsZero() {
		t.mu.Unlock()
		return // already announced this episode — stay quiet
	}
	since := time.Now()
	t.degradedSince = since
	modeChanged := t.mode != ModePolling
	t.mode = ModePolling
	pollSec := pollSeconds(t.params.pollInterval)
	t.mu.Unlock()

	message := fmt.Sprintf(
		"envpit: realtime channel unavailable — falling back to polling every %ds; config still refreshes, max staleness %ds",
		pollSec, pollSec)
	t.params.onLog("info", message)
	if modeChanged {
		t.params.onModeChange(ModePolling, reason, since)
	}
	t.scheduleWarnTimer()
}

func (t *realtimeTransport) scheduleWarnTimer() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.stopWarnTimerLocked()
	threshold := t.params.degradedWarnThreshold
	t.warnTimer = time.AfterFunc(threshold, func() {
		t.mu.Lock()
		if t.degradedSince.IsZero() || t.warnedThisEpisode {
			t.mu.Unlock()
			return
		}
		t.warnedThisEpisode = true
		pollSec := pollSeconds(t.params.pollInterval)
		t.mu.Unlock()
		minutes := int(threshold.Round(time.Minute) / time.Minute)
		if minutes < 1 {
			minutes = 1
		}
		t.params.onLog("warn", fmt.Sprintf(
			"envpit: realtime channel still unavailable after %d min; continuing to poll every %ds",
			minutes, pollSec))
	})
}

func (t *realtimeTransport) stopWarnTimerLocked() {
	if t.warnTimer != nil {
		t.warnTimer.Stop()
		t.warnTimer = nil
	}
}

// stopWarnTimer is stopWarnTimerLocked's lock-acquiring wrapper, for callers (e.g. run's defer,
// bd:envpit-tkvz) that don't already hold t.mu.
func (t *realtimeTransport) stopWarnTimer() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.stopWarnTimerLocked()
}

func (t *realtimeTransport) scheduleDegradedRetry() {
	jitter := time.Duration(0)
	if t.params.degradedReconnectJitter > 0 {
		jitter = time.Duration(rand.Int63n(int64(t.params.degradedReconnectJitter) + 1))
	}
	t.mu.Lock()
	t.nextDelay = t.params.degradedReconnectInterval + jitter
	t.mu.Unlock()
}

func (t *realtimeTransport) consumeDelay() time.Duration {
	t.mu.Lock()
	defer t.mu.Unlock()
	d := t.nextDelay
	t.nextDelay = 0
	return d
}

func pollSeconds(d time.Duration) int {
	sec := int(d.Round(time.Second) / time.Second)
	if sec < 1 {
		sec = 1
	}
	return sec
}

// parseEtag extracts a config-changed push payload's etag field. Any shape that isn't
// "a JSON object with a non-empty string etag field" is silently ignored — malformed/partial
// push payloads must never crash the transport or trigger a bogus refetch (push-payloads.json).
func parseEtag(data string) (string, bool) {
	var parsed map[string]json.RawMessage
	if err := json.Unmarshal([]byte(data), &parsed); err != nil {
		return "", false
	}
	raw, ok := parsed["etag"]
	if !ok {
		return "", false
	}
	var etag string
	if err := json.Unmarshal(raw, &etag); err != nil {
		return "", false
	}
	if etag == "" {
		return "", false
	}
	return etag, true
}
