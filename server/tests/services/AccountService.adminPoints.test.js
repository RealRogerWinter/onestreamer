// Tests for AccountService.adminGrantPoints + adminRevokePoints — the
// audited admin-grant/admin-revoke methods extracted from the inline
// /api/internal/admin/{award-points,take-points} handlers in PR 16.4.
//
// The methods funnel through `addPoints` / `subtractPoints` so the audit
// row carries `type='admin_award'` / `type='admin_deduction'` with the
// admin actor in metadata. The 403 is_admin guard, 404 target-not-found,
// and 400 insufficient-balance branches throw `AccountServiceError`.
//
// What's NOT covered here: the Bearer-token + decoded.id === adminUserId
// auth check, which stays in the route handler. See PR 16.4's CHANGELOG
// note for the locked-decision rationale.

jest.mock('../../bootstrap/logger', () => {
  const m = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(), trace: jest.fn() };
  m.child = jest.fn(() => m);
  return m;
});

jest.mock('../../database/database', () => ({
  db: null,
  runAsync: jest.fn(),
  getAsync: jest.fn(),
  allAsync: jest.fn(),
}));

const AccountService = require('../../services/AccountService');
const { AccountServiceError } = AccountService;

function buildService({ admin, target, balance = 1000 } = {}) {
  // Real `AccountService` derives admin/target from `getUserById` and
  // `getUserByUsername` — override on the instance to dodge the repo
  // wiring without mocking the whole repo class.
  const svc = new AccountService();
  svc.getUserById = jest.fn().mockResolvedValue(admin);
  svc.getUserByUsername = jest.fn().mockResolvedValue(target);
  svc.addPoints = jest.fn().mockImplementation((userId, amount) => Promise.resolve(balance + amount));
  svc.subtractPoints = jest.fn().mockImplementation((userId, amount) => Promise.resolve(balance - amount));
  svc.getPointsBalance = jest.fn().mockResolvedValue(balance);
  return svc;
}

describe('AccountService.adminGrantPoints', () => {
  it('happy path: 200 shape, addPoints called with admin_award type + adminId metadata', async () => {
    const svc = buildService({
      admin: { id: 1, username: 'theadmin', is_admin: 1 },
      target: { id: 42, username: 'sender' },
      balance: 1000,
    });

    const result = await svc.adminGrantPoints(1, 'sender', 500);

    expect(result).toEqual({
      newBalance: 1500,
      targetUserId: 42,
      targetUsername: 'sender',
    });
    expect(svc.addPoints).toHaveBeenCalledWith(
      42, 500, 'admin_award', 'Admin award by theadmin', { adminId: 1 }
    );
  });

  it('throws 403 when admin row missing', async () => {
    const svc = buildService({ admin: null, target: { id: 42, username: 'sender' } });

    await expect(svc.adminGrantPoints(1, 'sender', 500)).rejects.toMatchObject({
      statusCode: 403,
      clientMessage: 'Admin access required',
    });
    expect(svc.addPoints).not.toHaveBeenCalled();
  });

  it('throws 403 when admin row has is_admin = 0', async () => {
    const svc = buildService({
      admin: { id: 42, username: 'sender', is_admin: 0 },
      target: { id: 99, username: 'recipient' },
    });

    await expect(svc.adminGrantPoints(42, 'recipient', 500)).rejects.toMatchObject({
      statusCode: 403,
      clientMessage: 'Admin access required',
    });
    expect(svc.addPoints).not.toHaveBeenCalled();
  });

  it('throws 404 when targetUsername does not resolve', async () => {
    const svc = buildService({
      admin: { id: 1, username: 'theadmin', is_admin: 1 },
      target: null,
    });

    await expect(svc.adminGrantPoints(1, 'nobody', 500)).rejects.toMatchObject({
      statusCode: 404,
      clientMessage: "User 'nobody' not found",
    });
    expect(svc.addPoints).not.toHaveBeenCalled();
  });

  it('admin row lookup happens BEFORE target lookup (is_admin gate is first)', async () => {
    const svc = buildService({
      admin: { id: 1, username: 'theadmin', is_admin: 0 },
      target: null,
    });

    await expect(svc.adminGrantPoints(1, 'nobody', 500)).rejects.toMatchObject({
      statusCode: 403,
      clientMessage: 'Admin access required',
    });
    expect(svc.getUserById).toHaveBeenCalled();
    expect(svc.getUserByUsername).not.toHaveBeenCalled();
  });
});

