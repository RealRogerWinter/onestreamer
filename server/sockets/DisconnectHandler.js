/**
 * DisconnectHandler
 *
 * Registers the per-connection `disconnect` listener that runs the global
 * socket-teardown sequence. Carved out of `server/index.js` as part of the
 * Phase 4 inline-listener sweep so the orchestrator file shrinks toward
 * its Phase 5 size budget.
 *
 * The body is byte-equivalent to the original inline version — same order,
 * same logging, same swallowed-error sites. Two inline `setTimeout` calls
 * (3s viewbot-rotation restart after a real-user disconnect; 1s real-
 * streamer-status validation) are preserved here unchanged; relocating
 * them into the LifecycleManager is PR 4.2's job, deliberately scoped out
 * of this listener-relocation PR.
 *
 * `deps` (all required unless noted):
 *   - lifecycleManager          PR 4.2 deferred-work registry. The two
 *                               grace-period schedules in this handler
 *                               (3 s rotation restart, 1 s real-streamer-
 *                               status validation) route through it so
 *                               SIGTERM during the window cancels them.
 *   - mediasoupService          Plain-RTP transport bookkeeping for the
 *                               socket; cascading `cleanup(socketId)` at the
 *                               end. Also has its `currentStreamer` cleared
 *                               directly when the current streamer leaves.
 *   - sessionService            IP/session lookup, socket→user resolution,
 *                               and `unregisterSocket()` for the IP map.
 *   - timeTrackingService       `handleUserDisconnect` flush for authed
 *                               sockets.
 *   - notifiedStreamers         Set<socketId> shared with the join paths;
 *                               cleared so a re-join can re-notify.
 *   - viewbotSocketIds          Set<socketId> tracking ViewBot-owned
 *                               sockets so we know to run the ViewBot
 *                               cleanup branch.
 *   - cleanupViewbotUsername    `(socketId) => void` closure from index.js
 *                               that clears a cached username for the
 *                               disappearing ViewBot.
 *   - plainTransportService     `cleanup(botId)` for the ViewBot's
 *                               Plain-RTP transport pair.
 *   - streamService             Source of truth for the current streamer
 *                               and viewer set.
 *   - takeoverService           `setSocketCooldown` after a real-user
 *                               streamer disconnect.
 *   - streamingLogsService      `endSession` for the disconnecting real
 *                               streamer.
 *   - streamNotifier            Chokepoint for the `stream-ended` broadcast
 *                               with `reason: 'streamer_disconnected'`.
 *   - notifyViewersStreamEnded  Closure from index.js that emits the
 *                               viewer-side cleanup cascade. Companion to
 *                               `streamNotifier.streamEnded` — they are
 *                               always called together on the streamer-
 *                               disconnect path.
 *   - viewerCountNotifier       Chokepoint for `viewer-count-update`.
 *   - SimpleViewBotRotation     Singleton module; restarted from inside the
 *                               3-second deferred work.
 *   - getViewbotService         `() => viewbotService` getter — viewbotService
 *                               is late-init (post-MediaSoup) so we capture
 *                               the live reference at firing time, not at
 *                               registration time.
 *   - getViewBotClientService   `() => viewBotClientService` getter — same
 *                               reason as above.
 */
