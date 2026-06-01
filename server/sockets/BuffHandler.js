/**
 * BuffHandler
 *
 * Registers buff/debuff socket events on a per-connection basis.
 * Continuation of PR-H's socket-extraction pattern.
 * Carved out separately in PR-H6 because the buff
 * system has a distinct dependency surface (6 services) and includes
 * viewbot-target translation logic that doesn't belong with visual FX.
 *
 * Handlers (all logic byte-equivalent to the original inline versions):
 *   - apply-buff-item      Apply a buff/debuff item to a target user. Handles
 *                          viewbot target translation (socket ID -> synthetic
 *                          negative user ID), consumes the item from the
 *                          caller's inventory, and broadcasts an update to
 *                          all clients for human targets.
 *   - get-my-buffs         Send the authenticated caller their active buffs.
 *   - get-streamer-buffs   Send active buffs for the current streamer to any
 *                          caller (no auth required).
 *   - remove-my-buff       Remove a buff owned by the authenticated caller,
 *                          then push them an updated buff list.
 *
 * `deps` (all required):
 *   - itemService          Used to apply the buff/debuff item.
 *   - inventoryService     Used to remove the consumed item from inventory.
 *   - buffDebuffService    Source of truth for active buffs.
 *   - viewbotService       Used to detect viewbot targets for ID translation.
 *   - streamService        Used to look up the current streamer (viewbot path).
 *   - sessionService       Used to resolve the requester's session and to
 *                          translate viewbot socket IDs to synthetic user IDs.
 *
 * `io` is also required for the user-buff-update broadcast on successful
 * apply against a human target.
 */
const logger = require('../bootstrap/logger').child({ svc: 'BuffHandler' });

module.exports = function registerBuffHandler(io, socket, deps) {
  const {
    itemService,
    inventoryService,
    buffDebuffService,
    viewbotService,
    streamService,
    sessionService,
    // PR 3.3: chokepoint for buff-error + per-socket streamer-buffs-update.
    buffNotifier,
  } = deps;

  // Buff/Debuff related socket events
  socket.on('apply-buff-item', async (data) => {
    try {
      let { targetUserId, itemId } = data;

      // Get the authenticated user ID
      const ip = sessionService.getIpAddress(socket);
      const session = sessionService.getSessionByIp(ip);
      if (!session || !session.userId) {
        buffNotifier.buffError({ toSocket: socket, error: 'Authentication required' });
        return;
      }

      const appliedByUserId = session.userId;

      // Handle viewbot target - convert socket ID to synthetic user ID
      if (viewbotService && viewbotService.isViewbotStream(targetUserId)) {
        const syntheticUserId = sessionService.getUserIdBySocketId(targetUserId);
        if (syntheticUserId) {
          logger.info(`🎭 BUFF SOCKET: Translating viewbot ${targetUserId} to synthetic user ${syntheticUserId}`);
          targetUserId = syntheticUserId;
        } else {
          buffNotifier.buffError({ toSocket: socket, error: 'Viewbot target not properly initialized for buff system' });
          return;
        }
      } else if (viewbotService && sessionService && streamService) {
        // Additional check: If client sent current streamer's user ID and current streamer is a viewbot
        const currentStreamer = streamService.getCurrentStreamer();

        if (currentStreamer && viewbotService.isViewbotStream(currentStreamer)) {
          // Check if the targetUserId might be the current streamer's user ID
          const currentStreamerUserId = sessionService.getUserIdBySocketId(currentStreamer);

          // Convert targetUserId to number for comparison if it's a string
          const targetUserIdNum = typeof targetUserId === 'string' ? parseInt(targetUserId, 10) : targetUserId;

          if (currentStreamerUserId && (targetUserIdNum === Math.abs(currentStreamerUserId))) {
            logger.info(`🎯 BUFF SOCKET: Client sent current streamer user ID, translating to viewbot`);
            logger.info(`🎭 BUFF SOCKET: Converting user ID ${targetUserId} to viewbot synthetic user ${currentStreamerUserId}`);
            targetUserId = currentStreamerUserId; // This should be the negative synthetic user ID
          }
        }
      }

      logger.info(`🎯 BUFF SOCKET: Final targetUserId after all processing: ${targetUserId} (type: ${typeof targetUserId})`);

      // Apply the buff/debuff
      const result = await itemService.applyBuffDebuffItem(
        targetUserId,
        itemId,
        appliedByUserId,
        buffDebuffService
      );

      // Consume the item from inventory
      await inventoryService.removeItemFromInventory(appliedByUserId, itemId, 1);

      socket.emit('buff-applied-success', { buff: result });

      // Only broadcast if target is not a viewbot (viewbots have synthetic negative user IDs)
      if (targetUserId >= 0) {
        // Also broadcast to the target user if they're online (only for human users)
        io.emit('user-buff-update', {
          userId: targetUserId,
          buffs: await buffDebuffService.getActiveBuffsForUser(targetUserId)
        });
      } else {
        logger.info(`🎭 BUFF: Skipping broadcast for viewbot user ${targetUserId} - buffs applied silently`);
      }

    } catch (error) {
      logger.error({ err: error }, 'Socket buff application error');
      buffNotifier.buffError({ toSocket: socket, error: error.message });
    }
  });

  socket.on('get-my-buffs', async () => {
    try {
      const ip = sessionService.getIpAddress(socket);
      const session = sessionService.getSessionByIp(ip);
      if (!session || !session.userId) {
        buffNotifier.buffError({ toSocket: socket, error: 'Authentication required' });
        return;
      }

      const buffs = await buffDebuffService.getActiveBuffsForUser(session.userId);
      socket.emit('my-buffs-update', { buffs });

    } catch (error) {
      logger.error({ err: error }, 'Socket get buffs error');
      buffNotifier.buffError({ toSocket: socket, error: error.message });
    }
  });

  socket.on('get-streamer-buffs', async () => {
    try {
      const buffs = await buffDebuffService.getActiveBuffsForCurrentStreamer();
      // PR 3.3: per-socket variant of streamer-buffs-update (query response,
      // not a state-change broadcast).
      buffNotifier.streamerBuffsUpdate({ buffs, toSocket: socket });

    } catch (error) {
      logger.error({ err: error }, 'Socket get streamer buffs error');
      buffNotifier.buffError({ toSocket: socket, error: error.message });
    }
  });

  socket.on('remove-my-buff', async (data) => {
    try {
      const { buffId } = data;

      const ip = sessionService.getIpAddress(socket);
      const session = sessionService.getSessionByIp(ip);
      if (!session || !session.userId) {
        buffNotifier.buffError({ toSocket: socket, error: 'Authentication required' });
        return;
      }

      // Get buff to verify ownership
      const buff = await buffDebuffService.getBuffById(buffId);
      if (!buff || buff.user_id != session.userId) {
        buffNotifier.buffError({ toSocket: socket, error: 'Buff not found or not owned by you' });
        return;
      }

      const success = await buffDebuffService.removeBuff(buffId, 'user_removed');
      if (success) {
        socket.emit('buff-removed-success', { buffId });

        // Update user's buff list
        const updatedBuffs = await buffDebuffService.getActiveBuffsForUser(session.userId);
        socket.emit('my-buffs-update', { buffs: updatedBuffs });
      } else {
        buffNotifier.buffError({ toSocket: socket, error: 'Failed to remove buff' });
      }

    } catch (error) {
      logger.error({ err: error }, 'Socket remove buff error');
      buffNotifier.buffError({ toSocket: socket, error: error.message });
    }
  });
};
