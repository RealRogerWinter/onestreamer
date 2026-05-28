// server/services/GameMechanicsService.js
//
// Game-mechanic primitives for the chat-economy money-flow endpoints in
// server/routes/internal.js: /gamble, /slots, /claim-chat-bonus,
// /transfer-points, and the read-only /bonus-status/:userId.
//
// Why this service exists: each of those routes used to carry 60–110 lines
// of inline logic (RNG rolls, slot payout tables, cooldown windows, balance
// math) inside the request handler. Putting it here lets the handlers shrink
// to thin auth + dispatch, and lets unit tests target the game logic directly
// without going through Express + supertest + a SQLite fixture.
//
// What it explicitly is NOT:
//   - The audited points ledger. That stays in AccountService. This service
//     delegates balance changes to AccountService.addPoints / subtractPoints
//     so every dollar still flows through the same audit trail.
//   - The owner of `userBonusCooldowns`. The Map is created in
//     server/index.js and exposed on `app.locals.userBonusCooldowns` so the
//     /bonus-status route can read the same data this service mutates. The
//     Map is passed by reference into this service's constructor — same
//     shared-by-reference pattern PR 15B.2.a used for `lastEmittedStreamReady`.
//
// Error contract: client-facing failures throw `GameMechanicsError`, an
// Error subclass carrying `{ statusCode, clientMessage, extra }`. Route
// handlers catch and map to res.status(...).json({ success: false, error,
// ...extra }) — preserving byte-equivalent HTTP shapes from the pre-PR
// inline handlers. Anything else propagates as a 500 (handler still owns
// the per-route 500 message string so the existing log lines are unchanged).

const logger = require('../bootstrap/logger').child({ svc: 'GameMechanicsService' });

class GameMechanicsError extends Error {
  /**
   * @param {number} statusCode      HTTP status to return.
   * @param {string} clientMessage   Goes into res.body.error.
   * @param {object} [extra={}]      Extra keys merged into the JSON body
   *                                 (e.g. `remainingSeconds`, `nextAvailable`
   *                                 on the bonus-cooldown 429).
   */
  constructor(statusCode, clientMessage, extra = {}) {
    super(clientMessage);
    this.name = 'GameMechanicsError';
    this.statusCode = statusCode;
    this.clientMessage = clientMessage;
    this.extra = extra;
  }
}

// 2-minute cooldown between chat-bonus claims. The pre-PR inline handler
// declared this as a local `const minimumCooldown` in BOTH the POST and the
// GET paths (verbatim same value); hoisting here keeps the read and write
// paths in lockstep.
const CHAT_BONUS_COOLDOWN_MS = 2 * 60 * 1000;
const CHAT_BONUS_AMOUNT = 100;

// Slot payout table — frozen so a future careless mutation gets a TypeError
// instead of silently shifting odds.
const SLOT_SYMBOLS = Object.freeze(['🍒', '🍋', '🍊', '🍇', '💎', '7️⃣']);

class GameMechanicsService {
  /**
   * @param {object} deps
   * @param {object} deps.accountService     AccountService instance — owns the
   *                                         audited points ledger. Every
   *                                         balance change flows through it.
   * @param {Map}    deps.userBonusCooldowns Shared Map<userId, lastClaimEpochMs>.
   *                                         Created in server/index.js and
   *                                         passed by reference; this service
   *                                         mutates it in claimChatBonus and
   *                                         reads it in getBonusStatus.
   */
  constructor({ accountService, userBonusCooldowns }) {
    if (!accountService) {
      throw new Error('GameMechanicsService requires accountService');
    }
    if (!userBonusCooldowns || typeof userBonusCooldowns.get !== 'function') {
      throw new Error('GameMechanicsService requires userBonusCooldowns Map');
    }
    this.accountService = accountService;
    this.userBonusCooldowns = userBonusCooldowns;
    this.logger = logger;
  }

  /**
   * 50/50 double-or-nothing gamble.
   *
   * @throws {GameMechanicsError} 400 'Insufficient points. You have X points'
   *                              when balance < amount.
   * @returns {Promise<{ won: boolean, amount: number, newBalance: number }>}
   */
  async gamble(userId, amount) {
    const currentBalance = await this.accountService.getPointsBalance(userId);

    if (currentBalance < amount) {
      throw new GameMechanicsError(
        400,
        `Insufficient points. You have ${currentBalance} points`
      );
    }

    const won = Math.random() < 0.5;
    let newBalance;

    if (won) {
      newBalance = await this.accountService.addPoints(
        userId,
        amount,
        'gamble_win',
        `Won ${amount} points gambling`,
        { amount, result: 'win' }
      );
    } else {
      newBalance = await this.accountService.subtractPoints(
        userId,
        amount,
        'gamble_loss',
        `Lost ${amount} points gambling`,
        { amount, result: 'loss' }
      );
    }

    this.logger.debug(
      `🎲 GAMBLE: User ${userId} ${won ? 'won' : 'lost'} ${amount} points. New balance: ${newBalance}`
    );

    return { won, amount, newBalance };
  }

