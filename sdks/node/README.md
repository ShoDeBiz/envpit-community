# @envpit/sdk

Official Node.js/TypeScript SDK for [EnvPit](https://envpit.com) — configuration & secrets
management without enterprise complexity.

> **Status:** Phase 1 (core client). SSE/realtime push, framework adapters (NestJS/Express/
> Next.js), feature flags, and other-language SDKs (Python/Go/Java) are follow-ups — see
> [Roadmap](#roadmap) below.

## Quickstart

```bash
npm install @envpit/sdk
export ENVPIT_API_KEY="epk_..."   # Project → API Keys → New key (pin it to one environment)
```

```ts
import { EnvpitClient } from '@envpit/sdk';

const envpit = await EnvpitClient.load();   // reads ENVPIT_API_KEY, fetches your environment's config once

// Option A — merge into process.env, keep your existing code untouched (secrets excluded by default):
envpit.mergeIntoProcessEnv();
console.log(process.env['DATABASE_URL']); // the code you already have, unmodified

// Option B — read from the client directly (always current, see "Native env merge" below):
console.log(envpit.get('DATABASE_URL'));
```

`envpit.get()` never makes a network call; the snapshot refreshes automatically in the
background every 60 seconds. `mergeIntoProcessEnv()` is a one-shot write — see below.

## Native env merge — `process.env`

If your app already reads config the ordinary Node way (`process.env.DATABASE_URL`), you don't
have to rewrite it to call `envpit.get(...)` everywhere. `mergeIntoProcessEnv()` writes the
client's currently-loaded snapshot straight into `process.env`, once:

```ts
const envpit = await EnvpitClient.load();
const result = envpit.mergeIntoProcessEnv();
// result = { merged: ['DATABASE_URL', 'PORT', ...], skippedExisting: ['ALREADY_SET_KEY'], skippedSecrets: ['DB_PASSWORD'] }

// Existing code, unchanged:
const db = process.env.DATABASE_URL;
```

`options` is entirely optional — the zero-arg call above is the SAFE default. Four rules, by
design (not accidents — read before you rely on them):

1. **Opt-in, not automatic.** `load()` never touches `process.env` on its own. You call
   `mergeIntoProcessEnv()` explicitly, and only where you want the side effect.
2. **Secrets are excluded by default.** The config-resolve response carries a `secretKeys` list
   (key NAMES only) alongside the values, and `mergeIntoProcessEnv()` uses it: any key flagged
   secret is left out of `process.env` unless you pass `{ includeSecrets: true }`. Excluded keys
   are reported in `result.skippedSecrets` — see the exposure this trades away below before
   opting in.
3. **A value already in `process.env` always wins.** Unlike `dotenv`, this SDK never silently
   overrides a var your deploy environment, secret manager, or container orchestrator already
   set — that's the one thing the person who ran your deploy is trusting to stay in their
   control. Pass `{ override: true }` to flip that, only if EnvPit should be authoritative.
   `override` never smuggles a secret through on its own — a secret still needs
   `includeSecrets: true` too, because the secret check runs before the existing-key check.
4. **Boot-time snapshot, not live.** `process.env` is a plain object with no refresh hook.
   A value written by `mergeIntoProcessEnv()` will NOT move again on a later realtime/poll
   `change` — call it again after a `change` event if you need it to catch up, or keep using
   `envpit.get(...)` (always reads the current in-memory snapshot) for anything that must stay
   current without you wiring that yourself.

### ⚠️ `includeSecrets` — the environment-variable exposure it accepts

`includeSecrets: true` is a real, per-key filter, not just an acknowledgment — but naming it at
the call site IS the acknowledgment that every secret-flagged value currently loaded will be
written into `process.env`. Environment variables are a known secret-exposure surface:
they're inherited by every child process you spawn, many APM/error-reporting tools serialize
the whole environment on a crash, they're readable at `/proc/<pid>/environ` on Linux, and some
logging setups dump the environment at startup. Before passing `{ includeSecrets: true }` for
an environment that holds production secrets, decide whether that exposure is acceptable for
your deployment — if not, keep using `envpit.get('SECRET_KEY')` for secret values and let the
zero-arg `mergeIntoProcessEnv()` merge only the rest.

`client.secretKeys()` exposes the same secret-flagged key NAMES (never values) the merge uses
internally, so you can write your own filter over a hand-rolled config object without
re-fetching anything.

### Framework notes

`mergeIntoProcessEnv()` is a plain SDK method — it works in any Node process, but a few
frameworks have their own config-loading order you need to respect:

- **Express / Fastify** — no framework-owned env pipeline; call `await envpit.mergeIntoProcessEnv(...)`
  as the very first thing in your entrypoint, before you `import`/`require` any app module that
  reads `process.env.X` at module-load time (same ordering rule `dotenv` itself requires).
- **NestJS** — if you use `@nestjs/config`'s `ConfigModule.forRoot()`, note that it typically
  runs as a side effect of importing `AppModule`, which (via ES module hoisting) happens
  *before* any code in your `main.ts` function body runs — so a plain top-of-`main.ts` call is
  usually too late. The robust fix is a Node preload: run the merge in a separate script and
  load it before your entrypoint is even parsed, e.g. `node --import ./envpit-bootstrap.mjs
  dist/main.js` (Node's `--import` preload flag; needs Node ≥18.18 — this package's own
  `engines` floor is 18.17, one patch below, so verify your runtime before relying on it. Older
  Node/CJS builds: the equivalent `--require` preload works the same way). This is general
  `@nestjs/config` behavior from framework documentation, not verified against your specific
  app — check your own `ConfigModule.forRoot()` call order if in doubt.
- **Next.js** — split verdict, please read both halves:
  - **Server-only env vars, Node.js runtime** (Server Components, Route Handlers, Server
    Actions, `getServerSideProps`): works. Call `mergeIntoProcessEnv()` from an
    `instrumentation.ts` `register()` hook (guarded with `if (process.env.NEXT_RUNTIME ===
    'nodejs')` — `register()` also runs under the Edge runtime, which has no real, mutable
    `process.env`), which Next.js runs once at server start, before any request is handled.
  - **`NEXT_PUBLIC_*` client-exposed vars: does NOT work, full stop.** Next.js/webpack inlines
    `process.env.NEXT_PUBLIC_X` as a literal string at `next build` time — long before any
    server process exists to run this SDK's runtime merge. No runtime `process.env` write can
    change an already-built client bundle. If you need EnvPit-managed values in the browser,
    you need a build-time integration (fetch-and-inline during `next build`), which this SDK
    does not provide — don't reach for `mergeIntoProcessEnv()` here, it will silently do
    nothing useful for `NEXT_PUBLIC_*` consumers.

## API

```ts
const envpit = await EnvpitClient.load({
  apiKey: 'epk_...',          // optional — defaults to process.env.ENVPIT_API_KEY
  host: 'https://envpit.com', // optional — defaults to process.env.ENVPIT_HOST, then the cloud (self-hosted/local dev)
  pollIntervalMs: 60_000,     // optional — 0 disables background refresh
  timeoutMs: 5_000,           // optional — per-request timeout
});
// `load()` fetches the environment's config once and resolves with a ready-to-read client;
// it rejects if the first fetch fails (no cache exists yet to fall back to).

envpit.get('KEY');                    // raw string, throws MissingKeyError if unset
envpit.get('KEY', 'default');         // returns 'default' instead of throwing
envpit.getString('KEY');              // alias of get()
envpit.getInt('KEY');                 // parses as integer, throws TypeMismatchError if invalid
envpit.getBoolean('KEY');             // accepts true/false/1/0/yes/no/on/off (case-insensitive)

envpit.secretKeys();  // readonly string[] — NAMES only of every secret-flagged key, never values
envpit.cacheInfo;   // { fetchedAt: Date | null, ageMs: number | null, lastError: Error | null }
envpit.stop();       // stops the background refresh timer
```

### Errors

All errors extend `EnvpitError` (itself a real `Error`), so `instanceof` works for both
catch-all and precise handling:

| Class | When |
|---|---|
| `AuthenticationError` | API key rejected (revoked/expired/mistyped/IP-blocked) |
| `NetworkError` | Couldn't reach EnvPit, timed out, or got a non-auth error response |
| `MissingKeyError` | `get*()` called for a key that isn't set, with no default given |
| `TypeMismatchError` | `getInt()`/`getBoolean()` couldn't parse the stored value |

```ts
import { EnvpitClient, AuthenticationError } from '@envpit/sdk';

try {
  const envpit = await EnvpitClient.load();
} catch (err) {
  if (err instanceof AuthenticationError) {
    // bad/revoked API key — fail fast at boot
  }
  throw err;
}
```

### Caching & resilience

- **Memory-only, never persisted to disk** — decrypted secret values never sit in plaintext
  on disk. There is no opt-in disk cache in this release.
- **Stale-while-revalidate** — once the first load succeeds, a *background* refresh failure
  (network error/timeout/5xx) never throws: the SDK keeps serving the last good snapshot and
  records the failure on `envpit.cacheInfo.lastError`. Only `EnvpitClient.load()` itself
  rejects on failure, since there is nothing to fall back to yet.
- **Polling, not push (yet)** — the SDK refreshes on a fixed interval (`pollIntervalMs`,
  default 60s). Realtime push (SSE) is a tracked follow-up, not implemented in this release.

## Roadmap (not in this release)

- Realtime refresh via SSE + `onChange()` subscribe/callback API
- Framework adapters: NestJS (`EnvPitModule`), Express middleware, Next.js server helper
- Feature flag evaluation (`envpit.flags().isEnabled(...)`)
- Optional encrypted disk cache (opt-in only)
- Python / Go / Java SDKs (same contract, idiomatic per language)

## Security notes

- Standard HTTPS/TLS certificate validation only — this SDK never disables cert checks.
- The API key is sent via the `X-Api-Key` header, never a query parameter, never logged.
- Config values are never written to disk by this SDK.

## License

MIT
