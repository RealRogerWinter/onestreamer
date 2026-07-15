// server/routes/internal/points.js
//
// Sub-route module of the /api/internal/* router. Holds the point-economy and
// game-mechanic endpoints: award/transfer points, gamble, slots, chat-bonus,
// bonus-status, and the admin grant/revoke pair. Handler bodies are VERBATIM
// from the former monolithic server/routes/internal.js; the parent mounts this
// at the SAME base path so every path/method/auth order is byte-for-byte
// identical.

const express = require('express');

const AccountService = require('../../services/AccountService');
const { GameMechanicsError } = require('../../services/GameMechanicsService');
const { AccountServiceError } = require('../../services/AccountService');
const { safeCompare } = require('../../utils/safeCompare');

// E1b (audit Plan 04, critical — the audit's P0 item 6): `/award-points`
// credits arbitrary points and was gated ONLY by "the caller's own JWT
// matches the credited user" — so any authenticated user could self-credit
// unlimited points by calling it directly. It is meant for INTERNAL callers
// only (the chat-service claim-event handler), which sends X-Internal-Secret
// via getAxiosConfig. Enforce that secret when configured — a direct client
// call has no secret and is rejected. When INTERNAL_API_SECRET is unset
// (dev / pre-rollout) we can't distinguish callers, so we warn loudly and
// fall back to the JWT check; the amount cap + integer validation below
// bound the damage until the operator sets the secret (same rollout
// dependency as S3/CH3). Max single award — claim rewards are small.
const MAX_AWARD_POINTS = 1_000_000;

function isTrustedInternalCall(req, logger) {
  const expected = process.env.INTERNAL_API_SECRET;
  if (expected) {
    return safeCompare(req.headers['x-internal-secret'], expected);
  }
  // Unset: cannot authenticate the internal caller. Warn so the gap is
  // visible; the endpoint stays JWT-gated + amount-capped meanwhile.
  logger.warn('⚠️ AWARD-POINTS: INTERNAL_API_SECRET unset - endpoint is not fully protected (self-credit bounded only by the amount cap). Set INTERNAL_API_SECRET on both processes to close E1b.');
  return null; // "unknown" — fall through to the JWT check
}

// PR 16.2: small helper used by the five game-mechanic handlers. Catches the
// service's typed errors and maps to the byte-equivalent res.json shape;
// anything else (an unexpected throw) is rethrown so the per-route catch can
// still emit its own 500 log line and 500 body. Avoids three copies of the
// same map-and-respond block.
//
// Spread order: `extra` is spread FIRST, then `success` / `error` are written
// — so a future caller that accidentally puts an `error` key in `extra`
// cannot shadow the clientMessage. Today `extra` is only ever the 429
// cooldown's `{ remainingSeconds, nextAvailable }`, but the ordering hardens
// the contract for free.
function respondGameMechanicsError(err, res) {
  if (err instanceof GameMechanicsError) {
    res.status(err.statusCode).json({
      ...err.extra,
      success: false,
      error: err.clientMessage,
    });
    return true;
  }
  return false;
}

/**
 * @param {{ logger: import('pino').Logger, authService: object }} deps
 */
