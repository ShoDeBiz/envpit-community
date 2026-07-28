package envpit

import (
	"fmt"
	"time"
)

// ConfigSnapshot is one environment's resolved VALUES — key -> value map, secret-flagged keys
// already decrypted server-side, non-secret keys as-is. A nil pointer value and an absent key
// are treated identically ("unset") by every getter and by the change-diff algorithm — the Go
// mapping of Node/Python's null≡absent rule.
//
// Deliberately kept a plain map (not widened into a struct that also carries secret-key names)
// even after bd:envpit-durd taught the wire envelope to label which keys are secret
// (AC-SEC-E11): diffSnapshots' contract is a values-only diff (a secretKeys-only change is not
// a config change — see diffSnapshots' own doc comment), the typed getters only ever needed
// values, and widening this type into a struct would break every existing map-literal/
// map-indexing use of it (redaction_test.go's ConfigSnapshot{...} composite literal,
// property_test.go's setSnapshotValue direct index-assignment, and every bare-map "snapshot"/
// "before"/"after" fixture in test-vectors/getters.json and test-vectors/snapshot-diff.json,
// which predate durd and were not part of that change). The secret-key NAMES a fetch returned
// live alongside this type instead — on fetchResult (transport.go) and Client.secretKeys
// (client.go, exposed read-only via Client.SecretKeys()) — read by MergeIntoEnv (env.go), the
// one call site that actually needs to tell secrets apart from ordinary config.
//
// AC-SEC-SDK3-1 (THREATMODEL-envpit-0t2z-3.md F1): Go leaks struct/map contents via %v/%+v/%#v
// reflection-based formatting by DEFAULT if a type doesn't override String()/GoString() —
// ConfigSnapshot holds every resolved config value (including decrypted secrets), so it gets an
// explicit redacting representation even though it is never returned directly from the public
// API today (defense in depth against a future/careless debug print).
type ConfigSnapshot map[string]*string

func (s ConfigSnapshot) String() string {
	return fmt.Sprintf("envpit.ConfigSnapshot(keys=%d, values=<redacted>)", len(s))
}

func (s ConfigSnapshot) GoString() string { return s.String() }

// Logger is the injectable diagnostics sink (Uma SPEC-envpit-0t2z-3-1b-ux.md §3.2: default is a
// slog.Default()-backed logger — visible out of the box, matching Python's named-logger
// default; pass WithLogger(nil) to silence). SDK log lines are always English and NEVER contain
// a config value — only key names/counts/durations (INV-SDK-11).
type Logger interface {
	Debug(message string)
	Info(message string)
	Warn(message string)
	Error(message string)
}

// ChangeTrigger identifies what caused the refresh that produced a ChangeEvent.
type ChangeTrigger string

const (
	// TriggerPush — an SSE config-changed notification triggered the refresh.
	TriggerPush ChangeTrigger = "push"
	// TriggerPoll — the regular poll-interval timer triggered the refresh.
	TriggerPoll ChangeTrigger = "poll"
	// TriggerReconnect — the realtime channel just (re)connected and a catch-up refresh found a
	// change that may have been missed while it was down.
	TriggerReconnect ChangeTrigger = "reconnect"
)

// ChangeEvent is the payload delivered on a Changes(ctx) channel. Log-safe by construction
// (INV-SDK-7): key NAMES only, never values.
type ChangeEvent struct {
	// ChangedKeys are the key names that were added, removed, or had their value change since
	// the previously served snapshot — sorted, never values.
	ChangedKeys []string
	// Etag is the fingerprint of the snapshot now being served, or "" if the server didn't send
	// one for this refresh.
	Etag string
	// ReceivedAt is when this refresh's response was received and applied.
	ReceivedAt time.Time
	// Trigger is what caused the refresh that found this change.
	Trigger ChangeTrigger
}

// ConnectionMode reports the realtime channel's state.
type ConnectionMode string

const (
	// ModeRealtime — the SSE connection is open and receiving pushes.
	ModeRealtime ConnectionMode = "realtime"
	// ModePolling — relying on the poll interval only (never opened, or currently degraded).
	ModePolling ConnectionMode = "polling"
)

// ConnectionReason explains why Mode is what it is.
type ConnectionReason string

const (
	ReasonConnected       ConnectionReason = "connected"
	ReasonServerReconnect ConnectionReason = "server-reconnect"
	ReasonNetwork         ConnectionReason = "network"
	// ReasonUnsupported is reserved for cross-SDK type parity with Node (whose fetch API can
	// return a non-streamable response body in some runtimes) — unreachable in Go, whose net/http
	// response body is always streamable (same reasoning the shipped Python SDK documents for
	// omitting this case in practice).
	ReasonUnsupported ConnectionReason = "unsupported"
	ReasonShutdown    ConnectionReason = "shutdown"
)

// ConnectionEvent is the payload delivered on a Connections(ctx) channel — fires ONLY on an
// actual Mode transition, never once per (re)connect attempt.
type ConnectionEvent struct {
	Mode   ConnectionMode
	Since  time.Time
	Reason ConnectionReason
}

// RefreshMode reports what's currently keeping the client's snapshot fresh.
type RefreshMode string

const (
	RefreshRealtime RefreshMode = "realtime"
	RefreshPolling  RefreshMode = "polling"
	// RefreshOff — the poll interval was 0: no background refresh of any kind is attempted
	// (INV-SDK-8).
	RefreshOff RefreshMode = "off"
)

// CacheInfo is a point-in-time view of the client's in-memory cache — the pull-style
// equivalent of the Changes/Connections/Errors push-style channels.
type CacheInfo struct {
	// FetchedAt is when the currently-served snapshot was fetched. Always set once
	// Load/NewClient has returned successfully.
	FetchedAt time.Time
	// Age is time.Since(FetchedAt).
	Age time.Duration
	// LastError is the error from the most recent FAILED refresh attempt, or nil whenever the
	// most recent refresh (or the initial load) succeeded.
	LastError error
	// Etag is the ETag response header captured from the currently-served snapshot's fetch, or
	// "" if the server didn't send one.
	Etag string
	// RefreshMode reports what's currently keeping the snapshot fresh.
	RefreshMode RefreshMode
	// RealtimeSince is when the realtime channel most recently became connected. Zero whenever
	// RefreshMode != RefreshRealtime.
	RealtimeSince time.Time
	// LastChangeAt is when the currently-served snapshot last differed from the one before it
	// (i.e. the last time a ChangeEvent fired). Zero if no change has been observed since load.
	LastChangeAt time.Time
}
