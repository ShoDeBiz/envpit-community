package envpit

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// This file consumes all 8 shared test-vectors/ families (suiteVersion 1.1.0), proving Go
// behaves identically to shipped Node/Python against the SAME canonical fixtures rather than
// prose ported by hand. See test-vectors/README.md for the family list and
// test-vectors/CONFORMANCE.md for the (separate, non-data) behavioral invariant checklist
// consumed by conformance_test.go.

// ---- 1. getters.json --------------------------------------------------------------------

func TestVectorsGetters(t *testing.T) {
	var doc struct {
		Cases []struct {
			Name     string          `json:"name"`
			Snapshot ConfigSnapshot  `json:"snapshot"`
			Kind     string          `json:"kind"`
			Key      string          `json:"key"`
			Default  json.RawMessage `json:"default"`
			Expected struct {
				Value json.RawMessage `json:"value"`
				Error string          `json:"error"`
			} `json:"expected"`
		} `json:"cases"`
	}
	loadVectors(t, "getters.json", &doc)

	for _, c := range doc.Cases {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			snapshotJSON, err := json.Marshal(c.Snapshot)
			if err != nil {
				t.Fatalf("marshal snapshot: %v", err)
			}
			client := newLoadedClient(t, string(snapshotJSON))
			hasDefault := c.Default != nil

			switch c.Kind {
			case "string":
				if hasDefault {
					var def, want string
					mustUnmarshal(t, c.Default, &def)
					mustUnmarshal(t, c.Expected.Value, &want)
					if got := client.GetOr(c.Key, def); got != want {
						t.Fatalf("GetOr(%q, %q) = %q, want %q", c.Key, def, got, want)
					}
					return
				}
				got, err := client.Get(c.Key)
				assertGetterOutcome(t, err, c.Expected.Error, func() {
					var want string
					mustUnmarshal(t, c.Expected.Value, &want)
					if got != want {
						t.Fatalf("Get(%q) = %q, want %q", c.Key, got, want)
					}
				})

			case "int":
				if hasDefault {
					var def, want int
					mustUnmarshal(t, c.Default, &def)
					mustUnmarshal(t, c.Expected.Value, &want)
					if got := client.GetIntOr(c.Key, def); got != want {
						t.Fatalf("GetIntOr(%q, %d) = %d, want %d", c.Key, def, got, want)
					}
					return
				}
				got, err := client.GetInt(c.Key)
				assertGetterOutcome(t, err, c.Expected.Error, func() {
					var want int
					mustUnmarshal(t, c.Expected.Value, &want)
					if got != want {
						t.Fatalf("GetInt(%q) = %d, want %d", c.Key, got, want)
					}
				})

			case "boolean":
				if hasDefault {
					var def, want bool
					mustUnmarshal(t, c.Default, &def)
					mustUnmarshal(t, c.Expected.Value, &want)
					if got := client.GetBoolOr(c.Key, def); got != want {
						t.Fatalf("GetBoolOr(%q, %v) = %v, want %v", c.Key, def, got, want)
					}
					return
				}
				got, err := client.GetBool(c.Key)
				assertGetterOutcome(t, err, c.Expected.Error, func() {
					var want bool
					mustUnmarshal(t, c.Expected.Value, &want)
					if got != want {
						t.Fatalf("GetBool(%q) = %v, want %v", c.Key, got, want)
					}
				})

			default:
				t.Fatalf("unhandled kind %q", c.Kind)
			}
		})
	}
}

func mustUnmarshal(t *testing.T, raw json.RawMessage, v any) {
	t.Helper()
	if err := json.Unmarshal(raw, v); err != nil {
		t.Fatalf("unmarshal %s into %T: %v", raw, v, err)
	}
}

func assertGetterOutcome(t *testing.T, err error, wantErrorType string, checkValue func()) {
	t.Helper()
	if wantErrorType != "" {
		if err == nil {
			t.Fatalf("expected %s, got no error", wantErrorType)
		}
		if !errorTypeNameMatches(err, wantErrorType) {
			t.Fatalf("expected %s, got %T: %v", wantErrorType, err, err)
		}
		return
	}
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	checkValue()
}

