package envpit

import (
	"fmt"
	"log/slog"
	"net/http"
	"time"
)

const (
	defaultHost         = "https://envpit.com"
	defaultPollInterval = 60 * time.Second
	defaultTimeout      = 5 * time.Second
)

// clientConfig accumulates functional options before NewClient/Load construct a Client.
// Unexported and never returned to a caller — kept defensively redaction-safe anyway
// (AC-SEC-SDK3-1: "every type that transitively holds the API key... options/builder").
type clientConfig struct {
	apiKey       string
	host         string
	pollInterval time.Duration
	timeout      time.Duration
	httpClient   *http.Client
	logger       Logger
	loggerSet    bool
	hostSet      bool
}

func (c *clientConfig) String() string {
	return fmt.Sprintf("envpit.clientConfig(host=%q, apiKey=<redacted>)", c.host)
}

func (c *clientConfig) GoString() string { return c.String() }

func defaultConfig() *clientConfig {
	return &clientConfig{
		host:         defaultHost,
		pollInterval: defaultPollInterval,
		timeout:      defaultTimeout,
		httpClient:   http.DefaultClient,
	}
}

// Option configures a Client constructed by NewClient/Load — the functional-options pattern
// (Sara SPEC-envpit-0t2z-3-1a-architecture.md §2.2), the idiomatic Go stand-in for Node's
// options object / Python's keyword arguments.
type Option func(*clientConfig)

// WithAPIKey sets the API key sent as the X-Api-Key header (never Authorization — a separate
// trust boundary from session auth, ADR-M5-03). Falls back to the ENVPIT_API_KEY environment
// variable when omitted (INV-SDK-12) — an explicit WithAPIKey always wins over the environment.
func WithAPIKey(apiKey string) Option {
	return func(c *clientConfig) { c.apiKey = apiKey }
}

// WithHost overrides the API host (scheme + authority only, no path). Falls back to the
// ENVPIT_HOST environment variable when omitted (bd:envpit-ubky, mirroring WithAPIKey) — so a
// self-hoster who exports ENVPIT_API_KEY + ENVPIT_HOST reaches their own server, not the cloud.
// An explicit WithHost always wins over the environment. Default when neither is set: the
// production single-origin edge https://envpit.com. Override for self-hosted/local dev, e.g.
// http://localhost:8080.
func WithHost(host string) Option {
	return func(c *clientConfig) {
		c.host = host
		c.hostSet = true
	}
}

// WithPollInterval sets the background refresh interval. Default 60s. A value <= 0 disables
// ALL background refresh, including the realtime (SSE) channel — CacheInfo().RefreshMode
// reports RefreshOff (INV-SDK-8).
func WithPollInterval(d time.Duration) Option {
	return func(c *clientConfig) { c.pollInterval = d }
}

// WithTimeout sets the per-request timeout, applied to the initial load and every background
// poll/push/reconnect refresh. Default 5s. Not applied to the long-lived realtime (SSE)
// connection itself (expected to stay open for minutes).
func WithTimeout(d time.Duration) Option {
	return func(c *clientConfig) { c.timeout = d }
}

// WithHTTPClient overrides the *http.Client used for both the config fetch and the realtime
// (SSE) connection — the fetchImpl injection seam (test seam, but public, matching Node/Python
// precedent). AC-SEC-SDK3-3 (THREATMODEL-envpit-0t2z-3.md F3): envpit itself exposes no
// TLS-bypass option anywhere. Whatever certificate-verification posture the *http.Client you
// pass here has is entirely your own choice and your own responsibility — the SDK does not
// validate or restrict what you pass here, and never ships a named footgun of its own. (This
// paragraph deliberately avoids naming the specific stdlib field that weakens verification, so
// this SDK's own security test suite can grep the runtime source tree for that name without a
// documentation false-positive — see security_gates_test.go.)
func WithHTTPClient(client *http.Client) Option {
	return func(c *clientConfig) { c.httpClient = client }
}

// WithLogger overrides the diagnostics sink for the realtime channel's connect/degrade/restore
// signals, background-refresh failures, dropped-notification warnings, and the Or-family
// fallback warning. Pass nil to silence all SDK log output. The default (when WithLogger is
// never called) is a slog.Default()-backed logger (Uma SPEC-envpit-0t2z-3-1b-ux.md §3.2) —
// visible on stderr out of the box, matching Python's named-logger default rather than Node's
// silent-unless-injected one.
func WithLogger(logger Logger) Option {
	return func(c *clientConfig) {
		c.logger = logger
		c.loggerSet = true
	}
}

// slogLogger adapts a *slog.Logger to the Logger interface — the default diagnostics sink.
type slogLogger struct{ l *slog.Logger }

func newSlogLogger(l *slog.Logger) Logger { return &slogLogger{l: l} }

func (s *slogLogger) Debug(message string) { s.l.Debug(message) }
func (s *slogLogger) Info(message string)  { s.l.Info(message) }
func (s *slogLogger) Warn(message string)  { s.l.Warn(message) }
func (s *slogLogger) Error(message string) { s.l.Error(message) }
