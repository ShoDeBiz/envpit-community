package envpit

import "errors"

// EnvpitError is implemented by every error type this SDK returns, so callers can distinguish
// SDK errors from arbitrary errors with a single type assertion/errors.As call — the Go analog
// of Node's `instanceof EnvpitError` / Python's `except EnvpitError`:
//
//	var envpitErr envpit.EnvpitError
//	if errors.As(err, &envpitErr) { ... }
//
// Taxonomy v1 = shipped Node's 4 types (AuthenticationError/NetworkError/MissingKeyError/
// TypeMismatchError) — ADR-S3-08: NotFoundError/RateLimitError/ServerError are a coordinated
// all-4-SDK follow-up (bd:envpit-aw7l), not something this language "fixes" unilaterally.
//
// Never echo the API key or config VALUES in any error message — key names are not secret and
// may appear (INV-SDK-11). One documented, accepted exception: TypeMismatchError echoes the raw
// offending value (shipped-Node/Python parity, ADR-S3-01; Sentinel THREATMODEL-envpit-0t2z-3.md
// F6/INV-SDK-11's one carve-out — values reaching typed getters are overwhelmingly non-secret
// ports/flags). New Go-only surfaces (the Or-family fallback log line) must NOT repeat this
// pattern — see client.go's orFallbackWarning.
type EnvpitError interface {
	error
	isEnvpitError()
}

// Sentinel errors for errors.Is(err, envpit.ErrAuthentication) — the class-based idiom
// (errors.As(err, &authErr)) and the sentinel idiom are both served (Sara §2.2).
var (
	ErrAuthentication = errors.New("envpit: authentication error")
	ErrNetwork        = errors.New("envpit: network error")
	ErrMissingKey     = errors.New("envpit: missing key error")
	ErrTypeMismatch   = errors.New("envpit: type mismatch error")
)

// AuthenticationError — the server rejected the API key (401/403), or no API key was found at
// all when Load/NewClient was called.
type AuthenticationError struct {
	msg string
}

func newAuthenticationError(msg string) *AuthenticationError { return &AuthenticationError{msg: msg} }

func (e *AuthenticationError) Error() string        { return e.msg }
func (e *AuthenticationError) Is(target error) bool { return target == ErrAuthentication }
func (e *AuthenticationError) isEnvpitError()       {}

// NetworkError — transport failure: DNS/connect/timeout/connection-reset, a non-2xx response
// that isn't an auth failure, an invalid/oversized JSON response body, or an
// oversized/malformed realtime stream. Unwrap() exposes the underlying cause (when there is
// one) so errors.Is(err, context.DeadlineExceeded) etc. still works through the wrapper.
type NetworkError struct {
	msg   string
	cause error
}

func newNetworkError(msg string) *NetworkError { return &NetworkError{msg: msg} }

func newNetworkErrorWrap(msg string, cause error) *NetworkError {
	return &NetworkError{msg: msg, cause: cause}
}

func (e *NetworkError) Error() string        { return e.msg }
func (e *NetworkError) Unwrap() error        { return e.cause }
func (e *NetworkError) Is(target error) bool { return target == ErrNetwork }
func (e *NetworkError) isEnvpitError()       {}

// MissingKeyError — Get/GetInt/GetBool called for a key that isn't in the loaded snapshot (or
// whose value is null) and no default was supplied (the non-Or getter family).
type MissingKeyError struct {
	Key string
}

func newMissingKeyError(key string) *MissingKeyError {
	return &MissingKeyError{Key: key}
}

func (e *MissingKeyError) Error() string {
	return "envpit: config key " + quote(e.Key) + " is not set and no default was provided (use GetOr(" +
		quote(e.Key) + ", fallback) if this key is allowed to be absent)"
}

func (e *MissingKeyError) Is(target error) bool { return target == ErrMissingKey }
func (e *MissingKeyError) isEnvpitError()       {}

// TypeMismatchError — GetInt/GetBool (or their Or-family counterparts) could not coerce the
// stored string value. RawValue is the one documented INV-SDK-11 carve-out (see package doc on
// EnvpitError above) — new Go-only surfaces must not repeat this pattern.
type TypeMismatchError struct {
	Key          string
	ExpectedType string
	RawValue     string
}

func newTypeMismatchError(key, expectedType, rawValue string) *TypeMismatchError {
	return &TypeMismatchError{Key: key, ExpectedType: expectedType, RawValue: rawValue}
}

func (e *TypeMismatchError) Error() string {
	return "envpit: config key " + quote(e.Key) + " is not a valid " + e.ExpectedType + " (got " + quote(e.RawValue) + ")"
}

func (e *TypeMismatchError) Is(target error) bool { return target == ErrTypeMismatch }
func (e *TypeMismatchError) isEnvpitError()       {}

// orFallbackWarning is the Go-only Or-family type-mismatch fallback signal (Sara §2.2/R4,
// Sentinel AC-SEC-SDK3-6): logged AND surfaced on Errors(ctx) when GetIntOr/GetBoolOr hits a
// value that doesn't parse — deliberately value-free (unlike TypeMismatchError's carve-out
// above), because this is NEW surface in Go with no Node-parity excuse to echo the raw value.
type orFallbackWarning struct {
	Key          string
	ExpectedType string
}

func (e *orFallbackWarning) Error() string {
	return "envpit: config key " + quote(e.Key) + " is not a valid " + e.ExpectedType + " — returning the supplied default"
}

func (e *orFallbackWarning) isEnvpitError() {}

func quote(s string) string {
	return "\"" + s + "\""
}
