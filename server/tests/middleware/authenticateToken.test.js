/**
 * S8 + S9 — authenticateToken account-status enforcement.
 *
 * S8: getSafeById used to omit account_status, so the deleted/pending checks
 *     were dead code and a purged user passed auth for their JWT's life.
 * S9: a DB error in the status/ban check was swallowed and the request
 *     proceeded (fail-open); it must now fail closed (500), like the admin
 *     and moderator variants already do.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockVerifyToken = jest.fn();
jest.mock('../../services/AuthService', () => jest.fn().mockImplementation(() => ({
  verifyToken: (...a) => mockVerifyToken(...a),
})));

const mockGetUserById = jest.fn();
jest.mock('../../services/AccountService', () => jest.fn().mockImplementation(() => ({
  getUserById: (...a) => mockGetUserById(...a),
})));

const { authenticateToken } = require('../../middleware/auth');

function runMiddleware() {
  const req = { headers: { authorization: 'Bearer tok' } };
  let statusCode = 200;
  let body;
  const res = {
    status(c) { statusCode = c; return this; },
    json(b) { body = b; return this; },
    setHeader() {},
  };
  const next = jest.fn();
  return authenticateToken(req, res, next).then(() => ({ req, statusCode, body, next }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockVerifyToken.mockReturnValue({ userId: 7, id: 7 });
});

describe('authenticateToken account-status enforcement (S8/S9)', () => {
  test('deleted account is rejected (403) — S8 dead-code fix', async () => {
    mockGetUserById.mockResolvedValue({ id: 7, account_status: 'deleted', is_banned: 0 });

    const { statusCode, body, next } = await runMiddleware();

    expect(statusCode).toBe(403);
    expect(body).toEqual({ error: 'Account has been deleted' });
    expect(next).not.toHaveBeenCalled();
  });

  test('banned account is rejected (403)', async () => {
    mockGetUserById.mockResolvedValue({ id: 7, account_status: 'active', is_banned: 1 });

    const { statusCode, next } = await runMiddleware();

    expect(statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('active account passes through', async () => {
    mockGetUserById.mockResolvedValue({ id: 7, account_status: 'active', is_banned: 0 });

    const { statusCode, next } = await runMiddleware();

    expect(statusCode).toBe(200);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('pending_deletion passes but is flagged, not rejected', async () => {
    mockGetUserById.mockResolvedValue({ id: 7, account_status: 'pending_deletion', is_banned: 0 });

    const { next } = await runMiddleware();

    expect(next).toHaveBeenCalledTimes(1);
  });

  test('a DB error fails CLOSED (500) instead of proceeding — S9', async () => {
    mockGetUserById.mockRejectedValue(new Error('db down'));

    const { statusCode, next } = await runMiddleware();

    expect(statusCode).toBe(500);
    expect(next).not.toHaveBeenCalled();
  });
});