module.exports = function registerDisconnectHandler(io, socket, deps) {
  const {
    lifecycleManager,
    mediasoupService,
    sessionService,
    timeTrackingService,
    notifiedStreamers,
    viewbotSocketIds,
    cleanupViewbotUsername,
    plainTransportService,
    streamService,
    takeoverService,
    streamingLogsService,
    streamNotifier,
    notifyViewersStreamEnded,
    viewerCountNotifier,
    SimpleViewBotRotation,
    getViewbotService,
    getViewBotClientService,
  } = deps;

  socket.on('disconnect', async () => {
    // Clean up ViewBot Plain RTP transports if exist (in case cleanup wasn't called)
    if (mediasoupService.transports?.has(socket.id)) {
      const transports = mediasoupService.transports.get(socket.id);
      try {
        // Handle both single transport and dual transport cases
        if (transports.video && transports.audio) {
          // Dual transport case (ViewBots)
          if (!transports.video.closed) transports.video.close();
          if (!transports.audio.closed) transports.audio.close();
          console.log(`🧹 SERVER: Closed Plain RTP transports (video & audio) for socket ${socket.id}`);
        } else if (typeof transports.close === 'function' && !transports.closed) {
          // Single transport case
          transports.close();
          console.log(`🧹 SERVER: Closed Plain RTP transport for socket ${socket.id}`);
        }
      } catch (e) {
        console.error('Error closing transports:', e);
      }
      mediasoupService.transports.delete(socket.id);
    }

    // Handle time tracking cleanup for authenticated users
    const ip = sessionService.getIpAddress(socket);
    const session = sessionService.getSessionByIp(ip);
    if (session && session.userId) {
      await timeTrackingService.handleUserDisconnect(session.userId, socket.id);
      console.log(`📊 TIME: Cleaned up time tracking for disconnected user ${session.userId}`);
    }

    // Unregister session for this socket
    const actualIp = sessionService.unregisterSocket(socket.id);
    console.log(`User disconnected: ${socket.id} from IP: ${actualIp}`);

    // Clean up notified streamers tracking
    notifiedStreamers.delete(socket.id);

    // Resolve late-init services once so the rest of the handler body
    // sees a single consistent snapshot of viewbotService / viewBotClientService
    // (they're reassigned by startServer after MediaSoup init — capture here
    // means a re-init that lands between branches can't half-apply).
    const viewbotService = getViewbotService();
    const viewBotClientService = getViewBotClientService();

    // Clean up ViewBot tracking and username cache if this was a ViewBot
    if (viewbotSocketIds.has(socket.id)) {
      cleanupViewbotUsername(socket.id);

      // Clean up Plain Transport resources for disconnected ViewBot
      if (viewBotClientService && plainTransportService) {
        const botId = viewBotClientService.getBotIdBySocketId(socket.id);
        if (botId) {
          console.log(`🧹 DISCONNECT: Cleaning up Plain Transport for ViewBot ${botId}`);
          await plainTransportService.cleanup(botId);
        }
      }
    }

    // Clean up mediasoup resources
    mediasoupService.cleanup(socket.id);

    if (streamService.getCurrentStreamer() === socket.id) {
      // Check if disconnecting streamer was a real user (not viewbot)
      // Enhanced ViewBot detection for disconnect handling
      const isOldViewBot = viewbotService && viewbotService.isViewbotStream(socket.id);
      const userId = sessionService.getUserIdBySocketId(socket.id);
      const isNewViewBot = userId && userId < 0;
      const isViewbot = isOldViewBot || isNewViewBot;
      const isRealUser = !isViewbot;

      console.log(`🔍 DISCONNECT CHECK: Socket ${socket.id.substring(0, 12)}...`);
      console.log(`   Old ViewBot: ${isOldViewBot}`);
      console.log(`   New ViewBot: ${isNewViewBot} (userID: ${userId})`);
      console.log(`   Is ViewBot: ${isViewbot}, Is Real User: ${isRealUser}`);

      // End streaming log session for real streamers
      if (isRealUser) {
        await streamingLogsService.endSession(socket.id, 'disconnect');
      }

      // If real user is disconnecting, clear the protection flag and restart viewbot rotation
      if (isRealUser && viewBotClientService) {
        console.log(`🔓 PRIORITY: Real user ${socket.id} disconnected - clearing viewbot protection`);
        viewBotClientService.setRealStreamerStatus(false);

        // CRITICAL: Restart viewbot rotation after real user disconnects.
        // stopRotation() disables the rotation service, so we re-enable it
        // after a 3 s settle window. Routed through LifecycleManager (PR
        // 4.2) so a SIGTERM landing inside the window cancels the restart
        // against torn-down rotation services rather than firing against
        // half-cleaned-up state.
        lifecycleManager.schedule('viewbot-rotation-restart-after-disconnect', async () => {
          console.log(`🔄 RESTART: Attempting to restart viewbot rotation after real user disconnect`);

          // Restart ViewBotRotationService (global.viewBotRotation)
          if (global.viewBotRotation && global.viewBotRotation.startRotation) {
            try {
              console.log(`🚀 RESTART: Restarting global.viewBotRotation`);
              await global.viewBotRotation.startRotation();
            } catch (e) {
              console.error(`❌ RESTART: Failed to restart global.viewBotRotation:`, e);
            }
          }

          // Also restart SimpleViewBotRotation if it was stopped
          if (SimpleViewBotRotation && SimpleViewBotRotation.startRotation) {
            try {
              console.log(`🚀 RESTART: Restarting SimpleViewBotRotation`);
              await SimpleViewBotRotation.startRotation();
            } catch (e) {
              console.error(`❌ RESTART: Failed to restart SimpleViewBotRotation:`, e);
            }
          }
        }, 3000);
      }

      // Only apply individual cooldown for real users, not viewbots
      if (!isViewbot) {
        await takeoverService.setSocketCooldown(socket.id, 'streamer_disconnect');
        console.log(`🔒 COOLDOWN: Applied individual cooldown to real user ${socket.id} for streamer disconnect`);
      } else {
        console.log(`🤖 COOLDOWN: Skipping individual cooldown for viewbot ${socket.id} disconnect`);
      }

      streamService.clearStreamer();
      // CRITICAL FIX: Also clear MediasoupService currentStreamer
      mediasoupService.currentStreamer = null;
      console.log(`🧹 DISCONNECT: Cleared ${socket.id} from both services`);

      // Additional validation: Ensure real streamer status is accurate after disconnect.
      // PR 4.2: routed through LifecycleManager so the 1 s grace window is
      // cancelled on SIGTERM.
      if (viewBotClientService) {
        lifecycleManager.schedule('real-streamer-status-validate', () => {
          viewBotClientService.validateRealStreamerStatus();
        }, 1000);
      }

      streamNotifier.streamEnded({ reason: 'streamer_disconnected', previousStreamer: socket.id });
      notifyViewersStreamEnded();
    } else {
      streamService.removeViewer(socket.id);
    }

    // Emit unique viewer count based on IPs
    viewerCountNotifier.broadcast();
  });
};
