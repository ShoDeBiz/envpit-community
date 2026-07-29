# Example — NestJS + EnvPit

A minimal NestJS app that resolves config from a real EnvPit server through the **published**
`@envpit/sdk` (from npm, not a workspace link), merges it into `process.env`, and only *then*
builds the Nest module graph — specifically, before `@nestjs/config`'s `ConfigModule` reads the
environment. This product's own API is NestJS with `@nestjs/config`, so this is the natural
integration point for anyone building on EnvPit the way EnvPit builds itself.

See `../node/index.mjs` for why this class of example exists at all (a real HTTP call through a
real registry dependency, because every SDK unit test mocks the transport).

## Why the bootstrap is written the way it is

`src/main.ts` calls `EnvpitClient.load()` and `client.mergeIntoProcessEnv()` FIRST, and only
afterward does `await import('./app.module')` — a **dynamic** import, not
`import { AppModule } from './app.module'` at the top of the file. This was verified against the
installed `@nestjs/config` source, not assumed:

- `node_modules/@nestjs/config/dist/config.service.js` — `ConfigService#get()` reads
  `process.env` **live**, on every call, when no `validate`/`validationSchema` option is given
  (`config.service.js:180`). For that bare case, EnvPit-merge-vs-boot ordering genuinely would
  not matter.
- `node_modules/@nestjs/config/dist/config.module.js` — `ConfigModule.forRoot({ validate })`
  calls `options.validate(config)` **synchronously, inline, no `await`** — the moment
  `@Module({ imports: [ConfigModule.forRoot(...)] })`'s decorator argument is evaluated. In
  JavaScript/TypeScript, a class decorator's arguments are evaluated the instant the class is
  defined — i.e. the instant `app.module.ts` is *imported*, not when `NestFactory.create()`
  finishes building the app.

This example uses `ConfigModule.forRoot({ validate })` (`src/config.schema.ts`, a Zod schema —
matching this product's own Zod-everywhere convention, see the root `CLAUDE.md`), because a bare
`ConfigModule.forRoot({ isGlobal: true })` with no validator would not have exposed the ordering
hazard at all (per the live-read behavior above). With `validate`, a **static** top-of-file
`import { AppModule } from './app.module'` in `main.ts` is hoisted by the module system and
evaluates `app.module.ts` — and therefore `validateConfig()` — before `bootstrap()`'s body runs
at all, silently (well, loudly — see below) validating an environment EnvPit hasn't populated
yet.

### Getting this wrong — reproduced

Swapping the dynamic import for a static one and moving the `EnvpitClient` calls after it
reproduces the crash immediately, before `EnvpitClient.load()` even starts:

```
ZodError: [
  {
    "expected": "string",
    "code": "invalid_type",
    "path": ["GREETING"],
    "message": "Invalid input: expected string, received undefined"
  }
]
    at Object.validateConfig [as validate] (dist/config.schema.js:20:48)
    at ConfigModule.forRoot (node_modules/@nestjs/config/dist/config.module.js:88:45)
    at Object.<anonymous> (dist/app.module.js:23:35)
    ...
```

That's the real failure this bootstrap ordering avoids.

## Run against production (`https://envpit.com`)

1. Sign in at https://envpit.com, then in a project:
   - create an **environment** (e.g. `dev`)
   - add a **variable**, e.g. `GREETING` = `Hello from EnvPit`
   - create an **API key** scoped to that project/environment and copy the raw key (shown once)
2. Install, build, and run:
   ```bash
   npm install
   ENVPIT_API_KEY=<raw key> npm start
   ```
   (`npm start` runs `tsc` then `node dist/main.js`.)

## Run against a local dev stack (`http://localhost:8080`)

```bash
ENVPIT_API_KEY=<raw key> ENVPIT_HOST=http://localhost:8080 npm start
```

## Options

| env var                | default               | meaning                                              |
|------------------------|-----------------------|-------------------------------------------------------|
| `ENVPIT_API_KEY`       | *(required)*          | raw API key from the EnvPit dashboard                 |
| `ENVPIT_HOST`          | `https://envpit.com`  | API host (scheme+authority, no path)                  |
| `ENVPIT_REQUIRED_KEY`  | `GREETING`            | which resolved key `config.schema.ts` requires exist  |
| `PORT`                 | `3000`                | port the Nest app listens on                          |

`ENVPIT_REQUIRED_KEY` exists so this schema doesn't hardcode a key name specific to one test
account — point it at whatever variable your project/environment actually has.

## What correct output looks like

Boot log:

```
[envpit] secret-flagged keys : HOMER_KEY
[envpit] merged into env     : DB_URL, GREETING, MOELSOE
[envpit] withheld (secret)   : (none)
[envpit] skipped (existing)  : (none)
[envpit] withheld (secret)   : HOMER_KEY
[envpit] OK -- no secret-flagged key is present in process.env

[Nest] ... Starting Nest application...
[Nest] ... ConfigHostModule dependencies initialized
[Nest] ... ConfigModule dependencies initialized
[Nest] ... AppModule dependencies initialized
[Nest] ... AppController {/}:
[Nest] ... Mapped {/, GET} route
[Nest] ... Mapped {/healthz, GET} route
[Nest] ... Nest application successfully started
[envpit-nestjs] listening on http://localhost:3000
```

`GET /`:

```json
{
  "sampleRead": { "key": "DB_URL", "presentViaConfigService": true },
  "mergedKeys": ["DB_URL", "GREETING", "MOELSOE"],
  "secretFlaggedKeys": ["HOMER_KEY"],
  "secretKeysLeakedIntoProcessEnv": []
}
```

`GET /healthz`: `{"ok":true}`

`sampleRead.presentViaConfigService` is a **presence check**, not the value — it's read through
`ConfigService.get()`, proving `@nestjs/config` itself (not `@envpit/sdk` directly) sees the
merged config. `secretKeysLeakedIntoProcessEnv` is re-checked live against `process.env` on
every request and must always be `[]`.

## A note on the secret demo

A secret with **no value** in an environment is *absent*, not *withheld* — the SDK's null check
runs before its secret check, so an unset secret never appears in `merged.skippedSecrets`. The
live test environment this was verified against has `HOMER_KEY` flagged secret with **no
value**, so `withheld (secret)` prints `(none)`. That's not the filter failing — there's nothing
to withhold. Flag a variable secret **and** give it a value in the dashboard to exercise the
filter for real.

## What this demonstrates

- `EnvpitClient.load()` + `client.mergeIntoProcessEnv()` running before `@nestjs/config`'s
  `ConfigModule.forRoot()` is ever evaluated — verified against the installed source, not
  guessed.
- `ConfigService.get()` (the ordinary `@nestjs/config` API) seeing EnvPit's merged config with
  zero `@envpit/sdk` imports inside the controller.
- The same "secret-flagged keys never reach `process.env`" assertion as the Express/plain-Node
  examples, asserted against the real environment.

## Files

- `src/main.ts` — bootstrap: EnvPit load/merge, then dynamic-import the Nest module graph.
- `src/app.module.ts` — plain `@Module` + `ConfigModule.forRoot({ validate })`.
- `src/config.schema.ts` — the Zod validator whose timing this whole example is about.
- `src/app.controller.ts` — `GET /` (proves the merge via `ConfigService`) and `GET /healthz`.
- `src/envpit-registry.ts` — non-Nest, no-DI plumbing so the controller can show what EnvPit
  resolved, without turning this into a custom-provider tutorial.
