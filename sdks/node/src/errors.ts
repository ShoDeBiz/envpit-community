/**
 * Typed error hierarchy for the EnvPit SDK (spec: EnvPit_SDK_Design_Specification.md §16;
 * base class name aligned to `outputs/SPEC-envpit-0t2z-1a-architecture.md` §1.4's
 * `EnvpitError` naming). Every SDK error extends `EnvpitError` (itself a real `Error`
 * subclass) so callers can do `instanceof EnvpitError` for a catch-all, or
 * `instanceof AuthenticationError` / `instanceof NetworkError` / `instanceof MissingKeyError` /
 * `instanceof TypeMismatchError` for precise handling — never string-matching `.message`.
 *
 * Never echo the API key or config VALUES in any error message (secret-safety invariant
 * extended from the server's pino-redaction rule into the SDK, per
 * outputs/SPEC-envpit-0t2z-1b-ux.md §A3). Key names are not secret and may appear.
 *
 * `.code`/`.docsAnchor` (bd:envpit-ed3h Part 3): every error carries a stable, machine-readable
 * `code` — safe to pattern-match on instead of `.message` string-matching — plus a `docsAnchor`
 * that resolves to `https://docs.envpit.com/errors${docsAnchor}`
 * (`outputs/SPEC-envpit-0t2z-1b-ux.md` §A3: "Stable machine code per error ... supports
 * ... lets support/AI-assistants pattern-match" and IA rule 2, "Every SDK error links here").
 * These are ADDITIVE fields — `.message` text is deliberately left byte-identical to what's
 * already shipped (`test-vectors/error-messages.json`, consumed cross-language) so this doesn't
 * touch the shared conformance suite.
 */
export abstract class EnvpitError extends Error {
  /** Stable machine-readable code, e.g. `ENVPIT_MISSING_KEY`. Never changes across SDK
   *  versions — safe for programmatic handling/telemetry. */
  abstract readonly code: string;
  /** Docs anchor for this error's troubleshooting entry, e.g. `#missing-key` (always starts
   *  with `#`) — append to `https://docs.envpit.com/errors`. */
  abstract readonly docsAnchor: string;

  protected constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    // Required for `instanceof` to keep working after transpilation down to ES5-era targets
    // (tsup/esbuild output) — TS/Babel's `extends Error` otherwise loses the prototype chain.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The server rejected the API key (401/403) — revoked, expired, mistyped, or IP-blocked. */
export class AuthenticationError extends EnvpitError {
  readonly code = 'ENVPIT_INVALID_API_KEY';
  readonly docsAnchor = '#invalid-api-key';

  constructor(message: string) {
    super(message);
  }
}

/** Transport failure: DNS/connect/timeout, or a non-2xx response that isn't an auth failure. */
export class NetworkError extends EnvpitError {
  readonly code = 'ENVPIT_NETWORK';
  readonly docsAnchor = '#network';

  constructor(message: string) {
    super(message);
  }
}

/** `get()`/`getString()`/`getInt()`/`getBoolean()` called for a key that isn't in the loaded
 *  snapshot (or whose value is `null`) and no default was supplied. */
export class MissingKeyError extends EnvpitError {
  readonly code = 'ENVPIT_MISSING_KEY';
  readonly docsAnchor = '#missing-key';
  readonly key: string;
  /** Nearest known key within edit-distance 2 of `key`, if the caller found one (bd:envpit-ed3h
   *  Part 3 did-you-mean, `outputs/SPEC-envpit-0t2z-1b-ux.md` §A1/§A3) — `undefined` when no
   *  candidate was close enough, or the caller didn't have a known-key set to check against
   *  (e.g. an empty snapshot). The fuzzy-match itself lives in `client.ts` (the only place that
   *  holds the loaded key set) — this file stays a pure taxonomy with zero matching logic. */
  readonly suggestion: string | undefined;

  constructor(key: string, suggestion?: string) {
    const suggestionText = suggestion ? ` Did you mean "${suggestion}"?` : '';
    super(
      `Config key "${key}" is not set and no default value was provided. ` +
        `Pass a default (e.g. envpit.get("${key}", "fallback")) if this key is allowed to be absent.` +
        suggestionText,
    );
    this.key = key;
    this.suggestion = suggestion;
  }
}

/** A typed getter (`getInt`/`getBoolean`) could not coerce the stored string value. */
export class TypeMismatchError extends EnvpitError {
  readonly code = 'ENVPIT_TYPE_MISMATCH';
  readonly docsAnchor = '#type-mismatch';
  readonly key: string;
  readonly expectedType: string;

  constructor(key: string, expectedType: string, rawValue: string) {
    super(`Config key "${key}" is not a valid ${expectedType} (got "${rawValue}").`);
    this.key = key;
    this.expectedType = expectedType;
  }
}
