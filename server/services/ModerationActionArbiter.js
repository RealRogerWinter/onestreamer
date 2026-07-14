const logger = require('../bootstrap/logger').child({ svc: 'ModerationActionArbiter' });

// server/services/ModerationActionArbiter.js
//
// Decides the enforcement action for a fully-classified moderation event
// (PR-M3 of [ADR-0013]).
//
// Inputs (constructor deps): the minimum service surface needed to act —
// userRepository (writes streaming_banned), sessionService (resolves
// socketId → user_id for the ban write), streamService (stale-session
// check), randomStreamRotationService (force-rotate after ban/skip),
// whitelistService (insert URL-relay block entry), moderationNotifier
// (stream the action to admin sockets + streamer banner), and a clock
// for the stale-session check.
//
// Decision tree:
//   1. **Stale-session check.** If event.stream_session_id !==
//      streamService.getStreamGeneration() at action time, the streamer
//      has already rotated for an unrelated reason. Auto-acting would
//      ban whoever is currently on-air, not the offending streamer.
//      Downgrade to 'admin_review' and return without action.
//   2. **AI_MODERATION_ENFORCE gate.** If the env flag is `false` (M3
//      default; M6 flips it to `true`), every verdict downgrades to
//      'admin_review'. The arbiter still runs the stale check so admins
//      see the same row shape as production would.
//   3. **Branch on stream_type:**
//      - 'webcam':
//          - Look up user_id via sessionService.getUserIdBySocketId.
//          - If found: userRepository.banFromStreaming(user_id, 'ai-moderation').
//          - Either way: emit streamer-banner via notifier, request rotation.
//          - final_decision = 'auto_ban'.
//      - 'url-relay':
//          - Resolve the external identity: event.external_platform/
//            external_login when present, else (audit M3) from the LIVE
//            relay via viewBotURLService.getActiveURLStream() — transcript
//            chunks and vision events never carry the external_* fields, so
//            without this fallback the auto-block never fired. The stale-
//            session check above guarantees the live relay is still the
//            offending one.
//          - Insert block entry via whitelistService.addEntry({
//              platform, entry_type: 'streamer', value: <login>,
//              list: 'block', notes: 'AI moderation auto-block: event #<id>'
//            }, 'ai-moderator'). PR-M7 swaps this to numeric external_user_id
//            keying for spoof resistance — M3 stays login-keyed.
//          - Force rotation.
//          - final_decision = 'auto_skip' when the block actually landed;
//            'admin_review' (fail-honest, audit M3) when the identity is
//            unresolvable or the block write failed — previously that path
//            still recorded 'auto_skip' as if the block had happened.
//      - 'viewbot' / unknown:
//          - Log only. final_decision = 'admin_review'.
//
// The arbiter never throws — every step is wrapped so a failing rotation
// or ban write produces a logged + structured action_taken string rather
// than corrupting the moderation_events row.

class ModerationActionArbiter {
  /**
   * @param {object} deps
   * @param {object}  deps.userRepository             writes streaming_banned
   * @param {object}  deps.sessionService             socketId → userId
   * @param {object}  deps.streamService              streamGeneration check
   * @param {object?} deps.randomStreamRotationService  force-rotate
   * @param {object?} deps.whitelistService           URL-relay block entry
   * @param {object?} deps.viewBotURLService          live-relay identity
   *                                                  resolution (audit M3)
   * @param {object}  deps.moderationNotifier         socket emits
   * @param {boolean} [deps.enforce=false]            AI_MODERATION_ENFORCE
   */
  constructor(deps = {}) {
    if (!deps.userRepository) throw new Error('ActionArbiter requires userRepository');
    if (!deps.sessionService) throw new Error('ActionArbiter requires sessionService');
    if (!deps.streamService) throw new Error('ActionArbiter requires streamService');
    if (!deps.moderationNotifier) throw new Error('ActionArbiter requires moderationNotifier');

    this.userRepository = deps.userRepository;
    this.sessionService = deps.sessionService;
    this.streamService = deps.streamService;
    this.randomStreamRotationService = deps.randomStreamRotationService || null;
    this.whitelistService = deps.whitelistService || null;
    this.viewBotURLService = deps.viewBotURLService || null;
    this.moderationNotifier = deps.moderationNotifier;
    this.enforce = !!deps.enforce;
  }

  /**
   * Toggle the enforcement flag at runtime. Called by ModerationService when
   * the global-config row changes via the admin UI. The next arbitrate()
   * call uses the new value — no restart required. Idempotent.
   */
  setEnforce(enforce) {
    this.enforce = !!enforce;
  }

  /**
   * Decide and perform the action for a moderation event whose Stage 2
   * (and Stage 3 when applicable) verdicts agree on high risk.
   *
   * @param {object} event A moderation_events-shaped object (must include
   *                       id, stream_session_id, streamer_id, stream_type,
   *                       and optionally external_platform/external_login/
   *                       external_user_id for URL-relay events).
   * @returns {Promise<{final_decision: string, action_taken: string|null}>}
   */
  async arbitrate(event) {
    if (!event) {
      return { final_decision: 'admin_review', action_taken: 'no_event' };
    }

    // Stale-session check. The streamGeneration in StreamService bumps on
    // every setStreamer / clearStreamer; if it doesn't match what was
    // captured when the chunk was emitted, the offending streamer has
    // already rotated and we'd ban the wrong account.
    const currentGen = String(this.streamService.getStreamGeneration());
    if (event.stream_session_id && event.stream_session_id !== currentGen) {
      return {
        final_decision: 'admin_review',
        action_taken: `stale_session:event=${event.stream_session_id},current=${currentGen}`,
      };
    }

    if (!this.enforce) {
      return {
        final_decision: 'admin_review',
        action_taken: 'enforce_off',
      };
    }

    switch (event.stream_type) {
      case 'webcam':
        return this._actWebcam(event);
      case 'url-relay':
        return this._actUrlRelay(event);
      case 'viewbot':
      case 'moviebot-output':
      default:
        return {
          final_decision: 'admin_review',
          action_taken: `no_action_for_stream_type:${event.stream_type || 'unknown'}`,
        };
    }
  }