module.exports = function createPointsRouter({ logger, authService }) {
  const router = express.Router();

  // API endpoint for awarding points (claim events, etc)
  router.post('/award-points', express.json(), async (req, res) => {
    try {
      const { userId, amount, reason } = req.body;

      if (!userId || !amount) {
        return res.status(400).json({
          success: false,
          error: 'Missing required parameters'
        });
      }

      // E1b/E6: server-side positive-integer + cap validation. Fractional
      // amounts used to reach the ledger; an uncapped amount was the core of
      // the self-credit exploit.
      if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_AWARD_POINTS) {
        return res.status(400).json({
          success: false,
          error: `amount must be a positive integer no greater than ${MAX_AWARD_POINTS}`
        });
      }

      // E1b: authorize as an internal call (chat-service sends the secret).
      const trusted = isTrustedInternalCall(req, logger);
      if (trusted === false) {
        // INTERNAL_API_SECRET is set but the header is missing/wrong — a
        // direct client call. Reject; this is what closes the exploit.
        return res.status(403).json({ success: false, error: 'Forbidden' });
      }

      // Verify authorization (defense-in-depth: the credited user's own JWT;
      // in permissive mode this is the only identity gate).
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
          success: false,
          error: 'Unauthorized'
        });
      }

      const token = authHeader.substring(7);
      const decoded = authService.verifyToken(token);

      if (!decoded || decoded.id !== userId) {
        return res.status(401).json({
          success: false,
          error: 'Invalid credentials'
        });
      }

      const accountService = new AccountService();

      // Award points
      await accountService.addPoints(userId, amount, 'award', reason || 'Claim event reward');
      const newBalance = await accountService.getPointsBalance(userId);

      res.json({
        success: true,
        newBalance: newBalance,
        awarded: amount
      });
    } catch (error) {
      logger.error('❌ MAIN SERVER: Failed to award points:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to award points'
      });
    }
  });

  // API endpoint for gambling
  router.post('/gamble', express.json(), async (req, res) => {
    try {
      const { userId, amount } = req.body;

      if (!userId || !amount) {
        return res.status(400).json({
          success: false,
          error: 'Missing required parameters'
        });
      }

      // E6: server-side positive-integer validation. A fractional or negative
      // bet used to reach the ledger unchecked.
      if (!Number.isInteger(amount) || amount <= 0) {
        return res.status(400).json({
          success: false,
          error: 'amount must be a positive integer'
        });
      }

      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }
      const token = authHeader.substring(7);
      const decoded = authService.verifyToken(token);
      if (!decoded || decoded.id !== userId) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
      }

      const svc = req.app.locals.services && req.app.locals.services.gameMechanicsService;
      if (!svc) {
        logger.error('❌ GAMBLE: gameMechanicsService not available on app.locals.services');
        return res.status(500).json({ success: false, error: 'Failed to process gamble' });
      }

      const result = await svc.gamble(userId, amount);
      res.json({ success: true, ...result });
    } catch (error) {
      if (respondGameMechanicsError(error, res)) return;
      // E7: the ledger's atomic guard can lose a race the pre-check passed
      // (balance drained between check and debit) — that's a client-visible
      // insufficient-balance condition, not a server fault.
      if (error instanceof AccountServiceError) {
        return res.status(error.statusCode).json({
          success: false,
          error: error.clientMessage,
        });
      }
      logger.error('❌ GAMBLE: Error processing gamble:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to process gamble'
      });
    }
  });

  // API endpoint for slots
  router.post('/slots', express.json(), async (req, res) => {
    try {
      const { userId, amount } = req.body;

      if (!userId || !amount) {
        return res.status(400).json({
          success: false,
          error: 'Missing required parameters'
        });
      }

      // E6: server-side positive-integer validation (same guard as /gamble).
      if (!Number.isInteger(amount) || amount <= 0) {
        return res.status(400).json({
          success: false,
          error: 'amount must be a positive integer'
        });
      }

      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }
      const token = authHeader.substring(7);
      const decoded = authService.verifyToken(token);
      if (!decoded || decoded.id !== userId) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
      }

      const svc = req.app.locals.services && req.app.locals.services.gameMechanicsService;
      if (!svc) {
        logger.error('❌ SLOTS: gameMechanicsService not available on app.locals.services');
        return res.status(500).json({ success: false, error: 'Failed to process slots' });
      }

      const result = await svc.slots(userId, amount);
      res.json({ success: true, ...result });
    } catch (error) {
      if (respondGameMechanicsError(error, res)) return;
      // E7: see /gamble — decrement race surfaces as a 400, not a 500.
      if (error instanceof AccountServiceError) {
        return res.status(error.statusCode).json({
          success: false,
          error: error.clientMessage,
        });
      }
      logger.error('❌ SLOTS: Error processing slots:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to process slots'
      });
    }
  });

  // Endpoint for authenticated users to claim chat bonus
  router.post('/claim-chat-bonus', express.json(), async (req, res) => {
    try {
      const { userId } = req.body;

      if (!userId) {
        return res.status(400).json({
          success: false,
          error: 'User ID is required'
        });
      }

      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }
      const token = authHeader.substring(7);
      const decoded = authService.verifyToken(token);
      if (!decoded || decoded.id !== userId) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
      }

      const svc = req.app.locals.services && req.app.locals.services.gameMechanicsService;
      if (!svc) {
        logger.error('❌ BONUS: gameMechanicsService not available on app.locals.services');
        return res.status(500).json({ success: false, error: 'Failed to claim bonus' });
      }

      const result = await svc.claimChatBonus(userId);
      res.json({ success: true, ...result });
    } catch (error) {
      if (respondGameMechanicsError(error, res)) return;
      logger.error('❌ BONUS: Error claiming chat bonus:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to claim bonus'
      });
    }
  });

  // Endpoint to check bonus availability for a user
  router.get('/bonus-status/:userId', async (req, res) => {
    try {
      const userIdInt = parseInt(req.params.userId);

      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }
      const token = authHeader.substring(7);
      const decoded = authService.verifyToken(token);
      if (!decoded || decoded.id !== userIdInt) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
      }

      const svc = req.app.locals.services && req.app.locals.services.gameMechanicsService;
      if (!svc) {
        logger.error('❌ BONUS: gameMechanicsService not available on app.locals.services');
        return res.status(500).json({ success: false, error: 'Failed to check bonus status' });
      }

      const result = svc.getBonusStatus(userIdInt);
      res.json({ success: true, ...result });
    } catch (error) {
      logger.error('❌ BONUS: Error checking bonus status:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to check bonus status'
      });
    }
  });

  // Endpoint for users to transfer points to another user
  router.post('/transfer-points', express.json(), async (req, res) => {
    try {
      const { fromUserId, toUsername, amount, senderUsername } = req.body;

      if (!fromUserId || !toUsername || !amount) {
        return res.status(400).json({
          success: false,
          error: 'Missing required parameters'
        });
      }

      // E6: server-side positive-integer validation. A fractional or negative
      // transfer amount would invert/corrupt both sides of the ledger pair.
      if (!Number.isInteger(amount) || amount <= 0) {
        return res.status(400).json({
          success: false,
          error: 'amount must be a positive integer'
        });
      }

      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }
      const token = authHeader.substring(7);
      const decoded = authService.verifyToken(token);
      if (!decoded || decoded.id !== fromUserId) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
      }

      const svc = req.app.locals.services && req.app.locals.services.gameMechanicsService;
      if (!svc) {
        logger.error('❌ TRANSFER: gameMechanicsService not available on app.locals.services');
        return res.status(500).json({ success: false, error: 'Failed to transfer points' });
      }

      const result = await svc.transferPoints(fromUserId, toUsername, amount, senderUsername);
      res.json({ success: true, ...result });
    } catch (error) {
      if (respondGameMechanicsError(error, res)) return;
      // E7: see /gamble — decrement race surfaces as a 400, not a 500.
      if (error instanceof AccountServiceError) {
        return res.status(error.statusCode).json({
          success: false,
          error: error.clientMessage,
        });
      }
      logger.error('❌ TRANSFER: Error transferring points:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to transfer points'
      });
    }
  });

  // Admin endpoint to award points to a user (creates new points)
  router.post('/admin/award-points', express.json(), async (req, res) => {
    try {
      const { targetUsername, amount, adminUserId } = req.body;

      if (!targetUsername || !amount || !adminUserId) {
        return res.status(400).json({
          success: false,
          error: 'Missing required parameters'
        });
      }

      // E6: server-side positive-integer validation (same guard as /gamble).
      if (!Number.isInteger(amount) || amount <= 0) {
        return res.status(400).json({
          success: false,
          error: 'amount must be a positive integer'
        });
      }

      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }
      const token = authHeader.substring(7);
      const decoded = authService.verifyToken(token);
      if (!decoded || decoded.id !== adminUserId) {
        return res.status(401).json({ success: false, error: 'Invalid admin credentials' });
      }

      const accountService = new AccountService();
      const result = await accountService.adminGrantPoints(adminUserId, targetUsername, amount);
      res.json({ success: true, ...result });
    } catch (error) {
      if (error instanceof AccountServiceError) {
        return res.status(error.statusCode).json({
          success: false,
          error: error.clientMessage,
        });
      }
      logger.error('❌ ADMIN: Error giving points:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to give points'
      });
    }
  });

  // Admin endpoint to take points from a user
  router.post('/admin/take-points', express.json(), async (req, res) => {
    try {
      const { targetUsername, amount, adminUserId } = req.body;

      if (!targetUsername || !amount || !adminUserId) {
        return res.status(400).json({
          success: false,
          error: 'Missing required parameters'
        });
      }

      // E6: server-side positive-integer validation (same guard as /gamble).
      if (!Number.isInteger(amount) || amount <= 0) {
        return res.status(400).json({
          success: false,
          error: 'amount must be a positive integer'
        });
      }

      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }
      const token = authHeader.substring(7);
      const decoded = authService.verifyToken(token);
      if (!decoded || decoded.id !== adminUserId) {
        return res.status(401).json({ success: false, error: 'Invalid admin credentials' });
      }

      const accountService = new AccountService();
      const result = await accountService.adminRevokePoints(adminUserId, targetUsername, amount);
      res.json({ success: true, ...result });
    } catch (error) {
      if (error instanceof AccountServiceError) {
        return res.status(error.statusCode).json({
          success: false,
          error: error.clientMessage,
        });
      }
      logger.error('❌ ADMIN: Error taking points:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to take points'
      });
    }
  });

  return router;
};
