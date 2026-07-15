/**
 * S11 — server-enforced password policy (AccountService.validatePasswordPolicy).
 * The client-side length check was the only gate, so a direct reset-password
 * API call could set a trivial password.
 */

const AccountService = require('../../services/AccountService');

describe('AccountService.validatePasswordPolicy (S11)', () => {
  test('accepts an 8+ character password', () => {
    expect(() => AccountService.validatePasswordPolicy('abcd1234')).not.toThrow();
  });

  test('rejects a password shorter than 8 characters', () => {
    expect(() => AccountService.validatePasswordPolicy('short')).toThrow(/at least 8/);
  });

  test('rejects non-string / missing password', () => {
    expect(() => AccountService.validatePasswordPolicy(undefined)).toThrow(/at least 8/);
    expect(() => AccountService.validatePasswordPolicy(12345678)).toThrow(/at least 8/);
  });

  test('rejects an absurdly long password (bcrypt/DoS guard)', () => {
    expect(() => AccountService.validatePasswordPolicy('x'.repeat(201))).toThrow(/too long/);
  });
});
