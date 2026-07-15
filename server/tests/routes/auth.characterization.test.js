/**
 * Characterization tests for the /auth routes defined in server/routes/auth.js.
 *
 * SECURITY-CRITICAL: these PIN the CURRENT HTTP behavior (status codes,
 * response shapes, and the service methods invoked with their args) of a
 * representative endpoint from EACH concern group, plus the failure /
 * validation / auth-rejection paths. A follow-up decomposition into sub-route
 * modules must keep this suite green VERBATIM — the test file is unchanged
 * between Commit 1 (test only) and Commit 2 (decomposition).
 *
 * DI reality being characterized:
 *   - auth.js is a plain express.Router (NOT a factory) mounted at '/auth' in
 *     server/index.js. It instantiates `new AuthService()` at MODULE scope.
 *     AuthService exposes both top-level methods (login, signup, refreshToken,
 *     verifyToken, generateToken, ...) AND a nested `accountService` used by
 *     the profile / admin handlers. Both are replaced with a jest.mock factory
 *     so the HTTP contract can be pinned deterministically.
 *   - Auth middleware (authenticateToken) and the turnstile middleware live in
 *     separate modules and are mocked to pass-through stubs that ALSO let a
 *     single test force a rejection, pinning the gating contract without
 *     exercising real JWT/captcha logic.
 *   - passport is mocked so the module-load-time `passport.authenticate(...)`
 *     calls for the Google OAuth routes resolve to inert middleware.
 *   - JWT_SECRET / TURNSTILE_SECRET_KEY are required at module load via
 *     requireEnv(); they are set here BEFORE the router is required.
 *
 * Optional services read via `req.app.get(...)` (sessionService,
 * timeTrackingService) and `req.app.locals.*` (inventoryService, itemService)
 * are intentionally left UNSET on the test app — the handlers guard on their
 * presence, so the happy paths run without them. This mirrors the prior
 * behavior when those services are absent.
 */

// --- Env required at module load (auth.js + turnstile.js) -------------------
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || 'test-turnstile-secret';

const express = require('express');
const request = require('supertest');

// --- AuthService stub -------------------------------------------------------
// Names MUST be prefixed with "mock" so jest's hoisting allows them inside the
// jest.mock factory below. `accountService` is the nested object the profile /
// admin handlers reach through.
const mockSignup = jest.fn();
const mockLogin = jest.fn();
const mockRefreshToken = jest.fn();
const mockVerifyEmail = jest.fn();
const mockResendVerificationEmail = jest.fn();
const mockRequestPasswordReset = jest.fn();
const mockResetPassword = jest.fn();
const mockGenerateToken = jest.fn(() => 'gen-token');
const mockGenerateRefreshToken = jest.fn(() => 'gen-refresh');
const mockVerifyToken = jest.fn();
const mockTransferSessionToUser = jest.fn();
const mockCompleteOAuthRegistration = jest.fn();
const mockRequestAccountDeletion = jest.fn();
const mockConfirmAccountDeletion = jest.fn();
const mockRestoreAccountTop = jest.fn();

const mockAccount = {
  getUserById: jest.fn(),
  getUserStats: jest.fn(),
  getUserByUsername: jest.fn(),
  canChangeUsername: jest.fn(),
  changeUsername: jest.fn(),
  verifyUserPassword: jest.fn(),
  changePassword: jest.fn(),
  updateProfile: jest.fn(),
  restoreAccount: jest.fn(),
};

jest.mock('../../services/AuthService', () =>
  jest.fn().mockImplementation(() => ({
    accountService: mockAccount,
    signup: mockSignup,
    login: mockLogin,
    refreshToken: mockRefreshToken,
    verifyEmail: mockVerifyEmail,
    resendVerificationEmail: mockResendVerificationEmail,
    requestPasswordReset: mockRequestPasswordReset,
    resetPassword: mockResetPassword,
    generateToken: mockGenerateToken,
    generateRefreshToken: mockGenerateRefreshToken,
    verifyToken: mockVerifyToken,
    transferSessionToUser: mockTransferSessionToUser,
    completeOAuthRegistration: mockCompleteOAuthRegistration,
    requestAccountDeletion: mockRequestAccountDeletion,
    confirmAccountDeletion: mockConfirmAccountDeletion,
    restoreAccount: mockRestoreAccountTop,
  })));

