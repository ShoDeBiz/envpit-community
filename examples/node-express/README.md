# Example — Express + EnvPit

A minimal Express app that resolves config from a real EnvPit server through the **published**
`@envpit/sdk` (from npm, not a workspace link), merges it into `process.env` **before** the app
is built, and then never touches `@envpit/sdk` again. That ordering is the whole point: ordinary
`process.env.X` code — route handlers, middleware, anything — works completely untouched.

See `../node/index.mjs` for the plain (no-framework) version of this same proof, and why it
exists: every SDK unit test in this repo mocks the transport, so nothing else here catches a
client/server contract drift (it happened once already — see that file's header comment).

## Run against production (`https://envpit.com`)

1. Sign in at https://envpit.com, then in a project:
   - create an **environment** (e.g. `dev`)
   - add a **variable**, e.g. `GREETING` = `Hello from EnvPit`
   - (optional) flag a variable as a **secret** to see it withheld — see "A note on the secret
     demo" below
   - create an **API key** scoped to that project/environment and copy the raw key (shown once)
2. Install and run:
   ```bash
   npm install
   ENVPIT_API_KEY=<raw key> npm start
   ```

## Run against a local dev stack (`http://localhost:8080`)

```bash
ENVPIT_API_KEY=<raw key> ENVPIT_HOST=http://localhost:8080 npm start
```

## Options

| env var          | default               | meaning                                       |
|------------------|-----------------------|------------------------------------------------|
| `ENVPIT_API_KEY` | *(required)*          | raw API key from the EnvPit dashboard          |
| `ENVPIT_HOST`    | `https://envpit.com`  | API host (scheme+authority, no path)           |
| `PORT`           | `3000`                | port the Express app listens on                |

## What correct output looks like

Boot log:

```
[envpit] secret-flagged keys : HOMER_KEY
[envpit] merged into env     : DB_URL, GREETING, MOELSOE
[envpit] withheld (secret)   : (none)
[envpit] skipped (existing)  : (none)
[envpit] secret, but unset here: HOMER_KEY (nothing to withhold for these — set a value to exercise the filter for real)
[envpit] OK — no secret-flagged key is present in process.env

[envpit-express] listening on http://localhost:3000
```

`GET /`:

```json
{
  "mergedKeys": ["DB_URL", "GREETING", "MOELSOE"],
  "sampleRead": { "key": "DB_URL", "presentInProcessEnv": true },
  "secretFlaggedKeys": ["HOMER_KEY"],
  "secretKeysLeakedIntoProcessEnv": []
}
```

`GET /healthz`: `{"ok":true}`

`secretKeysLeakedIntoProcessEnv` is re-checked live against `process.env` on every request — it
must always be `[]`. That is the actual guarantee this example exists to demonstrate; the merge
summary object is a convenience, not the source of truth.

## A note on the secret demo

A secret with **no value** in an environment is *absent*, not *withheld* — the SDK's null check
runs before its secret check, so an unset secret never appears in `merged.skippedSecrets`. The
live test environment this was verified against has `HOMER_KEY` flagged secret with **no
value**, so `withheld (secret)` prints `(none)` and `HOMER_KEY` shows up under "secret, but unset
here" instead. That is not the filter failing — it's just nothing to withhold. To see an actual
withheld value, flag a variable as secret **and** give it a value in the EnvPit dashboard, then
re-run.

## What this demonstrates

- `EnvpitClient.load()` + `client.mergeIntoProcessEnv()`, called **before** `express()` is even
  constructed — the app body has zero EnvPit-specific code.
- `client.secretKeys()` — key **names** only, never values.
- An explicit runtime assertion (`secretKeysLeakedIntoProcessEnv`, both at boot and on every
  request) that no secret-flagged key ever reaches `process.env`, checked against the real
  environment rather than trusted from the SDK's own summary.
