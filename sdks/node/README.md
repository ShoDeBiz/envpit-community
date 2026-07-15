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
console.log(envpit.get('DATABASE_URL'));    // sync read from the in-memory snapshot
```

That's it — `envpit.get()` never makes a network call; the snapshot refreshes automatically
in the background every 60 seconds.

## API

```ts
const envpit = await EnvpitClient.load({
  apiKey: 'epk_...',          // optional — defaults to process.env.ENVPIT_API_KEY
  host: 'https://envpit.com', // optional — override for self-hosted/local dev
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