func errorTypeNameMatches(err error, wantType string) bool {
	switch wantType {
	case "AuthenticationError":
		var e *AuthenticationError
		return errors.As(err, &e)
	case "NetworkError":
		var e *NetworkError
		return errors.As(err, &e)
	case "MissingKeyError":
		var e *MissingKeyError
		return errors.As(err, &e)
	case "TypeMismatchError":
		var e *TypeMismatchError
		return errors.As(err, &e)
	default:
		return false
	}
}

// ---- 2. snapshot-diff.json --------------------------------------------------------------

func TestVectorsSnapshotDiff(t *testing.T) {
	var doc struct {
		Cases []struct {
			Name                string         `json:"name"`
			Before              ConfigSnapshot `json:"before"`
			After               ConfigSnapshot `json:"after"`
			ExpectedChangedKeys []string       `json:"expectedChangedKeys"`
		} `json:"cases"`
	}
	loadVectors(t, "snapshot-diff.json", &doc)

	for _, c := range doc.Cases {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			got := diffSnapshots(c.Before, c.After)
			want := c.ExpectedChangedKeys
			if len(got) != len(want) {
				t.Fatalf("diffSnapshots = %v, want %v", got, want)
			}
			for i := range got {
				if got[i] != want[i] {
					t.Fatalf("diffSnapshots = %v, want %v", got, want)
				}
			}
		})
	}
}

// ---- 3. error-mapping.json ----------------------------------------------------------------

func TestVectorsErrorMapping(t *testing.T) {
	var doc struct {
		Cases []struct {
			Name          string         `json:"name"`
			Condition     map[string]any `json:"condition"`
			ExpectedError string         `json:"expectedError"`
		} `json:"cases"`
	}
	loadVectors(t, "error-mapping.json", &doc)

	for _, c := range doc.Cases {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			rt := conditionRoundTripper(t, c.Condition)
			httpClient := &http.Client{Transport: rt}
			ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
			defer cancel()
			_, err := fetchConfig(ctx, httpClient, "https://example.test", "epk_test")
			if err == nil {
				t.Fatalf("expected an error, got none")
			}
			if !errorTypeNameMatches(err, c.ExpectedError) {
				t.Fatalf("expected %s, got %T: %v", c.ExpectedError, err, err)
			}
		})
	}
}

func conditionRoundTripper(t *testing.T, condition map[string]any) roundTripFunc {
	t.Helper()
	if statusRaw, ok := condition["status"]; ok {
		status := int(statusRaw.(float64))
		return func(r *http.Request) (*http.Response, error) {
			return jsonResponse(status, "{}"), nil
		}
	}
	failureRaw, ok := condition["transportFailure"]
	if !ok {
		t.Fatalf("unhandled condition shape: %#v", condition)
	}
	switch failureRaw.(string) {
	case "timeout":
		return func(r *http.Request) (*http.Response, error) {
			<-r.Context().Done()
			return nil, r.Context().Err()
		}
	case "connection-refused":
		return func(r *http.Request) (*http.Response, error) {
			return nil, &net.OpError{Op: "dial", Net: "tcp", Err: syscall.ECONNREFUSED}
		}
	case "invalid-json-body":
		return func(r *http.Request) (*http.Response, error) {
			return jsonResponse(200, "{not valid json!!"), nil
		}
	case "connection-reset":
		// bd:envpit-4dbm class: a server that accepts, reads the request, then resets with zero
		// response bytes — modeled as a read-phase net.OpError, exactly the shape
		// isConnectionReset (transport.go) recognizes.
		return func(r *http.Request) (*http.Response, error) {
			return nil, &net.OpError{Op: "read", Net: "tcp", Err: io.ErrUnexpectedEOF}
		}
	default:
		t.Fatalf("unhandled transportFailure %q", failureRaw)
		return nil
	}
}

// ---- 4. sse-frames.json --------------------------------------------------------------------

