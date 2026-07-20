package envpit

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"syscall"
)

// configPath is the one real HTTP call this SDK makes (Phase 1 scope — no bootstrap/handshake
// endpoint). GET {host}/api/v1/config — the key-scope-inferred alias: auth via X-Api-Key,
// project+environment are inferred server-side from the key itself.
const configPath = "/api/v1/config"

// defaultBodyByteCap — AC-SEC-SDK3-2(a) (THREATMODEL-envpit-0t2z-3.md F2): the config-response
// body is read with a maximum byte cap so an adversarial/misbehaving server sending an
// unbounded body cannot be buffered into memory without limit.
const defaultBodyByteCap int64 = 5 * 1024 * 1024 // 5 MiB

type fetchResult struct {
	snapshot ConfigSnapshot
	etag     string
}

func fetchConfig(ctx context.Context, httpClient *http.Client, host, apiKey string) (fetchResult, error) {
	url := host + configPath
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fetchResult{}, newNetworkErrorWrap(fmt.Sprintf("envpit: could not build a request for %s: %s", url, err), err)
	}
	req.Header.Set("X-Api-Key", apiKey)

	resp, err := httpClient.Do(req)
	if err != nil {
		return fetchResult{}, mapTransportError(url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return fetchResult{}, newAuthenticationError(fmt.Sprintf(
			"envpit: API key rejected (HTTP %d) — it may be revoked, expired, or mistyped; check Project → API Keys in EnvPit",
			resp.StatusCode))
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fetchResult{}, newNetworkError(fmt.Sprintf(
			"envpit: EnvPit returned HTTP %d while fetching config from %s", resp.StatusCode, url))
	}

	body, err := readCapped(resp.Body, defaultBodyByteCap)
	if err != nil {
		if errors.Is(err, errBodyTooLarge) {
			return fetchResult{}, newNetworkError(fmt.Sprintf(
				"envpit: EnvPit response from %s exceeded the maximum allowed size (%d bytes)", url, defaultBodyByteCap))
		}
		// A read error mid-body (e.g. a connection reset after headers were already received) is
		// transport-shaped, not a JSON-parse concern — describe it the same way a pre-response
		// transport failure is described (bd:envpit-4dbm class).
		return fetchResult{}, mapTransportError(url, err)
	}

	var snapshot ConfigSnapshot
	if err := json.Unmarshal(body, &snapshot); err != nil {
		// Covers malformed JSON (unterminated string, invalid \u escape, trailing garbage —
		// json.Unmarshal rejects all three) AND a non-object top-level JSON value (array/number/
		// bool/string all fail to unmarshal into a map type) — Go's typed unmarshal target gives
		// us the top-level-shape validation Python's transport.py has and Node's doesn't (see
		// test-vectors/CONFORMANCE.md's "discovered-but-out-of-scope" note) for free, without
		// extra code.
		return fetchResult{}, newNetworkError(fmt.Sprintf("envpit: EnvPit returned an invalid JSON response from %s", url))
	}
	if snapshot == nil {
		// The one non-object shape json.Unmarshal does NOT reject for a map target: a literal
		// JSON `null` body decodes to a nil map with no error. Reject it explicitly (Python
		// parity: isinstance(parsed, dict)).
		return fetchResult{}, newNetworkError(fmt.Sprintf("envpit: EnvPit returned an invalid JSON response from %s", url))
	}

	return fetchResult{snapshot: snapshot, etag: resp.Header.Get("Etag")}, nil
}

var errBodyTooLarge = errors.New("envpit: response body exceeded max size")

// readCapped reads at most cap+1 bytes (never buffering an unbounded body before the cap is
// checked, AC-SEC-SDK3-2(a)) and reports errBodyTooLarge if the response was larger than cap.
func readCapped(r io.Reader, cap int64) ([]byte, error) {
	limited := io.LimitReader(r, cap+1)
	body, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > cap {
		return nil, errBodyTooLarge
	}
	return body, nil
}

// mapTransportError maps a low-level net/http failure (DNS/connect/timeout/connection-reset) to
// a NetworkError, with %w-wrapping so errors.Is(err, context.DeadlineExceeded) etc. still works
// through the wrapper. Every transport failure — including the bd:envpit-4dbm class (a
// mid-connection TCP reset: pod killed mid-request, an LB idle-timeout race, a NAT/firewall
// RST) — must map here; none may escape as a raw, unwrapped net/syscall error.
func mapTransportError(url string, err error) *NetworkError {
	return newNetworkErrorWrap(
		fmt.Sprintf("envpit: could not reach EnvPit at %s: %s — check your network/proxy and https://status.envpit.com",
			url, describeFailure(err)),
		err,
	)
}

func describeFailure(err error) string {
	if err == nil {
		return "unknown error"
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return "timed out"
	}
	if isConnectionReset(err) {
		return "the connection was reset before a response was received"
	}
	return err.Error()
}

// isConnectionReset recognizes the bd:envpit-4dbm error shape: a server that accepted the
// connection, read the request, then closed with zero response bytes (a real RST, or a clean
// FIN that surfaces to the caller as an unexpected/plain EOF depending on OS timing — both are
// "the connection was reset before a response was received" from the caller's point of view,
// and neither may be allowed to escape unwrapped).
func isConnectionReset(err error) bool {
	if errors.Is(err, syscall.ECONNRESET) {
		return true
	}
	if errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}
	if errors.Is(err, io.EOF) {
		return true
	}
	var opErr *net.OpError
	if errors.As(err, &opErr) && (opErr.Op == "read" || opErr.Op == "write") {
		return true
	}
	return false
}
