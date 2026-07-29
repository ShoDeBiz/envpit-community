# EnvPit + Gin example

A minimal [Gin](https://github.com/gin-gonic/gin) web service that pulls its config from a real
EnvPit server through the **published** Go SDK
(`github.com/ShoDeBiz/envpit-community/sdks/go/envpit@v0.1.1`, resolved from `proxy.golang.org` —
this module's `go.mod` has **no `replace` directive** to the local SDK checkout).

## Why this exists

Every Go SDK test in this repo (`sdks/go/envpit/*_test.go`) uses a fake HTTP transport. That
proves the client behaves as designed; it does not prove the design matches the *server* —
those diverged once already, when the resolve body changed from a bare map to
`{ values, secretKeys }`. This is the smallest thing that would have caught that class of bug:
a real dependency from the real module proxy, making a real HTTP call to the real API.

## What it demonstrates

The whole selling point of `Client.MergeIntoEnv`: EnvPit config is merged into the **process
environment once, at startup, before the app reads anything** — so ordinary
`os.Getenv("SOME_KEY")` code (Gin's own config idiom; Gin has no `@Value`/`application.yml`
equivalent to hook into) works completely untouched.

Startup does exactly this, in order:
1. `envpit.Load(ctx, ...)` — one authenticated fetch of the environment's config.
2. `client.MergeIntoEnv()` — zero-option (safe default): secret-flagged keys are **excluded**,
   and an existing `os.Environ` value always wins over EnvPit's.
3. Re-derive secret-absence **independently** of the SDK's own result struct: for every key
   `client.SecretKeys()` reports, call `os.LookupEnv(key)` against the real process
   environment. If any secret-flagged key is actually present, the server refuses to start.
4. Serve `GET /config`, which reports what step 1–3 found — **key NAMES only, never a config
   value** — plus a live re-check via `os.LookupEnv`.

## Run it

Credentials live outside the repo (`~/.envpit-example.env`, `chmod 600`), pointed at a real
**production** environment (read-only usage):

```bash
set -a; . ~/.envpit-example.env; set +a
cd examples/go-gin
go run .
```

Optional: point at a different EnvPit host (e.g. local dev) with `ENVPIT_HOST=http://localhost:8080`
(no built-in env fallback for host — only `ENVPIT_API_KEY` has one — see the SDK's `options.go`).

Then in another terminal:

```bash
curl -s http://localhost:8081/config | python3 -m json.tool
```

## What correct output looks like

Startup log (this repo's real environment has three ordinary keys and one secret-flagged key,
`HOMER_KEY`, that currently has **no value set** — a null value is "absent," not "withheld",
so it never appears in `skipped (secret)`; see `env.go`'s doc comment on check order):

```
envpit: config merged into process environment (key NAMES only, no values printed)
  merged            : [DB_URL GREETING MOELSOE]
  skipped (existing): []
  skipped (secret)  : []
  secret-flagged keys in this environment: 1
  secret keys confirmed ABSENT from process env (os.LookupEnv): true
  sample: os.Getenv("DB_URL") now readable by ordinary code = true
```

`GET /config` response:

```json
{
    "mergedKeys": ["DB_URL", "GREETING", "MOELSOE"],
    "note": "key NAMES only — no config value is ever included in this response",
    "sampleMergedKey": "DB_URL",
    "sampleMergedKeyReadableViaGetenv": true,
    "secretKeyCount": 1,
    "secretKeysConfirmedAbsentFromEnv": true,
    "skippedExistingKeys": [],
    "skippedSecretKeys": []
}
```

`secretKeysConfirmedAbsentFromEnv: true` is the load-bearing assertion: it is computed by
calling `os.LookupEnv` on every name `client.SecretKeys()` returns, not by trusting
`MergeResult.SkippedSecrets` (which — correctly, per the check-order rule — never even lists a
secret whose value was null to begin with).

## Verify

```bash
go build ./...   # no errors
go vet ./...     # no errors
gofmt -l .       # no output = already formatted
```

## Notes / SDK friction points

- `WithHost` has no `ENVPIT_HOST`-style environment fallback the way `WithAPIKey` falls back to
  `ENVPIT_API_KEY` — an app that wants a host override has to wire `os.Getenv("ENVPIT_HOST")`
  itself (done here, matching `examples/node/index.mjs`'s convention). Minor, but worth noting
  since the API key side gets this for free and the host side doesn't.
- Everything else matched the README/source exactly on the first read — `MergeIntoEnv`,
  `WithOverride`/`WithIncludeSecrets`/`WithOnly`/`WithExclude`, and `SecretKeys()` all behaved
  precisely as documented in `sdks/go/envpit/env.go` and `client.go` against the real server.