func TestVectorsSSEFrames(t *testing.T) {
	var doc struct {
		Cases []struct {
			Name           string     `json:"name"`
			ChunkMode      string     `json:"chunkMode"`
			Input          string     `json:"input"`
			ExpectedFrames []SseFrame `json:"expectedFrames"`
		} `json:"cases"`
	}
	loadVectors(t, "sse-frames.json", &doc)

	for _, c := range doc.Cases {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			parser := newSSEFrameParser(defaultMaxSSELineBytes)
			var frames []SseFrame

			switch c.ChunkMode {
			case "char":
				for _, r := range c.Input {
					got, err := parser.push(string(r))
					if err != nil {
						t.Fatalf("push error: %v", err)
					}
					frames = append(frames, got...)
				}
			case "whole":
				got, err := parser.push(c.Input)
				if err != nil {
					t.Fatalf("push error: %v", err)
				}
				frames = got
			default:
				t.Fatalf("unhandled chunkMode %q", c.ChunkMode)
			}

			if len(frames) != len(c.ExpectedFrames) {
				t.Fatalf("got %d frames %v, want %v", len(frames), frames, c.ExpectedFrames)
			}
			for i := range frames {
				if frames[i] != c.ExpectedFrames[i] {
					t.Fatalf("frame %d = %+v, want %+v", i, frames[i], c.ExpectedFrames[i])
				}
			}
		})
	}
}

// ---- 5. push-payloads.json -----------------------------------------------------------------

func TestVectorsPushPayloads(t *testing.T) {
	var doc struct {
		Cases []struct {
			Name             string `json:"name"`
			Event            string `json:"event"`
			Data             string `json:"data"`
			ExpectedBehavior string `json:"expectedBehavior"`
			ExpectedEtag     string `json:"expectedEtag"`
		} `json:"cases"`
	}
	loadVectors(t, "push-payloads.json", &doc)

	for _, c := range doc.Cases {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			var signaled []string
			transport := newRealtimeTransport(realtimeParams{
				host:           "https://example.test",
				apiKey:         "epk_test",
				pollInterval:   time.Minute,
				onChangeSignal: func(etag string) { signaled = append(signaled, etag) },
				onModeChange:   func(ConnectionMode, ConnectionReason, time.Time) {},
				onLog:          func(string, string) {},
			})

			transport.handleFrame(SseFrame{Event: c.Event, Data: c.Data})

			switch c.ExpectedBehavior {
			case "refetch":
				if len(signaled) != 1 || signaled[0] != c.ExpectedEtag {
					t.Fatalf("expected exactly one refetch signal with etag %q, got %v", c.ExpectedEtag, signaled)
				}
			case "ignore":
				if len(signaled) != 0 {
					t.Fatalf("expected no refetch signal, got %v", signaled)
				}
			default:
				t.Fatalf("unhandled expectedBehavior %q", c.ExpectedBehavior)
			}
		})
	}
}

// ---- 6. error-messages.json ----------------------------------------------------------------

