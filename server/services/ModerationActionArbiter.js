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
//          - Insert block entry via whitelistService.addEntry({
//              platform, entry_type: 'streamer', value: <login>,
//              list: 'block', notes: 'AI moderation auto-block: event #<id>'
//            }, 'ai-moderator'). PR-M7 swaps this to numeric external_user_id
//            keying for spoof resistance — M3 stays login-keyed.
//          - Force rotation.
//          - final_decision = 'auto_skip'.
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
        console.error('❌ ActionArbiter: banFromStreaming failed:', err.message);
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
        console.error('❌ ActionArbiter: streamerBanner failed:', err.message);
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
        console.error('❌ ActionArbiter: rotation threw:', err.message);
        rotationResult = `rotation_error:${err.message}`;
      }
    }

    return {
      final_decision: 'auto_ban',
      action_taken: `${banResult};rotation=${rotationResult}`,
    };
  }

  async _actUrlRelay(event) {
    const platform = event.external_platform;
    const login = event.external_login;
    let blockResult = 'none';
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
      } catch (err) {
        // UNIQUE constraint hit (already on the list) is a no-op success.
        if (String(err.message || '').includes('UNIQUE')) {
          blockResult = `already_blocked:${platform}:${login}`;
        } else {
          console.error('❌ ActionArbiter: whitelist.addEntry failed:', err.message);
          blockResult = `block_error:${err.message}`;
        }
      }
    } else {
      blockResult = `cannot_block:platform=${platform || 'none'},login=${login || 'none'},whitelist=${!!this.whitelistService}`;
    }

    let rotationResult = 'none';
    if (this.randomStreamRotationService && typeof this.randomStreamRotationService._rotateToNewStream === 'function') {
      try {
        const r = await this.randomStreamRotationService._rotateToNewStream();
        rotationResult = r && r.success ? 'rotated' : `rotation_failed:${r && r.error || 'unknown'}`;
      } catch (err) {
        console.error('❌ ActionArbiter: rotation threw:', err.message);
        rotationResult = `rotation_error:${err.message}`;
      }
    }

    return {
      final_decision: 'auto_skip',
      action_taken: `${blockResult};rotation=${rotationResult}`,
    };
  }
}

module.exports = ModerationActionArbiter;
