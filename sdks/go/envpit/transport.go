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
	// secretKeys are the key NAMES the server flagged is_secret=true (bd:envpit-durd,
	// AC-SEC-E11) — never values, and never checked for membership in snapshot (a name absent
	// from snapshot excludes nothing — test-vectors/resolve-body.json's
	// "secret-key-absent-from-values-is-tolerated" case).
	secretKeys []string
	etag       string
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

	snapshot, secretKeys, err := parseResolveEnvelope(body)
	if err != nil {
		// bd:envpit-durd (AC-SEC-E11, test-vectors/resolve-body.json's own `description`): a body
		// that parses as JSON but is not the `{values, secretKeys}` envelope — including the
		// pre-durd bare map, which this SDK deliberately does NOT accept as a legacy fallback (see
		// parseResolveEnvelope's doc comment) — is a malformed response, not a distinct new
		// failure mode. BOTH branches below map onto the same NetworkError CLASS as any other
		// invalid-JSON-body condition (error-mapping.json's "invalid-json-body" case); only the
		// message differs, never the type.
		if errors.Is(err, errMalformedEnvelope) {
			// Names the likely CAUSE rather than only the symptom: the most probable way to reach
			// this is a current SDK pointed at an older self-hosted server, and a bare "invalid
			// JSON response" sends someone hunting a network or proxy fault they do not have.
			// Same reasoning as Node's and Python's wording for this condition.
			return fetchResult{}, newNetworkError(fmt.Sprintf(
				"envpit: EnvPit returned a config-resolve response this SDK does not understand (from %s); "+
					"expected {values, secretKeys}. An EnvPit server predating the secret-labelling change "+
					"returns a bare key/value map instead — if you self-host, upgrade the server", url))
		}
		// errInvalidJSONBody — the body was never a JSON object (proxy error page, truncated
		// stream, garbage). Unchanged wording, and asserted verbatim by
		// test-vectors/error-messages.json's `invalid-json-response` case.
		return fetchResult{}, newNetworkError(fmt.Sprintf("envpit: EnvPit returned an invalid JSON response from %s", url))
	}

	return fetchResult{snapshot: snapshot, secretKeys: secretKeys, etag: resp.Header.Get("Etag")}, nil
}

// parseResolveEnvelope's two internal sentinels — neither one's text is ever surfaced; fetchConfig
// re-wraps them into the caller-facing messages above. They exist to keep two genuinely different
// failures apart: errInvalidJSONBody means the body was not a JSON object at all (a proxy error
// page, a truncated stream, garbage), while errMalformedEnvelope means the body WAS a JSON object
// but not this envelope — overwhelmingly a server predating bd:envpit-durd. Collapsing them into
// one message would tell someone whose reverse proxy returned HTML to go upgrade their EnvPit
// server.
var errMalformedEnvelope = errors.New("envpit: malformed resolve-body envelope")
var errInvalidJSONBody = errors.New("envpit: response body is not a JSON object")

// parseResolveEnvelope strictly decodes the post-bd:envpit-durd config-resolve wire body:
// `{"values": {key: string|null, ...}, "secretKeys": [string, ...]}` (test-vectors/
// resolve-body.json, AC-SEC-E11) — both resolve routes' identical @ApiResponse schema, see
// config-resolve.controller.ts in the main repo.
//
// The pre-durd bare `{key: value}` map is REJECTED, not accepted as a legacy fallback: a bare
// map is indistinguishable from `secretKeys: []`, which every native-env-merge caller (env.go)
// would read as "this environment has no secrets" and merge production secrets into the process
// environment while reporting that none were found. There were zero published SDK releases when
// this landed, so failing loudly against a pre-durd server is the safe direction with nothing
// real to break. Both `values` and `secretKeys` are REQUIRED keys — a body missing either, or
// carrying `secretKeys` as anything but an array of strings, or `values` as anything but an
// object with string-or-null cell values (including a literal JSON `null` for `values` itself),
// is rejected the same way. An unrecognized extra top-level field is silently ignored (forward
// compatibility — only `values`/`secretKeys` are load-bearing).
func parseResolveEnvelope(body []byte) (ConfigSnapshot, []string, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		// Malformed JSON, or a non-object top-level value (array/number/bool/string all fail to
		// unmarshal into a map type) — Go's typed unmarshal target gives us this validation for
		// free, matching Python's isinstance(parsed, dict) check. Distinct sentinel from the
		// envelope violations below: this body was never a config-resolve response at all, so
		// telling the caller their SERVER is out of date would point them at the wrong thing.
		return nil, nil, errInvalidJSONBody
	}
	if raw == nil {
		// A literal JSON `null` body decodes to a nil map with no error for a map target — the
		// one non-object shape the unmarshal above does NOT reject on its own.
		return nil, nil, errInvalidJSONBody
	}

	valuesRaw, hasValues := raw["values"]
	secretKeysRaw, hasSecretKeys := raw["secretKeys"]
	if !hasValues || !hasSecretKeys {
		// Covers the pre-durd bare map (neither key present), `{}` (ambiguous between "pre-durd,
		// empty environment" and "new server that dropped both fields" — rejected either way so
		// the envelope check stays total), and a body missing exactly one of the two keys.
		return nil, nil, errMalformedEnvelope
	}

	var values map[string]*string
	if err := json.Unmarshal(valuesRaw, &values); err != nil {
		// Rejects `values` as a non-object (array/number/bool/string) or an object containing a
		// non-string, non-null cell value (e.g. a bare number — every config value crosses the
		// wire as a JSON string or null, unchanged from the pre-durd contract).
		return nil, nil, errMalformedEnvelope
	}
	if values == nil {
		// `"values": null` decodes to a nil map with no unmarshal error for a map target — reject
		// explicitly. `"values": {}` (the legitimate empty-environment case) decodes to a
		// non-nil, empty map and is NOT caught by this check.
		return nil, nil, errMalformedEnvelope
	}

	var secretKeys []string
	if err := json.Unmarshal(secretKeysRaw, &secretKeys); err != nil {
		// Rejects `secretKeys` as anything but a JSON array of strings — a bare string (iterable
		// character-by-character in several other languages) or an array containing a non-string
		// element both fail here.
		return nil, nil, errMalformedEnvelope
	}
	if secretKeys == nil {
		secretKeys = []string{}
	}

	return ConfigSnapshot(values), secretKeys, nil
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