func TestVectorsErrorMessages(t *testing.T) {
	type messageEntry struct {
		ErrorClass *string `json:"errorClass"`
		Message    string  `json:"message"`
	}
	var doc struct {
		Cases []struct {
			Name              string         `json:"name"`
			ValueFreeCarveOut bool           `json:"valueFreeCarveOut"`
			ApiKeyMissing     bool           `json:"apiKeyMissing"`
			Kind              string         `json:"kind"`
			Condition         map[string]any `json:"condition"`
			Getter            *struct {
				Snapshot ConfigSnapshot `json:"snapshot"`
				Kind     string         `json:"kind"`
				Key      string         `json:"key"`
			} `json:"getter"`
			BackgroundRefresh *struct {
				Condition map[string]any `json:"condition"`
			} `json:"backgroundRefresh"`
			Languages []string                `json:"languages"`
			Messages  map[string]messageEntry `json:"messages"`
		} `json:"cases"`
	}
	loadVectors(t, "error-messages.json", &doc)

	const exampleHost = "https://example.test"

	for _, c := range doc.Cases {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			if len(c.Languages) > 0 && !contains(c.Languages, "go") {
				t.Skip("case restricted to other languages")
			}
			goMsg, ok := c.Messages["go"]
			if !ok {
				t.Fatal("no go entry in messages")
			}

			var gotMessage string

			switch c.Name {
			case "no-api-key-found":
				old, hadOld := os.LookupEnv("ENVPIT_API_KEY")
				os.Unsetenv("ENVPIT_API_KEY")
				defer func() {
					if hadOld {
						os.Setenv("ENVPIT_API_KEY", old)
					}
				}()
				_, err := NewClient(context.Background())
				if err == nil {
					t.Fatal("expected an error")
				}
				gotMessage = err.Error()

			case "api-key-rejected-401", "could-not-reach-server-timeout", "non-2xx-response", "invalid-json-response":
				rt := conditionRoundTripper(t, c.Condition)
				httpClient := &http.Client{Transport: rt}
				ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
				defer cancel()
				_, err := fetchConfig(ctx, httpClient, exampleHost, "epk_test")
				if err == nil {
					t.Fatal("expected an error")
				}
				gotMessage = err.Error()

			case "missing-key":
				client := newLoadedClientFromSnapshot(t, c.Getter.Snapshot)
				_, err := client.Get(c.Getter.Key)
				if err == nil {
					t.Fatal("expected an error")
				}
				gotMessage = err.Error()

			case "type-mismatch-integer":
				client := newLoadedClientFromSnapshot(t, c.Getter.Snapshot)
				_, err := client.GetInt(c.Getter.Key)
				if err == nil {
					t.Fatal("expected an error")
				}
				gotMessage = err.Error()
				if !c.ValueFreeCarveOut {
					t.Fatal("this case must be the documented value-echo carve-out")
				}
				if !strings.Contains(gotMessage, "abc") {
					t.Fatalf("carve-out case must echo the raw value, got %q", gotMessage)
				}

			case "background-refresh-failed-http-500":
				logger := newCapturingLogger()
				client := newLoadedClient(t, `{"K":"v0"}`, WithLogger(logger))
				client.httpClient = &http.Client{Transport: conditionRoundTripper(t, c.BackgroundRefresh.Condition)}
				client.host = exampleHost
				client.doRefresh(TriggerPoll)
				gotMessage = logger.lastWarn()

			case "go-or-family-type-mismatch-value-free":
				logger := newCapturingLogger()
				client := newLoadedClient(t, `{"PORT":"abc"}`, WithLogger(logger))
				_ = client.GetIntOr("PORT", 8080)
				gotMessage = logger.lastWarn()
				if strings.Contains(gotMessage, "abc") {
					t.Fatalf("Go-only Or-family fallback message must be value-free (AC-SEC-SDK3-6), got %q", gotMessage)
				}

			default:
				t.Fatalf("unhandled case %q — a case was added to error-messages.json that this test doesn't drive yet", c.Name)
			}

			if gotMessage != goMsg.Message {
				t.Fatalf("message mismatch:\n got:  %q\n want: %q", gotMessage, goMsg.Message)
			}
			if !c.ValueFreeCarveOut {
				assertNoConfigValueLeak(t, gotMessage)
			}
		})
	}
}

func newLoadedClientFromSnapshot(t *testing.T, snapshot ConfigSnapshot) *Client {
	t.Helper()
	body, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatalf("marshal snapshot: %v", err)
	}
	return newLoadedClient(t, string(body))
}

func contains(ss []string, target string) bool {
	for _, s := range ss {
		if s == target {
			return true
		}
	}
	return false
}

// assertNoConfigValueLeak is a best-effort sanity check for the family's own documented
// invariant: outside the one carve-out case, no message may contain a value substring plausible
// enough to have come from the fixtures used in this file (INV-SDK-11 / AC-SEC-SDK3-6).
func assertNoConfigValueLeak(t *testing.T, message string) {
	t.Helper()
	for _, forbidden := range []string{"epk_test", "v0"} {
		if strings.Contains(message, forbidden) {
			t.Fatalf("message unexpectedly contains a fixture value %q: %q", forbidden, message)
		}
	}
}

