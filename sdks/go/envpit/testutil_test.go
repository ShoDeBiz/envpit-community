package envpit

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// ---- test-vectors loader ----------------------------------------------------------------

// vectorsRoot resolves envpit-community/test-vectors/ from THIS file's own location — one level
// above sdks/ (repo root) — matching sdks/python/tests/_vectors.py and
// sdks/node/test/vector-loader.ts's approach. Test-code only: never imported by runtime source,
// so this adds zero runtime footprint to the published module.
func vectorsRoot() string {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		panic("envpit: runtime.Caller failed while resolving test-vectors root")
	}
	// thisFile == .../sdks/go/envpit/testutil_test.go -> up 3 dirs -> repo root.
	return filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "test-vectors")
}

func loadVectors(t *testing.T, name string, v any) {
	t.Helper()
	path := filepath.Join(vectorsRoot(), name)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("failed to read test-vectors/%s: %v", name, err)
	}
	if err := json.Unmarshal(data, v); err != nil {
		t.Fatalf("failed to parse test-vectors/%s: %v", name, err)
	}
}

// ---- fake HTTP transport ------------------------------------------------------------------

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// fakeTransport routes GET .../api/v1/config to configFn and GET .../api/v1/config/events to
// eventsFn — the two real HTTP calls this SDK ever makes. Both are optional; an unset handler on
// a path that's actually hit fails the test loudly (an unexpected extra call, mirroring the
// shipped Node/Python test-utils' "no response configured" philosophy).
type fakeTransport struct {
	mu       sync.Mutex
	configFn roundTripFunc
	eventsFn roundTripFunc
}

func (f *fakeTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	f.mu.Lock()
	configFn, eventsFn := f.configFn, f.eventsFn
	f.mu.Unlock()
	switch r.URL.Path {
	case configPath:
		if configFn == nil {
			return nil, fmt.Errorf("fakeTransport: unexpected call to %s (no configFn configured)", r.URL.Path)
		}
		return configFn(r)
	case configEventsPath:
		if eventsFn == nil {
			return nil, fmt.Errorf("fakeTransport: unexpected call to %s (no eventsFn configured)", r.URL.Path)
		}
		return eventsFn(r)
	default:
		return nil, fmt.Errorf("fakeTransport: unexpected path %s", r.URL.Path)
	}
}

func fakeHTTPClient(rt http.RoundTripper) *http.Client {
	return &http.Client{Transport: rt}
}

func jsonResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Status:     http.StatusText(status),
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     make(http.Header),
	}
}

func jsonResponseWithEtag(status int, body, etag string) *http.Response {
	resp := jsonResponse(status, body)
	if etag != "" {
		resp.Header.Set("Etag", etag)
	}
	return resp
}

// envelopeBody wraps a bare values-map JSON literal — this SDK's own test-fixture convention
// predating bd:envpit-durd, e.g. `{"K":"v0"}` — into the post-durd wire envelope
// `{"values": ..., "secretKeys": [...]}` (test-vectors/resolve-body.json) that fetchConfig now
// strictly requires. secretKeys defaults to none (`[]`); pass explicit names for a fixture that
// needs a secret-labeled response (or use newLoadedClientWithSecrets, env_test.go, for the
// common "build a client with some keys pre-marked secret" case).
func envelopeBody(valuesJSON string, secretKeys ...string) string {
	keysJSON := "[]"
	if len(secretKeys) > 0 {
		b, err := json.Marshal(secretKeys)
		if err != nil {
			panic("envelopeBody: secretKeys is always a []string literal in test code: " + err.Error())
		}
		keysJSON = string(b)
	}
	return `{"values":` + valuesJSON + `,"secretKeys":` + keysJSON + `}`
}

