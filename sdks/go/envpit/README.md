# EnvPit — Go SDK

Official Go SDK for [EnvPit](https://envpit.com) — configuration & secrets management without
enterprise complexity.

## Quickstart

```bash
go get github.com/ShoDeBiz/envpit-community/sdks/go/envpit
export ENVPIT_API_KEY="epk_..."   # an environment-pinned key: Project → API Keys → New key
```

```go
import "github.com/ShoDeBiz/envpit-community/sdks/go/envpit"

client, err := envpit.Load(ctx)          // fetches your environment's config once
if err != nil {
    log.Fatal(err)                       // first load failing is fatal by design — no cache exists yet
}
dbURL, err := client.Get("DATABASE_URL") // in-memory read — never a network call
```

Run it — you should see your value. That's it: every `Get*` after `Load` is an in-memory lookup;
the snapshot auto-refreshes in the background.

> Module path note: the package lives at `sdks/go/envpit` (not `sdks/go`), so the import path's
> last segment (`envpit`) already matches the package name — no import alias needed, unlike a
> naive `sdks/go` layout would have forced.

Want change notifications? Range over a channel — context cancellation IS the unsubscribe:

```go
for evt := range client.Changes(ctx) {
    log.Printf("config changed: %v", evt.ChangedKeys)   // key names only — values never appear in events
}
```

## API

```go
client, err := envpit.Load(ctx,
    envpit.WithAPIKey("..."),           // falls back to the ENVPIT_API_KEY environment variable
    envpit.WithHost("https://envpit.com"),
    envpit.WithPollInterval(60*time.Second), // 0 disables ALL background refresh, including realtime
    envpit.WithTimeout(5*time.Second),
    envpit.WithHTTPClient(myClient),     // the fetchImpl injection seam — also used for the SSE connection
    envpit.WithLogger(myLogger),         // pass nil to silence; default is a slog.Default()-backed logger
)

dbURL, err := client.Get("DATABASE_URL")     // (string, error) — *MissingKeyError when absent
dbURL       := client.GetOr("DATABASE_URL", "postgres://local") // default-taking, never errors on missing

port, err := client.GetInt("PORT")
port      := client.GetIntOr("PORT", 8080)   // present-but-unparsable: returns 8080 AND reports
                                              // once via the logger + Errors(ctx) — see below

enabled, err := client.GetBool("MAINTENANCE_MODE")   // true/1/yes/on, false/0/no/off (case-insensitive)
enabled      := client.GetBoolOr("MAINTENANCE_MODE", false)

changes := client.Changes(ctx)      // <-chan envpit.ChangeEvent — closed on ctx.Done() or Close()
conns   := client.Connections(ctx)  // <-chan envpit.ConnectionEvent
errs    := client.Errors(ctx)       // <-chan error — background-refresh failures + Or-family fallbacks

info := client.CacheInfo()          // FetchedAt / Age / LastError / Etag / RefreshMode / ...
client.Close()                      // stops background refresh + realtime; safe to call more than once
```

Or use the package-level sugar for the common single-client case (`envpit.Load` also installs the
returned client as the package default):

```go
client, err := envpit.Load(ctx)
dbURL, err  := envpit.Get("DATABASE_URL")   // delegates to the same default client
envpit.Close()
```

**`GetOr`/`GetIntOr`/`GetBoolOr` semantics (the one place Go's lack of default arguments forces an
explicit call, encoded in the shared test-vector suite so it's a decision, not drift):** a
*missing* key returns your default silently. A *present-but-unparsable* value (e.g.
`GetIntOr("PORT", 8080)` when `PORT="abc"`) also returns your default, but is NOT silent — it's
reported once via the logger and once on `Errors(ctx)`, value-free (never echoing the raw stored
value). The non-`Or` getters (`GetInt`/`GetBool`) still return `*TypeMismatchError` for an
unparsable value, same as every other language.

**Subscribing is channel-based, not callback-based**, and this eliminates a whole class of bug by
construction: your handler code runs in *your* goroutine when you range over `Changes(ctx)`, never
inside the SDK's own dispatch path — a panic in your handler is your ordinary Go panic with your
ordinary stack trace, not something the SDK has to catch. A slow or abandoned reader never blocks
the SDK either way: each subscriber channel is buffered (16) with a non-blocking send; a full
buffer drops the event (state is always current via `Get*`, so a dropped *notification*
self-heals) and `client.ChangesDropped()`/`ConnectionsDropped()`/`ErrorsDropped()` count every
drop.

## Errors

Every SDK error implements `envpit.EnvpitError` (an interface, not a class hierarchy — Go idiom),
and both `errors.As` (typed) and `errors.Is` (sentinel) work:

| Type | Sentinel | When |
|---|---|---|
| `*AuthenticationError` | `envpit.ErrAuthentication` | No API key found, or the server rejected it (HTTP 401/403) |
| `*NetworkError` | `envpit.ErrNetwork` | DNS/connect/timeout/connection-reset, a non-2xx response, or an invalid/oversized response |
| `*MissingKeyError` | `envpit.ErrMissingKey` | `Get`/`GetInt`/`GetBool` called for a key that isn't set and no default was given (`.Key`) |
| `*TypeMismatchError` | `envpit.ErrTypeMismatch` | `GetInt`/`GetBool` couldn't parse the stored value (`.Key`, `.ExpectedType`) |

```go
var mk *envpit.MissingKeyError
if errors.As(err, &mk) {
    log.Printf("missing key: %s", mk.Key)
}
if errors.Is(err, envpit.ErrNetwork) {
    // wrapped transport failures still unwrap through to the underlying cause too, e.g.
    // errors.Is(err, context.DeadlineExceeded) for a timeout.
}
```

A mid-connection TCP reset (a pod killed mid-request, a load-balancer idle-timeout race, a
NAT/firewall RST) is always mapped to `*NetworkError` — on the initial `Load` call AND on every
background refresh, where it's also delivered on `Errors(ctx)` — never left to escape as a raw,
unwrapped `net`/`syscall` error.

No config value or API key ever appears in an error message or log line (one narrow, documented
exception shared with Node/Python: `TypeMismatchError` echoes the offending raw value itself, e.g.
`got "abc"` — that value is what you passed to a typed getter, never a secret by construction of
the typed-getter path; the Go-only `GetIntOr`/`GetBoolOr` fallback report is deliberately
value-free instead, since it has no such Node/Python-parity excuse).

## Caching & resilience

- Memory-only. Nothing is ever written to disk — no cache file, no temp file.
- Stale-while-revalidate: a background refresh failure never propagates from `Get*` — the last
  good snapshot keeps serving reads, and the failure is recorded on `client.CacheInfo()`.
- Realtime push (SSE) is an optimization; the poll interval is always the correctness backstop,
  independent of the realtime channel's health.
- Every background refresh (poll tick, push signal, reconnect catch-up) funnels through ONE
  coalescing goroutine — at most one HTTP request is ever in flight, which makes out-of-order
  refresh resolution structurally impossible rather than something that needs guarding.
- `Close()` cancels all background work promptly and is safe to call more than once.

## Security notes

- Auth is sent as `X-Api-Key`, never `Authorization` — a separate trust boundary from any session
  auth your app has.
- No SDK option exists to skip TLS verification. `net/http`'s default transport verifies
  certificates; this SDK never disables that, and never exposes an option that could.
- `fmt.Sprintf("%v"/"%+v"/"%#v", client)` never include the API key or any config value — Go
  prints unexported struct fields via reflection by default, so every type that holds the key or
  the resolved config snapshot (the client, the options, the realtime transport) explicitly
  overrides `String()`/`GoString()` to redact.
- Response bodies and realtime stream lines are size-capped (5 MiB / 64 KiB respectively) so a
  misbehaving or compromised server can't exhaust client memory.

## Requirements

Go ≥ 1.22. Zero runtime dependencies — stdlib `net/http`/`encoding/json`/`crypto/sha256` only.

Release tags for this module follow `sdks/go/envpit/vX.Y.Z` (the module's own subdirectory path)
so `go get` resolves it correctly from this multi-language monorepo.
