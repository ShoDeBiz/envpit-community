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
 */
export abstract class EnvpitError extends Error {
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
  constructor(message: string) {
    super(message);
  }
}

/** Transport failure: DNS/connect/timeout, or a non-2xx response that isn't an auth failure. */
export class NetworkError extends EnvpitError {
  constructor(message: string) {
    super(message);
  }
}

/** `get()`/`getString()`/`getInt()`/`getBoolean()` called for a key that isn't in the loaded
 *  snapshot (or whose value is `null`) and no default was supplied. */
export class MissingKeyError extends EnvpitError {
  readonly key: string;

  constructor(key: string) {
    super(
      `Config key "${key}" is not set and no default value was provided. ` +
        `Pass a default (e.g. envpit.get("${key}", "fallback")) if this key is allowed to be absent.`,
    );
    this.key = key;
  }
}

/** A typed getter (`getInt`/`getBoolean`) could not coerce the stored string value. */
export class TypeMismatchError extends EnvpitError {
  readonly key: string;
  readonly expectedType: string;

  constructor(key: string, expectedType: string, rawValue: string) {
    super(`Config key "${key}" is not a valid ${expectedType} (got "${rawValue}").`);
    this.key = key;
    this.expectedType = expectedType;
  }
}
