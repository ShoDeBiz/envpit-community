import { describe, expect, it } from 'vitest';
import { AuthenticationError, EnvpitError, MissingKeyError, NetworkError, TypeMismatchError } from '../src/errors.js';

describe('error hierarchy', () => {
  it('every typed error is a real Error and an EnvpitError, distinguishable via instanceof', () => {
    const errors = [
      new AuthenticationError('bad key'),
      new NetworkError('unreachable'),
      new MissingKeyError('FOO'),
      new TypeMismatchError('PORT', 'integer', 'nope'),
    ];

    for (const err of errors) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(EnvpitError);
    }

    expect(errors[0]).toBeInstanceOf(AuthenticationError);
    expect(errors[0]).not.toBeInstanceOf(NetworkError);
    expect(errors[1]).toBeInstanceOf(NetworkError);
    expect(errors[1]).not.toBeInstanceOf(AuthenticationError);
  });

  it('MissingKeyError carries the offending key and a fix-it message', () => {
    const err = new MissingKeyError('DATABASE_URL');
    expect(err.key).toBe('DATABASE_URL');
    expect(err.message).toMatch(/DATABASE_URL/);
    expect(err.message).toMatch(/default/i);
  });

  it('TypeMismatchError carries the key, expected type, and never crashes on the raw value', () => {
    const err = new TypeMismatchError('PORT', 'integer', 'abc');
    expect(err.key).toBe('PORT');
    expect(err.expectedType).toBe('integer');
    expect(err.message).toMatch(/PORT/);
    expect(err.message).toMatch(/integer/);
  });
});

// bd:envpit-ed3h Part 3 — stable `.code` field + docs-anchor, per
// outputs/SPEC-envpit-0t2z-1b-ux.md §A3 ("Stable machine code per error ... supports ... lets
// support/AI-assistants pattern-match" / "Every SDK error links here": each code has a stable
// docs anchor). Deliberately asserts against `.message` NOT changing — the shared
// test-vectors/error-messages.json family (consumed by
// test/vectors/error-messages.vectors.test.ts, and forward-provisioned for Python/Go/Java) pins
// today's exact message text; `.code`/`.docsAnchor` are ADDITIVE fields, not a rewrite of the
// message, so no shared cross-language vector needs to change for this SDK's fast-follow.
describe('error taxonomy — stable .code + .docsAnchor (bd:envpit-ed3h Part 3)', () => {
  it('every error class exposes a unique, stable .code and a .docsAnchor starting with "#"', () => {
    const cases: Array<{ err: EnvpitError; code: string; docsAnchor: string }> = [
      { err: new AuthenticationError('bad key'), code: 'ENVPIT_INVALID_API_KEY', docsAnchor: '#invalid-api-key' },
      { err: new NetworkError('unreachable'), code: 'ENVPIT_NETWORK', docsAnchor: '#network' },
      { err: new MissingKeyError('FOO'), code: 'ENVPIT_MISSING_KEY', docsAnchor: '#missing-key' },
      { err: new TypeMismatchError('PORT', 'integer', 'nope'), code: 'ENVPIT_TYPE_MISMATCH', docsAnchor: '#type-mismatch' },
    ];

    const seenCodes = new Set<string>();
    for (const { err, code, docsAnchor } of cases) {
      expect(err.code).toBe(code);
      expect(err.docsAnchor).toBe(docsAnchor);
      expect(err.docsAnchor.startsWith('#')).toBe(true);
      seenCodes.add(err.code);
    }
    expect(seenCodes.size).toBe(cases.length); // every code is unique across the taxonomy
  });

  it('.code/.docsAnchor do NOT change the shipped .message text (additive fields only)', () => {
    // Mirrors test-vectors/error-messages.json's "missing-key" case literal expectation —
    // proves the addition of .code/.docsAnchor didn't leak into .message.
    const err = new MissingKeyError('DATABSE_URL');
    expect(err.message).toBe(
      'Config key "DATABSE_URL" is not set and no default value was provided. ' +
        'Pass a default (e.g. envpit.get("DATABSE_URL", "fallback")) if this key is allowed to be absent.',
    );
  });
});
