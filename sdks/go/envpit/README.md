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

## Native environment integration (`os.Getenv`, no code changes)

Go has no framework-level config convention to hook into (no Spring `@Value`, no Node
`process.env` auto-population) — `os.Getenv` already *is* the idiom. `Client.MergeIntoEnv`
writes the client's currently-loaded snapshot into the real process environment via
`os.Setenv`, so code you already have that calls `os.Getenv("DATABASE_URL")` sees
EnvPit-managed values with zero changes:

```go
client, err := envpit.Load(ctx)
if err != nil { log.Fatal(err) }

client.MergeIntoEnv()          // one-time, boot-time-only write into os.Environ — see below
dbURL := os.Getenv("DATABASE_URL") // your existing code, completely unmodified
```

**Boot-time snapshot, not a live view.** `MergeIntoEnv` is never called for you automatically
and never re-runs — a later poll tick, SSE push, or reconnect catch-up that changes the
in-memory snapshot does **not** reach back into `os.Environ`. This mirrors every other
language's native mechanism: `process.env` is a snapshot once Node's bootstrap assigns to it;
a Spring `@Value`-injected field resolves once at bean construction unless you additionally
opt into `@RefreshScope`. If a value needs to update live, keep reading it through
`Client.Get*`/`Client.Changes(ctx)` instead of `os.Getenv`.

**Existing `os.Environ` values always win by default.** A key already present in the process
environment (checked via `os.LookupEnv` at call time) is left untouched — `MergeIntoEnv` only
fills gaps, it never clobbers whatever your orchestrator/`.env` loader/`docker run -e` already
set. Pass `envpit.WithOverride()` to invert that.

```go
result := client.MergeIntoEnv(
    envpit.WithOverride(),        // EnvPit wins over an existing os.Environ value
    // envpit.WithIncludeSecrets(),        // opt in to writing secret-flagged values too (see below)
    envpit.WithOnly("PORT", "API_URL"), // merge ONLY these keys — see "Secrets" below
    // envpit.WithExclude("INTERNAL_DEBUG_FLAG"), // or: merge everything EXCEPT these
)
fmt.Println(result.Merged, result.SkippedExisting, result.SkippedSecrets, result.Errors)
// all three lists deterministic/sorted; Errors is nil unless an os.Setenv call itself
// failed (e.g. a NUL byte in a value)
```

**Secrets are excluded by default.** `GET /api/v1/config` returns `{values, secretKeys}`
(bd:envpit-durd) — `secretKeys` names every key the server flagged `is_secret=true`. The
zero-option `MergeIntoEnv()` call excludes every key named there, reporting it in
`result.SkippedSecrets`; only `WithIncludeSecrets()` opts a call into writing secret values
into the real process environment (inherited by every child process, commonly captured whole
by crash reporters/APM agents, readable at `/proc/<pid>/environ` on Linux — naming the option
at the call site IS the acknowledgment of that exposure, there is no second flag). Check
order per key: a null value is never written or counted; a secret-flagged key is skipped
(`SkippedSecrets`) unless `WithIncludeSecrets()`; an already-present key is skipped
(`SkippedExisting`) unless `WithOverride()` — the secret check runs BEFORE the existing-key
check, so `WithOverride()` alone can never smuggle a secret through. `Client.SecretKeys()`
exposes the same key names (sorted, values-free) if you want to build your own filter without
re-fetching. `WithOnly`/`WithExclude` compose WITH this filter, never around it: naming a
secret's key in `WithOnly` does not pull it through on its own — see `MergeIntoEnv`'s doc
comment for the full worked-through interaction and its own tests.

**Concurrency.** Calling `MergeIntoEnv` concurrently with other Go code's `os.Getenv`/
`os.Setenv` calls is safe at the pure-Go level — the stdlib (`syscall/env_unix.go`) guards all
of them with one internal `sync.RWMutex`, so there's no Go-level race or corruption. The real
hazard is **cgo**: C code your program links (some DNS resolver modes, certain database
driver bindings, anything calling `getenv`/`setenv` from C) reads the process's raw `environ`
directly and is **not** covered by that Go-level lock — a well-known class of Go/cgo
environment-mutation bugs. Call `MergeIntoEnv` once, synchronously, immediately after
`Load`/`NewClient` returns and before your program spawns other goroutines or does anything
that might invoke cgo — the same "configure before you fork workers" discipline you'd apply
to any other one-time boot step.

## Framework integration — Viper, Gin/Fiber/Echo

**Viper:** no dedicated integration is built, and none is planned as part of this feature.
Viper's own [`AutomaticEnv()`/`BindEnv()`](https://github.com/spf13/viper) already read from
`os.Environ` — once `MergeIntoEnv()` has run, Viper (or any other env-reading library) picks
up EnvPit-managed values for free, with zero extra code and zero extra dependency. A
dedicated `viper.RemoteProvider` implementation was considered (Viper does expose that
extension point) and rejected: it would require adding Viper as a dependency to a package
that is otherwise zero-runtime-dependency by design (`doc.go`, ADR-S3-02), and it would only
re-implement — worse, and redundantly alongside — the refresh model `Client` already has.
`MergeIntoEnv()` + Viper's existing env support is strictly simpler and gives the same result.

**Gin / Fiber / Echo:** none of the three has any config-loading convention to hook into —
they are HTTP routers, not config frameworks (no `@Value`, no `application.yml` equivalent).
No dedicated middleware/integration is built for the same reason a Viper integration isn't:
there is no extension point to plug into, and the natural call site — `os.Getenv` in `main()`
before `gin.New()`/`fiber.New()`/`echo.New()` — is already exactly what `MergeIntoEnv()`
enables with zero framework-specific code.

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

result := client.MergeIntoEnv(      // one-time boot-time write into os.Environ — see above
    envpit.WithOverride(),          // EnvPit wins over an existing os.Environ value (default: it doesn't)
    envpit.WithIncludeSecrets(),    // opt in to secret-flagged values too (default: excluded)
    envpit.WithOnly("PORT"),        // allowlist — or envpit.WithExclude("SOME_KEY") for a denylist
)

secretKeys := client.SecretKeys()   // sorted key NAMES the current snapshot flagged secret

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
- `MergeIntoEnv` writes into the REAL process environment (`os.Setenv`), which is a strictly
  bigger exposure surface than this SDK's own in-memory cache — inherited by every child
  process, readable at `/proc/<pid>/environ`, often captured whole by crash reporters. It is
  never called automatically, and it excludes secret-flagged keys by default (bd:envpit-durd)
  — see "Native environment integration" above for the full check order and for
  `WithIncludeSecrets()`/`WithOnly`/`WithExclude`.

## Requirements

Go ≥ 1.22. Zero runtime dependencies — stdlib `net/http`/`encoding/json`/`crypto/sha256` only.

Release tags for this module follow `sdks/go/envpit/vX.Y.Z` (the module's own subdirectory path)
so `go get` resolves it correctly from this multi-language monorepo.
