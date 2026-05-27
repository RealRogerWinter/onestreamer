// server/services/ModerationNotifier.js
//
// Single emission chokepoint for AI-moderation socket events, following the
// chokepoint pattern from PR 3.1 (StreamNotifier), PR 3.2 (ViewerCountNotifier),
// and PR 3.3 (BuffNotifier). Part of PR-M1 of [ADR-0013].
//
// Events owned by this chokepoint:
//   - moderation-event-created          → admin room only
//   - moderation-action-taken           → admin room only (M3+)
//   - moderation-streamer-banner        → individual streamer socket (M3+)
//   - moderation-bot-output-dropped     → admin room only (M4+)
//
// Admin-room emissions go to the existing `'admin'` Socket.IO room which
// AdminPanelV3 sockets join on auth (same pattern as the existing ban /
// streaming-log emits). Streamer-banner emissions go to a specific socket
// id resolved by ModerationActionArbiter at action time.
//
// All payloads are pinned in `MODERATION_EVENT_DECISIONS` so receivers
// (the new AdminPanelV3 tabs) can switch on `final_decision` deterministically.

class ModerationNotifier {
  /**
   * @param {object} io Socket.IO server instance.
   */
  constructor(io) {
    if (!io) {
      throw new Error('ModerationNotifier requires a Socket.IO instance');
    }
    this.io = io;
  }

  /**
   * Notify admins that the pipeline has written a moderation_events row.
   * Fires on EVERY non-clean decision (Stage 1 hit + Stage 2 evaluation +
   * Stage 3 cross-check), including 'admin_review' rows that don't trigger
   * an action. The admin UI uses this to refresh the events list live.
   *
   * @param {object} opts
   * @param {object} opts.event The moderation_events row (id, stream_type,
   *                            final_decision, transcript_excerpt,
   *                            created_at — full row OK, the admin UI
   *                            re-fetches details on click).
   */
  eventCreated(opts = {}) {
    const { event } = opts;
    if (!event || typeof event !== 'object') {
      console.warn('⚠️ MOD_NOTIFIER: eventCreated called without event — emit suppressed');
      return;
    }
    if (!event.final_decision) {
      console.warn('⚠️ MOD_NOTIFIER: eventCreated event lacks final_decision — emit suppressed');
      return;
    }
    if (!ModerationNotifier.MODERATION_EVENT_DECISIONS.has(event.final_decision)) {
      console.warn(`⚠️ MOD_NOTIFIER: unknown final_decision "${event.final_decision}" — MODERATION_EVENT_DECISIONS set is out of date`);
    }
    this.io.to('admin').emit('moderation-event-created', { event });
  }

  /**
   * Notify admins that ModerationActionArbiter took an enforcement action
   * (ban, skip, blocklist add). Wired in PR-M3.
   *
   * @param {object} opts
   * @param {object} opts.event The moderation_events row that fired the action.
   * @param {object} opts.action {kind: 'ban'|'skip'|'blocklist', details: ...}
   */
  actionTaken(opts = {}) {
    const { event, action } = opts;
    if (!event || !action) {
      console.warn('⚠️ MOD_NOTIFIER: actionTaken called without event or action — emit suppressed');
      return;
    }
    this.io.to('admin').emit('moderation-action-taken', { event, action });
  }

  /**
   * Send the in-stream banner to the streamer being banned mid-stream.
   * Wired in PR-M3 and rendered by AIModerationBanner.tsx (PR-M5).
   *
   * @param {object} opts
   * @param {string} opts.socketId    Required. The streamer's socket id.
   * @param {object} opts.event       The moderation_events row driving the ban.
   * @param {string} opts.appealUrl   Statement-of-reasons / appeal URL.
   */
  streamerBanner(opts = {}) {
    const { socketId, event, appealUrl } = opts;
    if (!socketId) {
      console.warn('⚠️ MOD_NOTIFIER: streamerBanner called without socketId — emit suppressed');
      return;
    }
    if (!event) {
      console.warn('⚠️ MOD_NOTIFIER: streamerBanner called without event — emit suppressed');
      return;
    }
    this.io.to(socketId).emit('moderation-streamer-banner', {
      event_id: event.id,
      transcript_excerpt: event.transcript_excerpt,
      categories: event.stage2_categories_json
        ? JSON.parse(event.stage2_categories_json)
        : [],
      appeal_url: appealUrl || null,
    });
  }

  /**
   * Notify admins that a MovieBot output was dropped because it failed the
   * output gate. Wired in PR-M4.
   *
   * @param {object} opts
   * @param {object} opts.event The moderation_events row tagged
   *                            stream_type='moviebot-output'.
   */
  botOutputDropped(opts = {}) {
    const { event } = opts;
    if (!event) {
      console.warn('⚠️ MOD_NOTIFIER: botOutputDropped called without event — emit suppressed');
      return;
    }
    this.io.to('admin').emit('moderation-bot-output-dropped', { event });
  }
}

// All `final_decision` values that may appear on a moderation_events row.
// The schema's CHECK constraint enumerates the same set; this Set is the
// runtime mirror used to warn on drift between the two.
ModerationNotifier.MODERATION_EVENT_DECISIONS = new Set([
  'clean',
  'admin_review',
  'auto_ban',
  'auto_skip',
  'mb_output_dropped',
  'deferred_degraded',
]);

module.exports = ModerationNotifier;
