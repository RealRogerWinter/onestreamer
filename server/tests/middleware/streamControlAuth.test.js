const { makeStreamControlAuth } = require('../../middleware/streamControlAuth');

const mkReq = (headers = {}) => ({ headers, method: 'POST', originalUrl: '/api/random-stream/rotate' });

describe('streamControlAuth', () => {
  const OLD_ENV = process.env;
  let next;
  let authenticateAdmin;
  let logger;
  let mw;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.INTERNAL_API_SECRET;
    delete process.env.ENFORCE_STREAM_CONTROL_AUTH;
    next = jest.fn();
    authenticateAdmin = jest.fn();
    logger = { warn: jest.fn() };
    mw = makeStreamControlAuth(authenticateAdmin, logger);
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  test('valid internal secret → next(), admin auth not consulted (even when enforcing)', () => {
    process.env.INTERNAL_API_SECRET = 's3cret';
    process.env.ENFORCE_STREAM_CONTROL_AUTH = 'true';
    mw(mkReq({ 'x-internal-secret': 's3cret' }), {}, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(authenticateAdmin).not.toHaveBeenCalled();
  });

  test('enforcement OFF + no creds → allowed but warns (permissive rollout)', () => {
    mw(mkReq({}), {}, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(authenticateAdmin).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test('enforcement ON + no creds → delegated to authenticateAdmin (it owns the rejection)', () => {
    process.env.ENFORCE_STREAM_CONTROL_AUTH = 'true';
    mw(mkReq({}), {}, next);
    expect(authenticateAdmin).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });

  test('enforcement ON + wrong secret → delegated to authenticateAdmin', () => {
    process.env.INTERNAL_API_SECRET = 's3cret';
    process.env.ENFORCE_STREAM_CONTROL_AUTH = 'true';
    mw(mkReq({ 'x-internal-secret': 'nope' }), {}, next);
    expect(authenticateAdmin).toHaveBeenCalledTimes(1);
  });

  test('enforcement ON + admin JWT (no secret) → authenticateAdmin consulted', () => {
    process.env.ENFORCE_STREAM_CONTROL_AUTH = 'true';
    mw(mkReq({ authorization: 'Bearer token' }), {}, next);
    expect(authenticateAdmin).toHaveBeenCalledTimes(1);
  });

  test('GET reads bypass the gate (public) even when enforcing with no creds', () => {
    process.env.INTERNAL_API_SECRET = 's3cret';
    process.env.ENFORCE_STREAM_CONTROL_AUTH = 'true';
    const getReq = { headers: {}, method: 'GET', originalUrl: '/api/random-stream/status' };
    mw(getReq, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(authenticateAdmin).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