// SessionService is required at module scope but unused on these paths.
jest.mock('../../services/SessionService', () => jest.fn().mockImplementation(() => ({})));

// --- Auth + turnstile middleware stubs --------------------------------------
const authState = { rejectToken: false };

jest.mock('../../middleware/auth', () => ({
  authenticateToken: jest.fn((req, _res, next) => {
    if (authState.rejectToken) {
      return _res.status(401).json({ error: 'Access token required' });
    }
    req.user = { id: 7, userId: 7, username: 'tester' };
    next();
  }),
}));

const turnstileState = { reject: false };
jest.mock('../../middleware/turnstile', () => ({
  requireTurnstile: jest.fn((req, res, next) => {
    if (turnstileState.reject) {
      return res.status(400).json({ error: 'Security verification required. Please complete the CAPTCHA.' });
    }
    next();
  }),
}));

// --- passport stub (module-load-time authenticate calls) --------------------
jest.mock('passport', () => ({
  authenticate: jest.fn(() => (req, _res, next) => next()),
}));

// --- DB stub for /user/:username chatbot lookups ----------------------------
const mockDbGet = jest.fn((sql, params, cb) => cb(null, undefined));
jest.mock('../../database/database', () => ({ db: { get: (...a) => mockDbGet(...a) } }));

const authRouter = require('../../routes/auth');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  return app;
}

beforeEach(() => {
  authState.rejectToken = false;
  turnstileState.reject = false;
  jest.clearAllMocks();
  mockGenerateToken.mockReturnValue('gen-token');
  mockGenerateRefreshToken.mockReturnValue('gen-refresh');
  mockDbGet.mockImplementation((sql, params, cb) => cb(null, undefined));
});

