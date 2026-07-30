/**
 * Unit tests for the `CacheStore` seam (`src/cache-store.ts`, bd:envpit-ckv2) — exercised
 * directly, no `EnvpitClient` involved. `EnvpitClient`'s own behavior against this seam (a
 * failed background refresh keeps serving the cached snapshot, a 304 bumps `fetchedAt` without
 * replacing the snapshot/etag) stays covered by `test/client.test.ts`'s existing
 * stale-while-revalidate suite — unchanged by this seam, which is the point of it.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryCacheStore, type CacheEntry, type CacheStore } from '../src/cache-store.js';

function makeEntry(overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    snapshot: { values: { K: 'v' }, secretKeys: [] },
    etag: '"etag-1"',
    fetchedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('InMemoryCacheStore', () => {
  it('get() returns null before anything has been set', () => {
    const store: CacheStore = new InMemoryCacheStore();
    expect(store.get()).toBeNull();
  });

  it('set() then get() returns the exact entry set (snapshot, etag, fetchedAt all preserved)', () => {
    const store: CacheStore = new InMemoryCacheStore();
    const entry = makeEntry();
    store.set(entry);
    expect(store.get()).toEqual(entry);
  });

  it('a second set() wholesale-replaces the first — no merge of the two entries', () => {
    const store: CacheStore = new InMemoryCacheStore();
    store.set(makeEntry({ etag: '"etag-1"' }));
    const second = makeEntry({
      snapshot: { values: { K: 'v2' }, secretKeys: ['K'] },
      etag: '"etag-2"',
      fetchedAt: new Date('2026-01-02T00:00:00Z'),
    });
    store.set(second);
    expect(store.get()).toEqual(second);
  });

  it('clear() empties the store back to null', () => {
    const store: CacheStore = new InMemoryCacheStore();
    store.set(makeEntry());
    store.clear();
    expect(store.get()).toBeNull();
  });

  it('clear() on an already-empty store is a no-op, not an error', () => {
    const store: CacheStore = new InMemoryCacheStore();
    expect(() => store.clear()).not.toThrow();
    expect(store.get()).toBeNull();
  });

  it('two independent InMemoryCacheStore instances do not share state', () => {
    const a = new InMemoryCacheStore();
    const b = new InMemoryCacheStore();
    a.set(makeEntry({ etag: '"a"' }));
    expect(b.get()).toBeNull();
  });

  it('etag: null (server sent no ETag header) round-trips through the store, distinct from "no entry"', () => {
    const store: CacheStore = new InMemoryCacheStore();
    store.set(makeEntry({ etag: null }));
    expect(store.get()).not.toBeNull();
    expect(store.get()?.etag).toBeNull();
  });
});