describe('AccountService.adminRevokePoints', () => {
  it('happy path: 200 shape, subtractPoints called with admin_deduction type + adminId metadata', async () => {
    const svc = buildService({
      admin: { id: 1, username: 'theadmin', is_admin: 1 },
      target: { id: 42, username: 'sender' },
      balance: 1000,
    });

    const result = await svc.adminRevokePoints(1, 'sender', 300);

    expect(result).toEqual({
      newBalance: 700,
      targetUserId: 42,
      targetUsername: 'sender',
    });
    expect(svc.subtractPoints).toHaveBeenCalledWith(
      42, 300, 'admin_deduction', 'Admin deduction by theadmin', { adminId: 1 }
    );
  });

  it('throws 403 when admin row missing', async () => {
    const svc = buildService({ admin: null, target: { id: 42, username: 'sender' } });

    await expect(svc.adminRevokePoints(1, 'sender', 300)).rejects.toMatchObject({
      statusCode: 403,
      clientMessage: 'Admin access required',
    });
    expect(svc.subtractPoints).not.toHaveBeenCalled();
  });

  it('throws 403 when admin row has is_admin = 0', async () => {
    const svc = buildService({
      admin: { id: 42, username: 'sender', is_admin: 0 },
      target: { id: 99, username: 'recipient' },
      balance: 1000,
    });

    await expect(svc.adminRevokePoints(42, 'recipient', 300)).rejects.toMatchObject({
      statusCode: 403,
      clientMessage: 'Admin access required',
    });
    expect(svc.subtractPoints).not.toHaveBeenCalled();
  });

  it('throws 404 when targetUsername does not resolve', async () => {
    const svc = buildService({
      admin: { id: 1, username: 'theadmin', is_admin: 1 },
      target: null,
    });

    await expect(svc.adminRevokePoints(1, 'nobody', 300)).rejects.toMatchObject({
      statusCode: 404,
      clientMessage: "User 'nobody' not found",
    });
    expect(svc.subtractPoints).not.toHaveBeenCalled();
  });

  it('throws 400 with balance + amount in the message when target lacks balance', async () => {
    const svc = buildService({
      admin: { id: 1, username: 'theadmin', is_admin: 1 },
      target: { id: 42, username: 'sender' },
      balance: 50, // < 300 attempted deduction
    });

    await expect(svc.adminRevokePoints(1, 'sender', 300)).rejects.toMatchObject({
      statusCode: 400,
      clientMessage: 'User only has 50 points (cannot deduct 300)',
    });
    expect(svc.subtractPoints).not.toHaveBeenCalled();
  });

  it('allows deduction when balance equals amount (boundary)', async () => {
    const svc = buildService({
      admin: { id: 1, username: 'theadmin', is_admin: 1 },
      target: { id: 42, username: 'sender' },
      balance: 300,
    });

    await svc.adminRevokePoints(1, 'sender', 300);

    expect(svc.subtractPoints).toHaveBeenCalledTimes(1);
  });
});

describe('AccountServiceError', () => {
  it('is an Error subclass with statusCode / clientMessage', () => {
    const err = new AccountServiceError(403, 'Admin access required');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AccountServiceError');
    expect(err.statusCode).toBe(403);
    expect(err.clientMessage).toBe('Admin access required');
    expect(err.message).toBe('Admin access required');
  });
});