// capturingLogger records the most recent line at each level — test-only Logger implementation.
type capturingLogger struct {
	mu    sync.Mutex
	warns []string
}

func newCapturingLogger() *capturingLogger { return &capturingLogger{} }

func (l *capturingLogger) Debug(string) {}
func (l *capturingLogger) Info(string)  {}
func (l *capturingLogger) Warn(message string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.warns = append(l.warns, message)
}
func (l *capturingLogger) Error(string) {}

func (l *capturingLogger) lastWarn() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.warns) == 0 {
		return ""
	}
	return l.warns[len(l.warns)-1]
}

// ---- 7. adversarial-payloads.json ----------------------------------------------------------

func TestVectorsAdversarialPayloads(t *testing.T) {
	var doc struct {
		Cases []struct {
			Name                  string    `json:"name"`
			Kind                  string    `json:"kind"`
			RecommendedCapBytes   int64     `json:"recommendedCapBytes"`
			PayloadBytes          int64     `json:"payloadBytes"`
			LineBytes             int       `json:"lineBytes"`
			Depth                 int       `json:"depth"`
			Pattern               string    `json:"pattern"`
			Input                 string    `json:"input"`
			Event                 string    `json:"event"`
			Data                  string    `json:"data"`
			ExpectedSafety        string    `json:"expectedSafety"`
			ExpectedErrorClass    string    `json:"expectedErrorClass"`
			ExpectedMessageSubstr string    `json:"expectedMessageSubstring"`
			ExpectedFrame         *SseFrame `json:"expectedFrame"`
		} `json:"cases"`
	}
	loadVectors(t, "adversarial-payloads.json", &doc)

	for _, c := range doc.Cases {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			switch c.Kind {
			case "body-size-cap":
				body := buildPaddedJSONObject(int(c.PayloadBytes))
				rt := roundTripFunc(func(r *http.Request) (*http.Response, error) {
					return jsonResponse(200, body), nil
				})
				httpClient := &http.Client{Transport: rt}
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				defer cancel()
				result, err := fetchConfig(ctx, httpClient, "https://example.test", "epk_test")
				switch c.ExpectedSafety {
				case "reject-before-buffering-entire-body":
					if err == nil {
						t.Fatal("expected an error")
					}
					if !errorTypeNameMatches(err, c.ExpectedErrorClass) {
						t.Fatalf("expected %s, got %T: %v", c.ExpectedErrorClass, err, err)
					}
					if !strings.Contains(err.Error(), c.ExpectedMessageSubstr) {
						t.Fatalf("message %q missing substring %q", err.Error(), c.ExpectedMessageSubstr)
					}
				case "accept":
					if err != nil {
						t.Fatalf("unexpected error: %v", err)
					}
					if _, ok := result.snapshot["K"]; !ok {
						t.Fatal("expected key K in accepted snapshot")
					}
				default:
					t.Fatalf("unhandled expectedSafety %q", c.ExpectedSafety)
				}

			case "sse-line-size-cap":
				switch c.ExpectedSafety {
				case "reject-drop-connection-reconnect-via-existing-backoff-path":
					parser := newSSEFrameParser(defaultMaxSSELineBytes)
					chunk := buildOversizedSSELine(c.LineBytes)
					_, err := parser.push(chunk)
					if !errors.Is(err, errSSELineTooLong) {
						t.Fatalf("expected errSSELineTooLong, got %v", err)
					}
				case "accept":
					parser := newSSEFrameParser(defaultMaxSSELineBytes)
					input := "event: " + c.Event + "\ndata: " + c.Data + "\n\n"
					frames, err := parser.push(input)
					if err != nil {
						t.Fatalf("unexpected error: %v", err)
					}
					if len(frames) != 1 || frames[0].Event != c.ExpectedFrame.Event || frames[0].Data != c.ExpectedFrame.Data {
						t.Fatalf("got %v, want [%v]", frames, *c.ExpectedFrame)
					}
				default:
					t.Fatalf("unhandled expectedSafety %q", c.ExpectedSafety)
				}

			case "json-depth-bomb":
				runWithTimeout(t, 5*time.Second, func() {
					var open, close string
					switch c.Pattern {
					case "nested-arrays":
						open, close = "[", "]"
					default:
						t.Fatalf("unhandled pattern %q", c.Pattern)
					}
					body := strings.Repeat(open, c.Depth) + strings.Repeat(close, c.Depth)
					var snapshot ConfigSnapshot
					// Either a clean parse OR a clean rejection is compliant (the vector family's
					// own "expectedSafety: no-crash-no-hang-no-oom" wording) — a top-level array
					// against our map-typed ConfigSnapshot always rejects (type mismatch), which
					// is itself a compliant outcome; the property under test is "did not
					// crash/hang", asserted by this call returning at all within the timeout.
					_ = json.Unmarshal([]byte(body), &snapshot)
				})

			case "malformed-json":
				rt := roundTripFunc(func(r *http.Request) (*http.Response, error) {
					return jsonResponse(200, c.Input), nil
				})
				httpClient := &http.Client{Transport: rt}
				ctx, cancel := context.WithTimeout(context.Background(), time.Second)
				defer cancel()
				_, err := fetchConfig(ctx, httpClient, "https://example.test", "epk_test")
				if err == nil {
					t.Fatal("expected an error")
				}
				if !errorTypeNameMatches(err, c.ExpectedErrorClass) {
					t.Fatalf("expected %s, got %T: %v", c.ExpectedErrorClass, err, err)
				}

			default:
				t.Fatalf("unhandled kind %q", c.Kind)
			}
		})
	}
}