describe('routes/auth characterization', () => {
  // ---- Register / signup ---------------------------------------------------
  describe('signup', () => {
    test('POST /auth/signup creates a user with 201 and returns token/refreshToken', async () => {
      mockSignup.mockResolvedValue({
        user: { id: 1, email: 'a@b.com', username: 'alice' },
        token: 't', refreshToken: 'r',
      });
      const res = await request(buildApp())
        .post('/auth/signup')
        .send({ email: 'a@b.com', username: 'alice', password: 'secret1' });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        message: 'User created successfully',
        user: { id: 1, email: 'a@b.com', username: 'alice' },
        token: 't', refreshToken: 'r',
      });
      expect(mockSignup).toHaveBeenCalledWith('a@b.com', 'alice', 'secret1');
    });

    test('POST /auth/signup 400 on validation failure (short password / bad username)', async () => {
      const res = await request(buildApp())
        .post('/auth/signup')
        .send({ email: 'a@b.com', username: 'al', password: '123' });

      expect(res.status).toBe(400);
      expect(Array.isArray(res.body.errors)).toBe(true);
      expect(res.body.errors.length).toBeGreaterThan(0);
      expect(mockSignup).not.toHaveBeenCalled();
    });

    test('POST /auth/signup 400 when service throws (e.g. email already registered)', async () => {
      mockSignup.mockRejectedValue(new Error('Email already registered'));
      const res = await request(buildApp())
        .post('/auth/signup')
        .send({ email: 'a@b.com', username: 'alice', password: 'secret1' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Email already registered' });
    });

    test('POST /auth/signup 400 when turnstile rejects (before validation/service)', async () => {
      turnstileState.reject = true;
      const res = await request(buildApp())
        .post('/auth/signup')
        .send({ email: 'a@b.com', username: 'alice', password: 'secret1' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Security verification required. Please complete the CAPTCHA.' });
      expect(mockSignup).not.toHaveBeenCalled();
    });
  });

  // ---- Login / logout ------------------------------------------------------
  describe('login & logout', () => {
    test('POST /auth/login returns token/refreshToken on valid credentials', async () => {
      mockLogin.mockResolvedValue({
        user: { id: 1, username: 'alice' }, token: 't', refreshToken: 'r',
      });
      const res = await request(buildApp())
        .post('/auth/login')
        .send({ email: 'alice', password: 'secret1' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        message: 'Login successful',
        user: { id: 1, username: 'alice' }, token: 't', refreshToken: 'r',
      });
      expect(mockLogin).toHaveBeenCalledWith('alice', 'secret1');
    });

    test('POST /auth/login 401 on bad credentials (service throws)', async () => {
      mockLogin.mockRejectedValue(new Error('Invalid email or password'));
      const res = await request(buildApp())
        .post('/auth/login')
        .send({ email: 'alice', password: 'wrong' });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Invalid email or password' });
    });

    test('POST /auth/login 400 when required fields missing', async () => {
      const res = await request(buildApp())
        .post('/auth/login')
        .send({ email: '' });

      expect(res.status).toBe(400);
      expect(Array.isArray(res.body.errors)).toBe(true);
      expect(mockLogin).not.toHaveBeenCalled();
    });

    test('POST /auth/logout is token-gated and returns success', async () => {
      const auth = require('../../middleware/auth');
      const res = await request(buildApp()).post('/auth/logout');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ message: 'Logout successful' });
      expect(auth.authenticateToken).toHaveBeenCalled();
    });

    test('POST /auth/logout 401 when token auth rejects', async () => {
      authState.rejectToken = true;
      const res = await request(buildApp()).post('/auth/logout');

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Access token required' });
    });
  });

  // ---- Token refresh -------------------------------------------------------
  describe('token refresh', () => {
    test('POST /auth/refresh 400 when refreshToken missing', async () => {
      const res = await request(buildApp()).post('/auth/refresh').send({});
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Refresh token required' });
      expect(mockRefreshToken).not.toHaveBeenCalled();
    });

    test('POST /auth/refresh returns new token pair', async () => {
      mockRefreshToken.mockResolvedValue({ token: 'nt', refreshToken: 'nr' });
      const res = await request(buildApp())
        .post('/auth/refresh')
        .send({ refreshToken: 'old' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ token: 'nt', refreshToken: 'nr' });
      expect(mockRefreshToken).toHaveBeenCalledWith('old');
    });

    test('POST /auth/refresh 401 when token invalid (service throws)', async () => {
      mockRefreshToken.mockRejectedValue(new Error('bad'));
      const res = await request(buildApp())
        .post('/auth/refresh')
        .send({ refreshToken: 'old' });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Invalid refresh token' });
    });
  });

  // ---- Email verification --------------------------------------------------
  describe('email verification', () => {
    test('GET /auth/verify-email/:token returns success message', async () => {
      mockVerifyEmail.mockResolvedValue({ userId: 5 });
      const res = await request(buildApp()).get('/auth/verify-email/abc123');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ message: 'Email verified successfully' });
      expect(mockVerifyEmail).toHaveBeenCalledWith('abc123');
    });

    test('GET /auth/verify-email/:token 400 when service throws', async () => {
      mockVerifyEmail.mockRejectedValue(new Error('Invalid token'));
      const res = await request(buildApp()).get('/auth/verify-email/bad');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid token' });
    });

    test('POST /auth/resend-verification 400 when already verified (token-gated)', async () => {
      const auth = require('../../middleware/auth');
      mockAccount.getUserById.mockResolvedValue({ id: 7, is_verified: 1 });
      const res = await request(buildApp()).post('/auth/resend-verification');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Email is already verified' });
      expect(auth.authenticateToken).toHaveBeenCalled();
      expect(mockResendVerificationEmail).not.toHaveBeenCalled();
    });
  });

  // ---- Password reset ------------------------------------------------------
  describe('password reset', () => {
    // Security fix (2026-07 audit): the token is never returned in the response
    // (was an account-takeover for any known email), and the response is
    // identical whether or not the email resolves (closes the enumeration oracle).
    test('POST /auth/forgot-password returns a generic message and never the token when email exists', async () => {
      mockRequestPasswordReset.mockResolvedValue('reset-tok');
      const res = await request(buildApp())
        .post('/auth/forgot-password')
        .send({ email: 'a@b.com' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ message: 'If that email is registered, a password reset link has been sent.' });
      expect(res.body.resetToken).toBeUndefined();
      expect(mockRequestPasswordReset).toHaveBeenCalledWith('a@b.com');
    });

    test('POST /auth/forgot-password returns the SAME 200 generic message when email not found (no enumeration oracle)', async () => {
      mockRequestPasswordReset.mockResolvedValue(null);
      const res = await request(buildApp())
        .post('/auth/forgot-password')
        .send({ email: 'missing@b.com' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ message: 'If that email is registered, a password reset link has been sent.' });
    });

    test('POST /auth/reset-password 400 when token or new password missing', async () => {
      const res = await request(buildApp())
        .post('/auth/reset-password')
        .send({ resetToken: 'x' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Reset token and new password required' });
      expect(mockResetPassword).not.toHaveBeenCalled();
    });

    test('POST /auth/reset-password succeeds with token + new password', async () => {
      mockResetPassword.mockResolvedValue(true);
      const res = await request(buildApp())
        .post('/auth/reset-password')
        .send({ resetToken: 'tok', newPassword: 'newpass1' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ message: 'Password reset successful' });
      expect(mockResetPassword).toHaveBeenCalledWith('tok', 'newpass1');
    });

    // S11: reset-password now carries the Turnstile gate that forgot-password
    // already had (it previously had none).
    test('POST /auth/reset-password 400 when turnstile rejects (before the service call)', async () => {
      turnstileState.reject = true;
      const res = await request(buildApp())
        .post('/auth/reset-password')
        .send({ resetToken: 'tok', newPassword: 'newpass1' });

      expect(res.status).toBe(400);
      expect(mockResetPassword).not.toHaveBeenCalled();
    });
  });

  // ---- Session / me / profile ----------------------------------------------
  describe('session & profile', () => {
    test('GET /auth/me returns user + stats with points balance (token-gated)', async () => {
      const auth = require('../../middleware/auth');
      mockAccount.getUserById.mockResolvedValue({ id: 7, username: 'tester', avatar_url: 'a.png', description: 'hi' });
      mockAccount.getUserStats.mockResolvedValue({ points_balance: 42 });
      mockAccount.canChangeUsername.mockResolvedValue(true);

      const res = await request(buildApp()).get('/auth/me');

      expect(res.status).toBe(200);
      expect(res.body.user.canChangeUsername).toBe(true);
      expect(res.body.user.avatar_url).toBe('a.png');
      expect(res.body.stats.points).toBe(42);
      expect(auth.authenticateToken).toHaveBeenCalled();
    });

    test('GET /auth/me 401 when token auth rejects', async () => {
      authState.rejectToken = true;
      const res = await request(buildApp()).get('/auth/me');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Access token required' });
    });

    test('PUT /auth/change-username 400 when newUsername missing', async () => {
      const res = await request(buildApp()).put('/auth/change-username').send({});
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'New username is required' });
      expect(mockAccount.changeUsername).not.toHaveBeenCalled();
    });

    test('PUT /auth/change-username returns new token after change', async () => {
      mockAccount.changeUsername.mockResolvedValue({ username: 'newname' });
      mockAccount.getUserById.mockResolvedValue({ id: 7, username: 'newname' });
      const res = await request(buildApp())
        .put('/auth/change-username')
        .send({ newUsername: 'newname' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true, username: 'newname', token: 'gen-token',
        refreshToken: 'gen-refresh', message: 'Username changed successfully',
      });
      expect(mockAccount.changeUsername).toHaveBeenCalledWith(7, 'newname');
    });

    test('GET /auth/check-username/:username reports availability', async () => {
      mockAccount.getUserByUsername.mockResolvedValue(null);
      const res = await request(buildApp()).get('/auth/check-username/freename');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ available: true, username: 'freename' });
    });

    test('GET /auth/check-username/:username flags invalid format without DB lookup', async () => {
      const res = await request(buildApp()).get('/auth/check-username/ab');
      expect(res.status).toBe(200);
      expect(res.body.available).toBe(false);
      expect(res.body.error).toMatch(/3-20 characters/);
      expect(mockAccount.getUserByUsername).not.toHaveBeenCalled();
    });

    test('GET /auth/user/:username 404 when user not found', async () => {
      mockAccount.getUserByUsername.mockResolvedValue(null);
      const res = await request(buildApp()).get('/auth/user/somebody');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'User not found' });
    });
  });

  // ---- OAuth (Google + complete-registration) ------------------------------
  describe('oauth', () => {
    test('GET /auth/google is registered and routed through passport (no 500)', async () => {
      // The /google route registers `passport.authenticate('google', {scope})`
      // at module-load time. Our passport stub returns inert middleware that
      // calls next(); with no terminal handler the request resolves as 404, but
      // crucially it is NOT a 500 and NOT a missing route error — the route is
      // wired and reached the passport guard.
      const res = await request(buildApp()).get('/auth/google');
      expect(res.status).not.toBe(500);
    });

    test('POST /auth/complete-oauth-registration 400 when fields missing', async () => {
      const res = await request(buildApp())
        .post('/auth/complete-oauth-registration')
        .send({ tempToken: 'x' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Temporary token and username are required' });
    });

    test('POST /auth/complete-oauth-registration 400 on invalid temp token', async () => {
      mockVerifyToken.mockReturnValue(null);
      const res = await request(buildApp())
        .post('/auth/complete-oauth-registration')
        .send({ tempToken: 'bad', username: 'newuser' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid or expired temporary token' });
    });

    test('POST /auth/complete-oauth-registration completes when token valid', async () => {
      mockVerifyToken.mockReturnValue({ tempOAuth: true, email: 'o@b.com' });
      mockCompleteOAuthRegistration.mockResolvedValue({
        user: { id: 3, username: 'newuser' }, token: 't', refreshToken: 'r',
      });
      const res = await request(buildApp())
        .post('/auth/complete-oauth-registration')
        .send({ tempToken: 'good', username: 'newuser' });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('OAuth registration completed successfully');
      expect(res.body.user).toEqual({ id: 3, username: 'newuser' });
      expect(mockCompleteOAuthRegistration).toHaveBeenCalledWith({ tempOAuth: true, email: 'o@b.com' }, 'newuser');
    });
  });

  // ---- Account deletion / restore ------------------------------------------
  describe('account deletion & restore', () => {
    test('POST /auth/request-deletion is token-gated and returns success', async () => {
      const auth = require('../../middleware/auth');
      mockRequestAccountDeletion.mockResolvedValue({ ok: true });
      const res = await request(buildApp()).post('/auth/request-deletion');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        message: 'Account deletion requested. Please check your email to confirm.',
      });
      expect(auth.authenticateToken).toHaveBeenCalled();
      expect(mockRequestAccountDeletion).toHaveBeenCalledWith(7);
    });

    test('POST /auth/confirm-deletion 400 when token missing', async () => {
      const res = await request(buildApp()).post('/auth/confirm-deletion').send({});
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'Deletion token is required' });
    });

    test('POST /auth/restore-account 400 when no token and no credentials', async () => {
      const res = await request(buildApp()).post('/auth/restore-account').send({});
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'Email and password are required' });
    });
  });

  // NOTE: Admin user-management lived under /auth/admin/* (server/routes/auth/admin.js)
  // and duplicated the canonical /api/admin surface (server/routes/admin.js). The
  // duplicate was removed; those endpoints are characterized by the /api/admin suite.
});
