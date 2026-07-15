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
