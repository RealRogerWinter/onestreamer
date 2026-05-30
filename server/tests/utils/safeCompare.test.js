const { safeCompare } = require('../../utils/safeCompare');

describe('safeCompare (constant-time secret comparison)', () => {
  test('true for identical non-empty strings', () => {
    expect(safeCompare('s3cret-admin-key', 's3cret-admin-key')).toBe(true);
  });

  test('false for same-length but differing strings', () => {
    expect(safeCompare('s3cret-admin-key', 's3cret-admin-keY')).toBe(false);
  });

  test('false for different-length strings', () => {
    expect(safeCompare('short', 'a-much-longer-secret')).toBe(false);
  });

  test('fails closed on empty, null, undefined, or non-string input', () => {
    expect(safeCompare('', '')).toBe(false);
    expect(safeCompare('key', '')).toBe(false);
    expect(safeCompare('', 'key')).toBe(false);
    expect(safeCompare(undefined, 'key')).toBe(false);
    expect(safeCompare('key', undefined)).toBe(false);
    expect(safeCompare(null, 'key')).toBe(false);
    expect(safeCompare(123, 'key')).toBe(false);
  });
});
