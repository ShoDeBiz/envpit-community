# contract/

`openapi.json` is a **committed snapshot** of the public API's OpenAPI 3 document — the same
document `envpit` (main repo) serves live at `/api/docs-json` (`apps/api/src/main.ts`,
`SwaggerModule.setup(OPENAPI_DOCS_PATH, app, buildPublicOpenApiDocument(app))`). Every SDK's HTTP
client is tested against this file offline — no live server needed in SDK CI
(`SPEC-envpit-0t2z-3-1a-architecture.md` §5.4).

## Provenance (this snapshot)

| Field | Value |
|---|---|
| Exported | 2026-07-28 |
| Source commit | `envpit` (main repo) `3b778da` |
| Exported from | the running server's own `GET /api/docs-json` (see "How it was generated") |
| `openapi` | `3.0.0` |
| `info.title` | `EnvPit Public API` |
| `info.version` | `1` |
| Paths | 79 |
| Scoping | `scopeToPublicApiSurface()` (`apps/api/src/common/openapi.ts`) — `/v1/*` only, `/v1/platform/*` (internal operator console) excluded |

## How it was generated

**Changed 2026-07-28**: this snapshot is now taken from the SERVER'S OWN `GET /api/docs-json`
response, not rebuilt from a test harness. Two things forced the change, and both were bugs the
old method could not have surfaced:

1. **The live document was empty.** `bd:envpit-adsq` — `main.ts` applies
   `setGlobalPrefix('api', ...)` before it builds the document, so every path read `/api/v1/...`
   while `scopeToPublicApiSurface`'s allowlist still matched `/v1/` and filtered out
   everything. `https://envpit.com/api/docs-json` served `paths: {}`. The old export method
   never set the global prefix, so it produced a perfectly good-looking document from a server
   that was publishing nothing — a snapshot of something that did not exist. Fixed in
   `3b778da`.
2. **The old snapshot was a subset.** The previous harness imported five modules by hand
   (`AuthModule`, `ProjectModule`, `EnvironmentModule`, `ApiKeyModule`, `ConfigManagementModule`,
   plus `ConfigEventsModule`). Anything outside that hand-maintained list was silently missing.
   The live server builds from the real `AppModule`, which is why this export jumped to 79 paths.

Exporting from the live server means the snapshot cannot disagree with what the server serves —
which is the entire point of a contract file, and is also what makes the drift gate below
implementable at all (it compares against exactly this endpoint).

To re-export against a local dev stack:

```bash
curl -s http://localhost:8080/api/docs-json | python3 -m json.tool > contract/openapi.json
```

Restart the API first if you have just changed route or schema decorators — the dev container's
bind-mount watcher can serve a stale build, and a stale contract snapshot is worse than none.

## Relevant paths for SDK HTTP clients

These are now the REAL wire paths, prefix included — an SDK's hardcoded path constant should
match one of these verbatim. (Before 2026-07-28 this file stored the pre-global-prefix
`/v1/...` shapes and the reader had to remember to prepend `/api` themselves.)

| Path | Method | Used by |
|---|---|---|
| `/api/v1/config` | GET | `sdks/*` config fetch (`X-Api-Key`-scoped alias; Node: `transport.ts`'s `CONFIG_PATH_ALIAS`) |
| `/api/v1/config/events` | GET | `sdks/*` realtime channel (Node: `realtime-transport.ts`'s `CONFIG_EVENTS_PATH`) |
| `/api/v1/projects/{projectId}/environments/{environmentId}/config` | GET | Same resolve endpoint, addressed by explicit project/environment id instead of key-inferred scope |
| `/api/v1/projects/{projectId}/environments/{environmentId}/config/events` | GET | Same realtime endpoint, explicit-id form |

Both resolve paths return `{ "values": {…}, "secretKeys": […] }` as of `bd:envpit-durd` — see
`test-vectors/resolve-body.json` for the shape every SDK must parse, and
`test-vectors/env-merge.json` for what `secretKeys` is then used for.

## Drift gate (not yet wired — Slice 0 hand-off)

Per `SPEC-envpit-0t2z-3-1a-architecture.md` §5.4/R6: a scheduled community-repo CI job should
fetch the live `/api/docs-json` (or a published CI artifact) and diff against this committed
file, failing the scheduled run on drift. **Not built in Slice 0** — no CI exists in this repo
yet at all (tracked separately, `SPEC-envpit-0t2z-3-1a-architecture.md` §5.5/§11 hand-off to
Quinn). Updating this file requires the PR to pass every shipped SDK's suite.

## Known gap (main-repo side, R6)

The main `envpit` repo still does not publish `openapi.json` as a CI artifact or a committed
file of its own — this snapshot is a manual `curl` of a running server, not an automated
export. Flagged to Oliver per Sara's hand-off (§11): a small main-repo task to publish the
document as a CI artifact would let the drift-gate job above fetch it without a server to point
at.

Note this is now a *convenience* gap rather than a correctness one: since 2026-07-28 the
snapshot comes from the same endpoint the drift gate would compare against, so the two can be
diffed byte-for-byte. Under the old harness-rebuild method they could not — the harness produced
a document the server never served, which is exactly how `bd:envpit-adsq` survived undetected.
