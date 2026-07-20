# POC — fetch config from EnvPit via the Node SDK

A minimal "dummy" app proving the full EnvPit loop end-to-end: a project's config value,
created in the EnvPit dashboard, pulled into a running app through the published SDK — no mocks,
a real HTTP call to a real EnvPit instance.

## Run against production (`https://envpit.com`)

1. Sign in at https://envpit.com, then in a project:
   - create an **environment** (e.g. `dev`)
   - add a **variable**, e.g. `GREETING` = `Hello from EnvPit`
   - create an **API key** scoped to that project/environment and copy the raw key
     (shown once).
2. Run:
   ```bash
   ENVPIT_API_KEY=<raw key> node index.mjs
   ```

## Run against a local dev stack (`http://localhost:8080`)

Same as above but point the SDK at the local single-origin Caddy edge:
```bash
ENVPIT_API_KEY=<raw key> ENVPIT_HOST=http://localhost:8080 node index.mjs
```

## Options

| env var           | default              | meaning                                  |
|-------------------|----------------------|------------------------------------------|
| `ENVPIT_API_KEY`  | *(required)*         | raw API key from the EnvPit dashboard    |
| `ENVPIT_HOST`     | `https://envpit.com` | API host (scheme+authority, no path)     |
| `ENVPIT_KEY`      | `GREETING`           | which config key to read and print       |

## What it demonstrates

- `EnvpitClient.load()` — one authenticated fetch of the resolved config for the key's scope.
- `client.get('GREETING')` — synchronous in-memory read afterward (background polling keeps it fresh).
- Real error surfacing (`AuthenticationError`, `MissingKeyError`, `NetworkError`, …) with a
  non-zero exit code, so a broken key/scope is obvious rather than silent.

This is the client half; the server half (project + env + variable + key) is created in the
EnvPit UI. Together they are the "create a dummy project → show its config from prod" proof.
