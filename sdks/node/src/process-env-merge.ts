import type { ConfigSnapshot } from './types.js';

/**
 * Options for `EnvpitClient#mergeIntoProcessEnv` (bd:envpit-yvyr — owner directive 2026-07-27:
 * "ให้ immerge กับวิธีดั้งเดิมได้จะดีสุด ไม่ใช้เรียกจากตัวแปรพิเศษ" — existing
 * `process.env.DATABASE_URL`-style code should keep working untouched, instead of every
 * caller being forced through `envpit.get(...)`).
 *
 * ⚠️ SECURITY-RELEVANT CONSTRAINT (read before using): `GET /v1/config` (and the explicit
 * `/v1/projects/:id/environments/:id/config` route) returns a FLAT `key -> value` map — it does
 * NOT report which keys are secret-flagged. Verified server-side: `ConfigService`'s resolve
 * path (`apps/api/src/config-management/config.service.ts`, `resolveEnvironmentSecretsInternal`)
 * deliberately discards `row.isSecret` after using it to decide whether to decrypt, returning
 * only the decrypted-or-plain string. So THIS SDK HAS NO WAY to merge "only the non-secret
 * keys" — it can only merge everything in the loaded snapshot, or nothing. `getEnvironmentFingerprint`/the
 * dashboard-only `ProjectSecretsController_list` (`GET /v1/projects/:id/secrets`) DOES carry a
 * secret flag, but is JWT-only (`security: [{ bearer: [] }]` in `contract/openapi.json`) — an
 * API-key-authenticated SDK client can never call it. A true "exclude secrets automatically"
 * mode requires an API contract change (per-key `isSecret` added to the resolve response, or an
 * API-key-reachable secret-key-names endpoint) — out of scope for this SDK-only change; flagged
 * back to the owner (see hand-off notes on bd:envpit-yvyr). Owner confirmed 2026-07-28 this is a
 * real protocol gap (not just unwritten SDK code) and is working the server-side fix; the exact
 * spot the resulting per-key filter will plug into is marked "FUTURE FILTER EXTENSION POINT" in
 * `mergeSnapshotIntoEnv` below. Deliberately NOT approximated with a key-name heuristic in the
 * meantime (owner's explicit correction) — see that marker for why.
 *
 * Given that constraint, `acknowledgeSecretsMayBeIncluded` is a required, loud acknowledgment
 * rather than a real filter — it does not (and structurally cannot, today) selectively exclude
 * secret-flagged values. See the environment-variable hazards this trades against in the
 * package README, "Secrets & native env merge".
 */
export interface MergeIntoProcessEnvOptions {
  /**
   * Must be literally `true`. There is no default — every call site must type this out. Setting
   * it is an explicit acknowledgment that calling `mergeIntoProcessEnv()` writes EVERY
   * non-null key in this client's current snapshot into `process.env`, including any
   * secret-flagged values, because (see the interface doc above) this SDK cannot tell the two
   * apart from the resolve response alone. Environment variables are inherited by every child
   * process, are frequently serialized whole by APM/error-reporting tools on crash, and are
   * readable at `/proc/<pid>/environ` on Linux — do not enable this for an environment holding
   * production secrets without accepting that exposure.
   */
  acknowledgeSecretsMayBeIncluded: true;
  /**
   * Overwrite a key that's already set in the target (`process.env`)? Default `false` — an
   * env var the host process already had (deploy-time secret manager, `.env` loaded by
   * something else, container orchestrator) always wins; EnvPit never silently clobbers it,
   * unlike `dotenv`'s override-nothing-by-default-but-callers-often-flip-it convention. Set
   * `true` only if EnvPit is meant to be the authoritative source for these keys.
   */
  override?: boolean;
}

/** Result of a `mergeSnapshotIntoEnv/mergeIntoProcessEnv` call — which keys actually moved,
 *  for logging/testing/introspection. Both lists are sorted alphabetically (deterministic,
 *  never in fetch-response key order). Never carries values — key NAMES only, log-safe by
 *  construction (same rationale as `ChangeEvent.changedKeys` in `client.ts`). */
export interface MergeIntoProcessEnvResult {
  /** Keys written into the target because they were absent, or `override: true` let a
   *  present-in-EnvPit value replace an existing one. */
  merged: readonly string[];
  /** Keys left untouched because the target already had them and `override` was not `true`. */
  skippedExisting: readonly string[];
}

/**
 * Pure core of `EnvpitClient#mergeIntoProcessEnv` — takes an explicit `target` object instead
 * of reaching for the real `process.env`, so it's unit-testable without mutating real global
 * state (`EnvpitClient#mergeIntoProcessEnv` is the thin wrapper that passes `process.env`).
 *
 * A `null` value in `snapshot` (EnvPit's key-set-but-unresolved / tombstone representation,
 * same as every `get*()` getter's missing-vs-null equivalence in `client.ts#readRaw`) is
 * treated as absent: never written, never counted in either result list. This deliberately
 * avoids ever writing the literal string `"null"` into `process.env`.
 */
export function mergeSnapshotIntoEnv(
  snapshot: ConfigSnapshot,
  target: Record<string, string | undefined>,
  options: MergeIntoProcessEnvOptions,
): MergeIntoProcessEnvResult {
  // Runtime guard for plain-JS callers a type-checker can't stop (same precedent as
  // `resolveScopeOverride` in client.ts: an options-shape mistake is a caller-code bug, a
  // plain synchronous `Error`, not an `EnvpitError` — that hierarchy models server/config-read
  // failures, not local input validation).
  if (options.acknowledgeSecretsMayBeIncluded !== true) {
    throw new Error(
      'EnvPit: mergeIntoProcessEnv() requires `{ acknowledgeSecretsMayBeIncluded: true }`. This ' +
        'SDK cannot tell secret-flagged keys apart from ordinary ones in the resolved config — ' +
        'setting this is an explicit acknowledgment that EVERY key currently loaded, including ' +
        'any secrets, will be written into process.env. See the README, "Secrets & native env ' +
        'merge", before enabling this.',
    );
  }

  const merged: string[] = [];
  const skippedExisting: string[] = [];

  for (const [key, value] of Object.entries(snapshot)) {
    if (value === null) continue;

    // ---- FUTURE FILTER EXTENSION POINT (bd:envpit-yvyr) ----
    // Once `GET /v1/config`'s response carries per-key secret metadata (owner is changing
    // `apps/api/src/config-management/config.service.ts`'s resolve path — currently it
    // decrypts a secret and writes it into the SAME flat `{key: value}` map as everything
    // else, with no `isSecret` field at all, so there is nothing here to read today), a
    // secret-vs-not check belongs RIGHT HERE, before the `target[key] = value` write below —
    // e.g. `if (isSecretKey(key) && options.acknowledgeSecretsMayBeIncluded !== true) { continue; }`.
    // Deliberately NOT implemented as a key-NAME heuristic (`/PASSWORD|TOKEN|SECRET/i.test(key)`
    // or similar) — Oliver's explicit correction, 2026-07-28: that's wrong in both directions
    // (`DATABASE_URL` routinely embeds a password and wouldn't match; a non-secret key merely
    // named `*_TOKEN` would false-positive). Wait for the real per-key flag from the server
    // instead of guessing from the key's spelling.
    // ---------------------------------------------------------

    const hasExisting = target[key] !== undefined;
    if (hasExisting && options.override !== true) {
      skippedExisting.push(key);
      continue;
    }
    target[key] = value;
    merged.push(key);
  }

  merged.sort();
  skippedExisting.sort();
  return { merged, skippedExisting };
}
