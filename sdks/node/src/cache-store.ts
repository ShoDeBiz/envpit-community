import type { ConfigSnapshot } from './types.js';

/**
 * What `EnvpitClient` caches for one loaded environment: the last snapshot it fetched, the
 * `ETag` that came with it (used for the next request's conditional `If-None-Match`), and when
 * it was fetched. This is the exact triple `EnvpitClient` used to hold as three separate private
 * fields (`snapshot`/`etag`/`fetchedAt`) before the `CacheStore` seam below — grouped here so a
 * store implementation has one thing to persist, not three.
 */
export interface CacheEntry {
  snapshot: ConfigSnapshot;
  etag: string | null;
  fetchedAt: Date;
}

/**
 * Minimal storage seam for where `EnvpitClient` keeps its one cached entry (bd:envpit-ckv2).
 * `InMemoryCacheStore` below is the only implementation shipped in this release — memory-only,
 * never persisted, matching the documented contract in `README.md` §"Caching & resilience". This
 * interface exists so a future opt-in disk-backed store (`README.md`'s roadmap: "Optional
 * encrypted disk cache") can satisfy the same contract and be swapped in via
 * `EnvpitClientOptions` without any change to `EnvpitClient`'s refresh/read logic — a new
 * implementation file, not a rewrite of `client.ts`.
 *
 * Deliberately NOT a general multi-key cache (no `get(key)`/`set(key, value)`): this SDK caches
 * exactly one snapshot per client instance (one environment per `EnvpitClient`), so the store's
 * shape mirrors that — a single slot, read/replaced/cleared as a whole. Adding key-addressing
 * now, before there is a second cache-worthy value, would be speculative generality this bd item
 * explicitly says to avoid.
 */
export interface CacheStore {
  /** The currently cached entry, or `null` if nothing has been cached yet (or `clear()` was
   *  called and nothing has replaced it since). */
  get(): CacheEntry | null;
  /** Replaces the cached entry wholesale — there is no partial update. */
  set(entry: CacheEntry): void;
  /** Empties the store. Not currently called by `EnvpitClient` (stale-while-revalidate never
   *  evicts on a failed refresh — see `client.ts`'s class doc), but part of the seam so a future
   *  caller (e.g. an explicit `client.reset()`, or a disk store's own eviction policy) has a
   *  well-defined way to do it. */
  clear(): void;
}

/** Default (and, in this release, only) `CacheStore` — an in-process field, never written to
 *  disk. `EnvpitClient` depends only on the `CacheStore` interface above, never on this concrete
 *  class, so a disk-backed store can conform to the same shape later without touching
 *  `client.ts`. */
export class InMemoryCacheStore implements CacheStore {
  private entry: CacheEntry | null = null;

  get(): CacheEntry | null {
    return this.entry;
  }

  set(entry: CacheEntry): void {
    this.entry = entry;
  }

  clear(): void {
    this.entry = null;
  }
}