  /**
   * 3-reel slot machine. Payout table (preserved verbatim from the pre-PR
   * inline handler):
   *   - 3× '7️⃣' → 10× bet (jackpot)
   *   - 3× '💎' → 5× bet
   *   - any other 3-of-a-kind → 3× bet
   *   - exactly 2-of-a-kind anywhere → bet returned (break-even)
   *   - otherwise → lose the bet
   *
   * @throws {GameMechanicsError} 400 'Insufficient points...' when balance <
   *                              amount.
   * @returns {Promise<{ symbols: string[], winAmount: number, newBalance: number }>}
   */
  async slots(userId, amount) {
    const currentBalance = await this.accountService.getPointsBalance(userId);

    if (currentBalance < amount) {
      throw new GameMechanicsError(
        400,
        `Insufficient points. You have ${currentBalance} points`
      );
    }

    const symbols = [
      SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)],
      SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)],
      SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)],
    ];

    let winAmount = 0;
    if (symbols[0] === symbols[1] && symbols[1] === symbols[2]) {
      if (symbols[0] === '7️⃣') {
        winAmount = amount * 10;
      } else if (symbols[0] === '💎') {
        winAmount = amount * 5;
      } else {
        winAmount = amount * 3;
      }
    } else if (
      symbols[0] === symbols[1] ||
      symbols[1] === symbols[2] ||
      symbols[0] === symbols[2]
    ) {
      winAmount = amount;
    }

    let newBalance;
    if (winAmount > amount) {
      const profit = winAmount - amount;
      newBalance = await this.accountService.addPoints(
        userId,
        profit,
        'slots_win',
        `Won ${profit} points on slots`,
        { bet: amount, symbols: symbols.join(''), winAmount }
      );
    } else if (winAmount === amount) {
      // Break-even — no ledger entry, balance reads unchanged.
      newBalance = currentBalance;
    } else {
      newBalance = await this.accountService.subtractPoints(
        userId,
        amount,
        'slots_loss',
        `Lost ${amount} points on slots`,
        { bet: amount, symbols: symbols.join(''), winAmount }
      );
    }

    this.logger.debug(
      `🎰 SLOTS: User ${userId} bet ${amount}, got [${symbols.join(' ')}], won ${winAmount}. New balance: ${newBalance}`
    );

    return { symbols, winAmount, newBalance };
  }

  /**
   * Award the 100-point chat bonus and stamp the cooldown.
   *
   * @throws {GameMechanicsError} 429 'Bonus on cooldown' with
   *                              `{ remainingSeconds, nextAvailable }` extras.
   * @returns {Promise<{ pointsAwarded: number, newBalance: number,
   *                     nextBonusDelay: number, nextBonusTime: string }>}
   */
  async claimChatBonus(userId) {
    const now = Date.now();
    const lastClaim = this.userBonusCooldowns.get(userId);

    if (lastClaim) {
      const timeSinceLastClaim = now - lastClaim;
      if (timeSinceLastClaim < CHAT_BONUS_COOLDOWN_MS) {
        const remainingTime = Math.ceil(
          (CHAT_BONUS_COOLDOWN_MS - timeSinceLastClaim) / 1000
        );
        this.logger.debug(
          `⏰ BONUS: User ${userId} tried to claim too soon. ${remainingTime}s remaining`
        );
        throw new GameMechanicsError(429, 'Bonus on cooldown', {
          remainingSeconds: remainingTime,
          nextAvailable: new Date(lastClaim + CHAT_BONUS_COOLDOWN_MS).toISOString(),
        });
      }
    }

    const newBalance = await this.accountService.addPoints(
      userId,
      CHAT_BONUS_AMOUNT,
      'chat_bonus',
      'Chat activity bonus',
      { source: 'chat_bonus_icon' }
    );

    this.userBonusCooldowns.set(userId, now);

    // The hard cooldown for the NEXT claim is CHAT_BONUS_COOLDOWN_MS (2 min).
    // `nextBonusDelay` is a SEPARATE random 2–6 minute window used by the
    // client to schedule when the bonus icon re-appears in the UI — not the
    // same thing as the server-side cooldown. Preserved verbatim from the
    // pre-PR inline handler.
    const nextBonusDelay = Math.floor(Math.random() * 240000) + 120000;
    const nextBonusTime = new Date(now + nextBonusDelay);

    this.logger.debug(
      `🎁 BONUS: User ${userId} claimed ${CHAT_BONUS_AMOUNT} chat bonus points. New balance: ${newBalance}. Next available: ${nextBonusTime.toISOString()}`
    );

    return {
      pointsAwarded: CHAT_BONUS_AMOUNT,
      newBalance,
      nextBonusDelay,
      nextBonusTime: nextBonusTime.toISOString(),
    };
  }

  /**
   * Read-only bonus availability check. Doesn't mutate the Map.
   *
   * @returns {{ available: true }
   *         | { available: false, remainingSeconds: number, nextAvailable: string }}
   */
  getBonusStatus(userId) {
    const now = Date.now();
    const lastClaim = this.userBonusCooldowns.get(userId);

    if (!lastClaim || (now - lastClaim) >= CHAT_BONUS_COOLDOWN_MS) {
      return { available: true };
    }

    const remainingTime = Math.ceil(
      (CHAT_BONUS_COOLDOWN_MS - (now - lastClaim)) / 1000
    );
    return {
      available: false,
      remainingSeconds: remainingTime,
      nextAvailable: new Date(lastClaim + CHAT_BONUS_COOLDOWN_MS).toISOString(),
    };
  }

  /**
   * Peer-to-peer points transfer. `senderUsername` is the optional display
   * name supplied by the client; when missing the service falls back to the
   * authoritative DB row (preserved from the pre-PR handler).
   *
   * @throws {GameMechanicsError} 404 'Sender not found', 404
   *                              `User 'X' not found`, 400 'Cannot send
   *                              points to yourself', 400 'Insufficient
   *                              points...'.
   * @returns {Promise<{ senderNewBalance: number, recipientNewBalance: number,
   *                     recipientUserId: number, recipientUsername: string }>}
   */
  async transferPoints(fromUserId, toUsername, amount, senderUsername) {
    const senderUser = await this.accountService.getUserById(fromUserId);
    if (!senderUser) {
      throw new GameMechanicsError(404, 'Sender not found');
    }

    const targetUser = await this.accountService.getUserByUsername(toUsername);
    if (!targetUser) {
      throw new GameMechanicsError(404, `User '${toUsername}' not found`);
    }

    if (targetUser.id === fromUserId) {
      throw new GameMechanicsError(400, 'Cannot send points to yourself');
    }

    const senderBalance = await this.accountService.getPointsBalance(fromUserId);
    if (senderBalance < amount) {
      throw new GameMechanicsError(
        400,
        `Insufficient points. You have ${senderBalance} points but tried to send ${amount}`
      );
    }

    const effectiveSenderUsername = senderUsername || senderUser.username;

    const senderNewBalance = await this.accountService.subtractPoints(
      fromUserId,
      amount,
      'transfer_out',
      `Sent ${amount} points to ${toUsername}`,
      { recipientId: targetUser.id, recipientUsername: toUsername }
    );

    const recipientNewBalance = await this.accountService.addPoints(
      targetUser.id,
      amount,
      'transfer_in',
      `Received ${amount} points from ${effectiveSenderUsername}`,
      { senderId: fromUserId, senderUsername: effectiveSenderUsername }
    );

    this.logger.debug(
      `💸 TRANSFER: ${effectiveSenderUsername} sent ${amount} points to ${toUsername}. Sender balance: ${senderNewBalance}, Recipient balance: ${recipientNewBalance}`
    );

    return {
      senderNewBalance,
      recipientNewBalance,
      recipientUserId: targetUser.id,
      recipientUsername: targetUser.username,
    };
  }
}

module.exports = GameMechanicsService;
module.exports.GameMechanicsError = GameMechanicsError;
// Exported constants for tests + a future read-side surface (e.g. the
// client could one day fetch `/api/bonus/config` instead of hard-coding 2
// minutes — out of scope for Phase 16).
module.exports.CHAT_BONUS_COOLDOWN_MS = CHAT_BONUS_COOLDOWN_MS;
module.exports.CHAT_BONUS_AMOUNT = CHAT_BONUS_AMOUNT;
module.exports.SLOT_SYMBOLS = SLOT_SYMBOLS;
