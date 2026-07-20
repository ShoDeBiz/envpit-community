# contract/

`openapi.json` is a **committed snapshot** of the public API's OpenAPI 3 document — the same
document `envpit` (main repo) serves live at `/api/docs-json` (`apps/api/src/main.ts`,
`SwaggerModule.setup(OPENAPI_DOCS_PATH, app, buildPublicOpenApiDocument(app))`). Every SDK's HTTP
client is tested against this file offline — no live server needed in SDK CI
(`SPEC-envpit-0t2z-3-1a-architecture.md` §5.4).

## Provenance (this snapshot)

| Field | Value |
|---|---|
| Exported | 2026-07-20 |
| Source commit | `envpit` (main repo) `9eb36e5ac2edff16fddc02c516376ac4e3314195` |
| `openapi` | `3.0.0` |
| `info.title` | `EnvPit Public API` |
| `info.version` | `1` |
| Scoping | `scopeToPublicApiSurface()` (`apps/api/src/common/openapi.ts`) — `/v1/*` only, `/v1/platform/*` (internal operator console) excluded |

## How it was generated

There is currently **no CI artifact export** for this document in the main `envpit` repo (a
tracked gap — see "Known gap" below). This snapshot was produced by running the exact same
`DocumentBuilder`/`SwaggerModule.createDocument()` + `scopeToPublicApiSurface()` call chain
`main.ts` uses for the real, live document — via the DI-graph-only test harness
`apps/api/src/config-management/openapi-document.spec.ts` already establishes (fake
DB/Redis/config providers; no query ever executes; every real controller/module is wired for
real, so route/schema/security-scheme metadata is genuine). The two additional relevant
controllers this snapshot pulls in beyond that spec file's own scope: `ConfigEventsModule`
(`GET /v1/config/events` and its scoped alias — the realtime/SSE endpoint the SDK's
`RealtimeTransport` connects to).

## Relevant paths for SDK HTTP clients

| Path | Method | Used by |
|---|---|---|
| `/v1/config` | GET | `sdks/*` config fetch (`X-Api-Key`-scoped alias; Node: `transport.ts`'s `CONFIG_PATH`, served under `/api/v1/config` once the main app's global `api` prefix is applied) |
| `/v1/config/events` | GET | `sdks/*` realtime channel (Node: `realtime-transport.ts`'s `CONFIG_EVENTS_PATH`, served under `/api/v1/config/events`) |
| `/v1/projects/{projectId}/environments/{environmentId}/config` | GET | Same resolve endpoint, addressed by explicit project/environment id instead of key-inferred scope |
| `/v1/projects/{projectId}/environments/{environmentId}/config/events` | GET | Same realtime endpoint, explicit-id form |

Note: this document's `paths` use the pre-global-prefix route shapes NestJS's route registration
sees (`v1/...`); the live server additionally mounts everything under `/api` (`app.setGlobalPrefix('api', ...)`,
`main.ts`) — so the SDK's actual wire path is `{host}/api{path}`, e.g. `{host}/api/v1/config`.
This matches every shipped SDK's hardcoded `CONFIG_PATH`/`CONFIG_EVENTS_PATH` constants.

## Drift gate (not yet wired — Slice 0 hand-off)

Per `SPEC-envpit-0t2z-3-1a-architecture.md` §5.4/R6: a scheduled community-repo CI job should
fetch the live `/api/docs-json` (or a published CI artifact) and diff against this committed
file, failing the scheduled run on drift. **Not built in Slice 0** — no CI exists in this repo
yet at all (tracked separately, `SPEC-envpit-0t2z-3-1a-architecture.md` §5.5/§11 hand-off to
Quinn). Updating this file requires the PR to pass every shipped SDK's suite.

## Known gap (main-repo side, R6)

The main `envpit` repo does not yet publish `openapi.json` as a CI artifact or a committed file
of its own — this snapshot was hand-exported via the test harness described above, not pulled
from an automated export. Flagged to Oliver per Sara's hand-off (§11): a small main-repo task to
publish the document as a CI artifact would let the drift-gate job above fetch it directly
instead of requiring another manual export.
