// Package envpit is the official Go SDK for EnvPit — configuration & secrets management
// without enterprise complexity.
//
//	client, err := envpit.Load(ctx)                        // fetches your environment's config once
//	dbURL, err := client.Get("DATABASE_URL")               // in-memory read — never a network call
//
// One bulk fetch per environment (GET /api/v1/config, key-scope-inferred from the API key —
// no project/environment id needed); every Get*/GetInt*/GetBool* call after Load resolves is a
// synchronous, in-memory read — never a network call (INV-SDK-2).
//
// Caching (owner-confirmed contract, matching the shipped Node/Python SDKs — see
// outputs/SPEC-envpit-0t2z-3-1a-architecture.md §1): memory-only, never persisted to disk
// (INV-SDK-3). Background refresh uses stale-while-revalidate — a failed refresh keeps serving
// the last good snapshot and records the failure on CacheInfo, it never surfaces as an error
// from a Get* call. Only the FIRST call to Load (or NewClient) returns an error (there is
// nothing to fall back to yet) — a caller can never hold a half-initialized client
// (INV-SDK-1).
//
// Realtime: whenever the poll interval is greater than zero, the client ALSO opens a realtime
// (SSE) connection alongside the poll timer. A config-changed push triggers an immediate
// refetch; the poll timer remains the correctness backstop regardless (INV-SDK-8). Subscribe
// via the channel-returning methods Changes/Connections/Errors — context cancellation IS the
// unsubscribe mechanism (idiomatic Go: no separate unsubscribe function is needed).
//
// Concurrency (bd:envpit-1mvf's invariant, Go's own idiomatic mechanism — see
// outputs/SPEC-envpit-0t2z-3-1a-architecture.md §4): every background refresh (poll tick, push
// signal, reconnect catch-up) funnels through ONE coalescing refresher goroutine. At most one
// HTTP request is ever in flight, which eliminates the out-of-order-refresh race BY
// CONSTRUCTION rather than guarding it with a generation counter.
//
// This package has zero runtime dependencies (stdlib only), matching the supply-chain posture
// of the shipped Node/Python SDKs (ADR-S3-02).
package envpit