// buildPaddedJSONObject matches test-vectors/adversarial-payloads.json's documented recipe:
// "json-object-single-key-K-padded-string" — {"K": "` + ('v' * N) + `"} sized to exactly
// totalBytes.
func buildPaddedJSONObject(totalBytes int) string {
	const prefix = `{"K":"`
	const suffix = `"}`
	padLen := totalBytes - len(prefix) - len(suffix)
	if padLen < 0 {
		padLen = 0
	}
	return prefix + strings.Repeat("v", padLen) + suffix
}

// buildOversizedSSELine matches the documented recipe:
// "sse-config-changed-data-padded-no-terminator" — "event: config-changed\ndata: " + ('x' * N),
// fed as one chunk with NO trailing newline, sized to exactly lineBytes.
func buildOversizedSSELine(lineBytes int) string {
	const prefix = "event: config-changed\ndata: "
	padLen := lineBytes - len(prefix)
	if padLen < 0 {
		padLen = 0
	}
	return prefix + strings.Repeat("x", padLen)
}

func runWithTimeout(t *testing.T, timeout time.Duration, fn func()) {
	t.Helper()
	done := make(chan struct{})
	var panicVal any
	go func() {
		defer close(done)
		defer func() {
			if r := recover(); r != nil {
				panicVal = r
			}
		}()
		fn()
	}()
	select {
	case <-done:
		if panicVal != nil {
			t.Fatalf("fn panicked (not memory/crash-safe): %v", panicVal)
		}
	case <-time.After(timeout):
		t.Fatalf("fn did not return within %v (hang, not memory/crash-safe)", timeout)
	}
}

// ---- 8. hashing.json (forward provision, bd:envpit-0t2z.6) ----------------------------------

func TestVectorsHashing(t *testing.T) {
	var doc struct {
		Salt  string `json:"salt"`
		Cases []struct {
			Key            string `json:"key"`
			ExpectedBucket int    `json:"expectedBucket"`
		} `json:"cases"`
	}
	loadVectors(t, "hashing.json", &doc)

	for _, c := range doc.Cases {
		c := c
		name := c.Key
		if name == "" {
			name = "empty-string"
		}
		t.Run(name, func(t *testing.T) {
			if got := bucket(c.Key, doc.Salt); got != c.ExpectedBucket {
				t.Fatalf("bucket(%q, %q) = %d, want %d", c.Key, doc.Salt, got, c.ExpectedBucket)
			}
		})
	}
}
