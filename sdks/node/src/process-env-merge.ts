import type { ConfigSnapshot } from './types.js';

/**
 * Options for `EnvpitClient#mergeIntoProcessEnv` (bd:envpit-yvyr — owner directive 2026-07-27:
 * "ให้ immerge กับวิธีดั้งเดิมได้จะดีสุด ไม่ใช้เรียกจากตัวแปรพิเศษ" — existing
 * `process.env.DATABASE_URL`-style code should keep working untouched, instead of every
 * caller being forced through `envpit.get(...)`).
 *
 * bd:envpit-durd (AC-SEC-E11) landed the per-key `secretKeys` flag on the config-resolve wire
 * shape, so this SDK can now tell secret-flagged keys apart from ordinary ones — the mandatory
 * `acknowledgeSecretsMayBeIncluded: true` blanket acknowledgment this interface used to require
 * is gone. `includeSecrets` below is a REAL per-key filter, not just a loud acknowledgment: the
 * whole options object is optional, and the zero-arg call (`envpit.mergeIntoProcessEnv()`) is
 * the safe default — see `mergeSnapshotIntoEnv`'s doc comment for the exact check order.
 */
export interface MergeIntoProcessEnvOptions {
  /**
   * Also write secret-flagged keys (`ConfigSnapshot.secretKeys`) into the target? Default
   * `false` — the zero-option call merges only non-secret keys. Naming `includeSecrets: true`
   * at the call site IS the acknowledgment that this writes decrypted secret values into
   * `process.env`, where they are inherited by every child process you spawn, frequently
   * serialized whole by APM/crash-reporting tools on a crash, and readable at
   * `/proc/<pid>/environ` on Linux. There is no second flag — see the package README, "Secrets
   * & native env merge", before enabling this for an environment holding production secrets.
   */
  includeSecrets?: boolean;
  /**
   * Overwrite a key that's already set in the target (`process.env`)? Default `false` — an
   * env var the host process already had (deploy-time secret manager, `.env` loaded by
   * something else, container orchestrator) always wins; EnvPit never silently clobbers it,
   * unlike `dotenv`'s override-nothing-by-default-but-callers-often-flip-it convention. Set
   * `true` only if EnvPit is meant to be the authoritative source for these keys.
   *
   * `override` never smuggles a secret past the `includeSecrets` check — the secret check runs
   * BEFORE the existing-key check (see `mergeSnapshotIntoEnv`), so `{ override: true }` alone
   * still excludes secrets unless `includeSecrets: true` is ALSO given.
   */
  override?: boolean;
}

/** Result of a `mergeSnapshotIntoEnv`/`mergeIntoProcessEnv` call — which keys actually moved,
 *  and why the rest didn't, for logging/testing/introspection. All three lists are sorted
 *  alphabetically (deterministic, never in fetch-response key order) and carry key NAMES
 *  only — never values, log-safe by construction (same rationale as `ChangeEvent.changedKeys`
 *  in `client.ts`). */
export interface MergeIntoProcessEnvResult {
  /** Keys written into the target because they were absent, or `override: true` let a
   *  present-in-EnvPit value replace an existing one. */
  merged: readonly string[];
  /** Keys left untouched because the target already had them and `override` was not `true`.
   *  Never includes a secret-flagged key — a secret skipped for lack of `includeSecrets` is
   *  reported in `skippedSecrets` instead, even if the target also already had it (the secret
   *  check runs first — see `mergeSnapshotIntoEnv`). */
  skippedExisting: readonly string[];
  /** Secret-flagged keys (`ConfigSnapshot.secretKeys`) that were withheld because
   *  `includeSecrets` was not `true`. A secret whose value is `null` in this environment is
   *  never listed here — see `mergeSnapshotIntoEnv`'s null-check-first ordering. */
  skippedSecrets: readonly string[];
}

/**
 * Pure core of `EnvpitClient#mergeIntoProcessEnv` — takes an explicit `target` object instead
 * of reaching for the real `process.env`, so it's unit-testable without mutating real global
 * state (`EnvpitClient#mergeIntoProcessEnv` is the thin wrapper that passes `process.env`).
 *
 * Per-key check order (bd:envpit-durd, `test-vectors/env-merge.json` `notes.checkOrder` — this
 * exact order is asserted by that vector suite, not incidental):
 *   1. A `null` value (EnvPit's key-set-but-unresolved / tombstone representation, same as
 *      every `get*()` getter's missing-vs-null equivalence in `client.ts#readRaw`) is absent —
 *      never written, never counted in ANY result list. This deliberately avoids ever writing
 *      the literal string `"null"` into `process.env`.
 *   2. A key in `snapshot.secretKeys` is skipped into `skippedSecrets` unless
 *      `options.includeSecrets` is `true` — checked BEFORE the existing-key check, so a secret
 *      is reported under the reason that actually governs it (and `override: true` alone can
 *      never smuggle a secret through).
 *   3. A key already present in `target` is skipped into `skippedExisting` unless
 *      `options.override` is `true`.
 *   4. Otherwise the key is written and reported in `merged`.
 */
export function mergeSnapshotIntoEnv(
  snapshot: ConfigSnapshot,
  target: Record<string, string | undefined>,
  options: MergeIntoProcessEnvOptions = {},
): MergeIntoProcessEnvResult {
  const secretKeySet = new Set(snapshot.secretKeys);
  const includeSecrets = options.includeSecrets === true;
  const override = options.override === true;

  const merged: string[] = [];
  const skippedExisting: string[] = [];
  const skippedSecrets: string[] = [];

  for (const [key, value] of Object.entries(snapshot.values)) {
    if (value === null) continue;

    if (secretKeySet.has(key) && !includeSecrets) {
      skippedSecrets.push(key);
      continue;
    }

    const hasExisting = target[key] !== undefined;
    if (hasExisting && !override) {
      skippedExisting.push(key);
      continue;
    }

    target[key] = value;
    merged.push(key);
  }

  merged.sort();
  skippedExisting.sort();
  skippedSecrets.sort();
  return { merged, skippedExisting, skippedSecrets };
}
