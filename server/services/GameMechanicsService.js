// server/services/GameMechanicsService.js
//
// Game-mechanic primitives for the chat-economy money-flow endpoints in
// server/routes/internal.js: /gamble, /slots, /claim-chat-bonus,
// /transfer-points, and the read-only /bonus-status/:userId.
//
// Why this service exists: each of those routes currently carries 60–110 lines
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
//     read-only /bonus-status route (which doesn't necessarily go through
//     this service in the thin-handler form) can read it directly. The Map
//     is passed by reference into this service's constructor — same
//     shared-by-reference pattern PR 15B.2.a used for `lastEmittedStreamReady`.
//
// PR 16.1 lands this file as a SCAFFOLD: methods throw `not implemented`.
// PR 16.2 lifts the actual game-mechanic bodies out of routes/internal.js
// into this service unchanged, and adds unit tests.

const logger = require('../bootstrap/logger').child({ svc: 'GameMechanicsService' });

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

  async gamble(/* userId, betAmount */) {
    throw new Error('GameMechanicsService.gamble not implemented (PR 16.2)');
  }

  async slots(/* userId, betAmount */) {
    throw new Error('GameMechanicsService.slots not implemented (PR 16.2)');
  }

  async claimChatBonus(/* userId */) {
    throw new Error('GameMechanicsService.claimChatBonus not implemented (PR 16.2)');
  }

  async transferPoints(/* senderId, recipientUsername, amount */) {
    throw new Error('GameMechanicsService.transferPoints not implemented (PR 16.2)');
  }

  getBonusStatus(/* userId */) {
    throw new Error('GameMechanicsService.getBonusStatus not implemented (PR 16.2)');
  }
}

module.exports = GameMechanicsService;
