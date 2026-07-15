import { MissingKeyError, TypeMismatchError } from './errors.js';
import { fetchConfig } from './transport.js';
import type { CacheInfo, ConfigSnapshot, EnvpitClientOptions } from './types.js';

const DEFAULT_HOST = 'https://envpit.com';
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);
const INTEGER_PATTERN = /^-?\d+$/;

/**
 * `const envpit = await EnvpitClient.load({ apiKey?, host?, ... });` — the Node/TS core client
 * (public API shape per `outputs/SPEC-envpit-0t2z-1a-architecture.md` §1 and the published
 * quick-start in `outputs/SPEC-envpit-0t2z-1b-ux.md` §A1). One bulk fetch per environment
 * (`GET /api/v1/config`, key-scope-inferred from the API key — no project/environment id
 * needed); every `get*()` call after `load()` resolves is a synchronous, in-memory read —
 * never a network call.
 *
 * Caching (owner-confirmed contract, see bd:envpit-0t2z.2 notes): memory-only, never
 * persisted to disk. Background refresh uses stale-while-revalidate — a failed refresh keeps
 * serving the last good snapshot and records the failure on `cacheInfo`, it never throws or
 * evicts the cache. Only the FIRST load throws (there is nothing to fall back to yet), which
 * `load()` surfaces as a rejected Promise — a caller can never hold a half-initialized client.
 */
export class EnvpitClient {
  private readonly apiKey: string;
  private readonly host: string;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  private snapshot: ConfigSnapshot | null = null;
  private fetchedAt: Date | null = null;
  private lastError: Error | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  private constructor(options: EnvpitClientOptions) {
    const apiKey = options.apiKey ?? process.env['ENVPIT_API_KEY'];
    if (!apiKey) {
      throw new Error(
        'EnvPit: no API key found. Set the ENVPIT_API_KEY environment variable, or pass { apiKey } to `EnvpitClient.load(...)`.',
      );
    }
    this.apiKey = apiKey;
    this.host = (options.host ?? DEFAULT_HOST).replace(/\/+$/, '');
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * The SDK's only entry point — replaces the old two-step `new EnvPit(options);
   * await client.start();`. Constructs the client, fetches the environment's config once
   * (rejects on failure — no cache exists yet to fall back to), and — unless
   * `pollIntervalMs` is `0` — starts a background refresh timer. Resolves with a
   * ready-to-read client; every `get*()` call on the result is synchronous.
   */
  static async load(options: EnvpitClientOptions = {}): Promise<EnvpitClient> {
    const client = new EnvpitClient(options);
    await client.bootstrap();
    return client;
  }

  private async bootstrap(): Promise<void> {
    await this.refresh({ isFirstLoad: true });
    if (this.pollIntervalMs > 0) {
      this.timer = setInterval(() => {
        void this.refresh({ isFirstLoad: false });
      }, this.pollIntervalMs);
      // Never keep the host process alive just for background polling (Node-only API; a
      // no-op in non-Node fetch-compatible runtimes where `.unref` doesn't exist).
      this.timer.unref?.();
    }
  }

  /** Stops the background refresh timer. Idempotent. The last snapshot remains readable. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Point-in-time cache freshness/health — see `CacheInfo` for field meaning. */
  get cacheInfo(): CacheInfo {
    return {
      fetchedAt: this.fetchedAt,
      ageMs: this.fetchedAt ? Date.now() - this.fetchedAt.getTime() : null,
      lastError: this.lastError,
    };
  }

  /** Raw string read. Throws `MissingKeyError` if the key is absent/null and no
   *  `defaultValue` is given. */
  get(key: string, defaultValue?: string): string {
    const raw = this.readRaw(key);
    if (raw !== undefined) return raw;
    if (defaultValue !== undefined) return defaultValue;
    throw new MissingKeyError(key);
  }

  /** Alias of `get()` — explicit typed-getter naming to match the other 3 getters. */
  getString(key: string, defaultValue?: string): string {
    return this.get(key, defaultValue);
  }

  /** Parses the value as a base-10 integer. Throws `TypeMismatchError` if it isn't one. */
  getInt(key: string, defaultValue?: number): number {
    const raw = this.readRaw(key);
    if (raw === undefined) {
      if (defaultValue !== undefined) return defaultValue;
      throw new MissingKeyError(key);
    }
    const trimmed = raw.trim();
    if (!INTEGER_PATTERN.test(trimmed)) {
      throw new TypeMismatchError(key, 'integer', raw);
    }
    return Number.parseInt(trimmed, 10);
  }

  /** Parses the value as a boolean. Accepts (case-insensitive) true/false, 1/0, yes/no,
   *  on/off. Throws `TypeMismatchError` for anything else. */
  getBoolean(key: string, defaultValue?: boolean): boolean {
    const raw = this.readRaw(key);
    if (raw === undefined) {
      if (defaultValue !== undefined) return defaultValue;
      throw new MissingKeyError(key);
    }
    const normalized = raw.trim().toLowerCase();
    if (TRUE_VALUES.has(normalized)) return true;
    if (FALSE_VALUES.has(normalized)) return false;
    throw new TypeMismatchError(key, 'boolean', raw);
  }

  private readRaw(key: string): string | undefined {
    // Structurally unreachable via the public API: `load()` never returns a client without a
    // successful first fetch (it rejects instead). Kept as a defensive guard, not a documented
    // failure mode — see the removed pre-`EnvpitClient` test that covered this on the old
    // constructor+`.start()` two-step shape.
    if (this.snapshot === null) {
      throw new Error('EnvPit: config not loaded yet — this should be unreachable via EnvpitClient.load().');
    }
    const value = this.snapshot[key];
    return value === null || value === undefined ? undefined : value;
  }

  private async refresh({ isFirstLoad }: { isFirstLoad: boolean }): Promise<void> {
    try {
      const data = await fetchConfig({
        host: this.host,
        apiKey: this.apiKey,
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs,
      });
      this.snapshot = data;
      this.fetchedAt = new Date();
      this.lastError = null;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.lastError = error;
      // Stale-while-revalidate: once we have a snapshot, a refresh failure is recorded on
      // `cacheInfo` but never thrown/propagated — the last good snapshot keeps serving reads.
      if (isFirstLoad || this.snapshot === null) {
        throw error;
      }
    }
  }
}