  async _actWebcam(event) {
    const socketId = event.streamer_id;
    const userId = socketId ? this.sessionService.getUserIdBySocketId(socketId) : null;
    let banResult = 'none';
    if (userId) {
      try {
        await this.userRepository.banFromStreaming(userId, 'ai-moderation');
        banResult = `banned:${userId}`;
      } catch (err) {
        logger.error('❌ ActionArbiter: banFromStreaming failed:', err.message);
        banResult = `ban_error:${err.message}`;
      }
    } else {
      banResult = 'anonymous_streamer_no_user_id';
    }

    // Streamer banner: only fires if we have a socket id to address.
    if (socketId) {
      try {
        this.moderationNotifier.streamerBanner({
          socketId,
          event,
          appealUrl: `/admin/moderation/events/${event.id}`,
        });
      } catch (err) {
        logger.error('❌ ActionArbiter: streamerBanner failed:', err.message);
      }
    }

    // Force rotation. If RandomStreamRotationService isn't wired in this
    // backend (it's optional on some test setups), skip silently — the ban
    // alone takes the user off-air on next stream attempt.
    let rotationResult = 'none';
    if (this.randomStreamRotationService && typeof this.randomStreamRotationService._rotateToNewStream === 'function') {
      try {
        const r = await this.randomStreamRotationService._rotateToNewStream();
        rotationResult = r && r.success ? 'rotated' : `rotation_failed:${r && r.error || 'unknown'}`;
      } catch (err) {
        logger.error('❌ ActionArbiter: rotation threw:', err.message);
        rotationResult = `rotation_error:${err.message}`;
      }
    }

    return {
      final_decision: 'auto_ban',
      action_taken: `${banResult};rotation=${rotationResult}`,
      // M5 (audit): surface the numeric user id the ban landed on so the
      // caller (ModerationService) can persist it on the moderation_events
      // row (resolved_user_id) — the reverse route unbans by this stable id
      // instead of re-resolving the ephemeral socket id live.
      banned_user_id: userId || null,
    };
  }

  async _actUrlRelay(event) {
    let platform = event.external_platform;
    let login = event.external_login;

    // M3 (audit): the transcript/vision pipelines never populate the
    // external_* fields on their events, so resolve the identity from the
    // LIVE relay at this single chokepoint. Safe because the stale-session
    // check in arbitrate() already established that the stream generation
    // hasn't rotated since the offending chunk was captured.
    if ((!platform || !login) && this.viewBotURLService
        && typeof this.viewBotURLService.getActiveURLStream === 'function') {
      try {
        const active = this.viewBotURLService.getActiveURLStream();
        if (active) {
          platform = platform || active.platform || null;
          if (!login && active.sourceUrl && platform
              && typeof this.viewBotURLService._extractLoginFromUrl === 'function') {
            login = this.viewBotURLService._extractLoginFromUrl(active.sourceUrl, platform) || null;
          }
        }
      } catch (err) {
        logger.error('❌ ActionArbiter: live relay identity resolution failed:', err.message);
      }
    }

    let blockResult = 'none';
    let blocked = false;
    if (this.whitelistService && platform && login) {
      try {
        const r = await this.whitelistService.addEntry({
          platform,
          entry_type: 'streamer',
          value: login,
          list: 'block',
          notes: `AI moderation auto-block: event #${event.id}`,
        }, 'ai-moderator');
        blockResult = `blocked:${platform}:${login}:id=${r && r.id ? r.id : '?'}`;
        blocked = true;
      } catch (err) {
        // UNIQUE constraint hit (already on the list) is a no-op success.
        if (String(err.message || '').includes('UNIQUE')) {
          blockResult = `already_blocked:${platform}:${login}`;
          blocked = true;
        } else {
          logger.error('❌ ActionArbiter: whitelist.addEntry failed:', err.message);
          blockResult = `block_error:${err.message}`;
        }
      }
    } else {
      blockResult = `url_relay_block_unresolved:platform=${platform || 'none'},login=${login || 'none'},whitelist=${!!this.whitelistService}`;
    }

    let rotationResult = 'none';
    if (this.randomStreamRotationService && typeof this.randomStreamRotationService._rotateToNewStream === 'function') {
      try {
        const r = await this.randomStreamRotationService._rotateToNewStream();
        rotationResult = r && r.success ? 'rotated' : `rotation_failed:${r && r.error || 'unknown'}`;
      } catch (err) {
        logger.error('❌ ActionArbiter: rotation threw:', err.message);
        rotationResult = `rotation_error:${err.message}`;
      }
    }

    // Fail-honest (audit M3): only claim 'auto_skip' when the blocklist
    // write actually landed (or the entry already existed). An unresolved
    // identity or a failed write downgrades to 'admin_review' so the event
    // row no longer records a block that never happened. The rotation still
    // ran either way (the offending relay is off-air), but without the
    // block it is re-selectable — hence the admin escalation.
    return {
      final_decision: blocked ? 'auto_skip' : 'admin_review',
      action_taken: `${blockResult};rotation=${rotationResult}`,
    };
  }
}

module.exports = ModerationActionArbiter;