// fetchQueue returns a roundTripFunc that serves each body in order, one per call, and fails
// the test loudly once exhausted — an unexpected extra fetch call is a test bug, not something
// that should silently repeat stale data.
//
// Every body is wrapped into the post-durd envelope via envelopeBody before being served — every
// existing caller predates bd:envpit-durd and supplies a bare values-map literal (e.g.
// `{"K":"v0"}`), so wrapping centrally here means none of them needed updating body-by-body when
// the wire contract changed underneath them.
func fetchQueue(t *testing.T, bodies ...string) roundTripFunc {
	t.Helper()
	var mu sync.Mutex
	i := 0
	return func(r *http.Request) (*http.Response, error) {
		mu.Lock()
		defer mu.Unlock()
		if i >= len(bodies) {
			t.Fatalf("fetch queue exhausted — unexpected extra fetch call")
		}
		body := bodies[i]
		i++
		return jsonResponse(200, envelopeBody(body)), nil
	}
}

// neverConnectEvents is an eventsFn that blocks forever until the request's context is
// cancelled — used when a test wants poll-only behavior without a real network call, but still
// wants pollInterval > 0 so the poll goroutine/refresher actually run (unlike WithPollInterval(0),
// which disables background work entirely per INV-SDK-8).
func neverConnectEvents(t *testing.T) roundTripFunc {
	return func(r *http.Request) (*http.Response, error) {
		<-r.Context().Done()
		return nil, r.Context().Err()
	}
}

// ---- fake SSE stream -----------------------------------------------------------------------

// fakeSSEStream is a controllable fake SSE response body: Read blocks (briefly, polling) until
// data is pushed or the stream is closed, then returns io.EOF — the Go analogue of Node/Python's
// test-utils sseResponse()/FakeSseStream.
type fakeSSEStream struct {
	chunks    chan []byte
	closed    chan struct{}
	closeOnce sync.Once
}

func newFakeSSEStream() *fakeSSEStream {
	return &fakeSSEStream{chunks: make(chan []byte, 64), closed: make(chan struct{})}
}

func (s *fakeSSEStream) push(text string) {
	select {
	case s.chunks <- []byte(text):
	case <-s.closed:
	}
}

func (s *fakeSSEStream) Read(p []byte) (int, error) {
	select {
	case chunk, ok := <-s.chunks:
		if !ok {
			return 0, io.EOF
		}
		n := copy(p, chunk)
		if n < len(chunk) {
			// Test fixtures always push chunks small enough to fit p (4096 bytes, the SDK's
			// real SSE read buffer size) — a truncated push here is a test-fixture bug, not a
			// runtime concern, so fail loudly rather than silently dropping bytes.
			panic("fakeSSEStream: pushed chunk larger than the reader's buffer")
		}
		return n, nil
	case <-s.closed:
		return 0, io.EOF
	}
}

func (s *fakeSSEStream) Close() error {
	s.closeOnce.Do(func() { close(s.closed) })
	return nil
}

func sseResponse(stream *fakeSSEStream) *http.Response {
	return &http.Response{
		StatusCode: 200,
		Status:     "200 OK",
		Body:       stream,
		Header:     make(http.Header),
	}
}

// ---- misc test helpers ----------------------------------------------------------------------

func waitUntil(t *testing.T, timeout time.Duration, predicate func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if predicate() {
			return true
		}
		time.Sleep(2 * time.Millisecond)
	}
	return predicate()
}

// newLoadedClient builds a client with poll_interval=0 (no background work, INV-SDK-8) loaded
// from a single canned snapshot — the Go analogue of Node/Python tests' most common fixture
// shape, letting the test drive doRefresh()/internal state directly afterward.
func newLoadedClient(t *testing.T, snapshotJSON string, extra ...Option) *Client {
	t.Helper()
	rt := &fakeTransport{configFn: fetchQueue(t, snapshotJSON)}
	opts := append([]Option{
		WithAPIKey("epk_test"),
		WithPollInterval(0),
		WithHTTPClient(fakeHTTPClient(rt)),
		WithLogger(nil),
	}, extra...)
	client, err := NewClient(context.Background(), opts...)
	if err != nil {
		t.Fatalf("newLoadedClient: NewClient failed: %v", err)
	}
	t.Cleanup(client.Close)
	return client
}

func strPtr(s string) *string { return &s }

// errConnectionRefused builds a synthetic connection-refused-shaped error, reusable across
// tests that need a realistic transport failure without a real socket.
func errConnectionRefused() error {
	return &net.OpError{Op: "dial", Net: "tcp", Err: syscall.ECONNREFUSED}
}
