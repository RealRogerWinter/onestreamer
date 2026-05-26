/**
 * StreamHandler
 *
 * Registers the core streaming/takeover socket events on a per-connection
 * basis. Continuation of PR-H's socket-extraction pattern (see AdminHandler,
 * EffectHandler, GameHandler).
 *
 * Handlers (all logic byte-equivalent to the original inline versions):
 *   - join-as-viewer    A client opts in to receive the stream. Adds to the
 *                      viewers room, emits stream-status + rotation/cooldown
 *                      hints, starts time-tracking, etc.
 *   - request-to-stream A client asks to become the active streamer. Performs
 *                      permission/cooldown/IP-ban gating, stops any current
 *                      viewbot (or marks real-streamer-active), sets the new
 *                      streamer, emits stream-ended/streaming-approved, opens
 *                      logging/time-tracking sessions, and for ViewBots emits
 *                      stream-ready immediately.
 *   - stream-offer      Streamer -> specific viewer signalling pass-through
 *                      (legacy WebRTC P2P; the modern path uses MediaSoup).
 *   - stream-answer     Viewer  -> streamer signalling pass-through.
 *   - stop-streaming    The active streamer voluntarily ends their session.
 *                      Persists disconnect time, ends log + time-tracking
 *                      sessions, applies individual cooldown, broadcasts
 *                      stream-ended, clears viewbot protection, and (after a
 *                      delay) restarts viewbot rotation.
 *
 * Note: `stream-ready` is emitted by the server (e.g., by request-to-stream
 * for ViewBots, and from MediaSoup producer-created paths in index.js); there
 * is no `socket.on('stream-ready', ...)` to register, so it is not listed
 * here as a handler — it remains an outbound event only.
 *
 * `deps` (all required unless noted):
 *   - streamService            Active-streamer registry + status getters.
 *   - sessionService           Socket/IP -> session + userId mapping.
 *   - takeoverService          Cooldown ledger.
 *   - mediasoupService         For cleanup() on takeover + currentStreamer sync.
 *   - timeTrackingService      Viewing/streaming session bookkeeping.
 *   - buffDebuffService        Streamer-buff lookup on new-stream broadcast.
 *   - streamingLogsService     Per-session streaming log (start/end).
 *   - recordingService         Stream-end recording finalisation (may be null).
 *   - SimpleViewBotRotation    Module with stopRotation/startRotation.
 *   - IPBanService             Static helpers for IP fingerprint + ban lookup.
 *   - notifiedStreamers        Shared Set<string> of socket IDs the server has
 *                              already emitted stream-ready for.
 *   - viewbotSocketIds         Shared Set<string> of ViewBot socket IDs.
 *   - lastEmittedStreamReady   Shared mutable { streamerId, timestamp } used
 *                              to dedupe stream-ready emissions across the
 *                              process. MUST be mutated in place (not
 *                              reassigned) so other modules see updates.
 *   - getViewbotService        () => viewbotService. Lazy because the legacy
 *                              ViewbotService is constructed after io.on
 *                              wiring (post-startServer init).
 *   - getViewBotClientService  () => viewBotClientService. Same reason.
 *   - enrichStreamStatus       Helper from index.js: adds streamerDisplayName.
 *   - getStreamerDisplayName   Helper from index.js: socketId -> display name.
 *   - notifyViewersStreamStarted  Helper from index.js (room broadcast +
 *                                 server-side viewer-session bootstrapping).
 *   - notifyViewersStreamEnded    Helper from index.js (room broadcast +
 *                                 stop tracking + schedule rotation).
 *   - broadcastGlobalCooldown  Helper from index.js: cooldown fanout.
 *   - runAsync                 db helper (sqlite promisified writer).
 *   - database                 db handle (for allAsync reads).
 *   - axios                    HTTP client for chat-service announcement POST.
 *   - https                    Used for the relaxed-TLS Agent on the above.
 */
module.exports = function registerStreamHandler(io, socket, deps) {
  const {
    streamService,
    sessionService,
    takeoverService,
    mediasoupService,
    timeTrackingService,
    buffDebuffService,
    streamingLogsService,
    recordingService,
    SimpleViewBotRotation,
    IPBanService,
    notifiedStreamers,
    viewbotSocketIds,
    lastEmittedStreamReady,
    getViewbotService,
    getViewBotClientService,
    enrichStreamStatus,
    getStreamerDisplayName,
    notifyViewersStreamStarted,
    notifyViewersStreamEnded,
    broadcastGlobalCooldown,
    runAsync,
    database,
    axios,
    https,
    // PR 3.1: single `stream-ended` chokepoint. Used for both the takeover
    // broadcast (with excludeSocket) and the stop-streaming io-wide emit.
    streamNotifier,
  } = deps;

  socket.on('join-as-viewer', async () => {
    streamService.addViewer(socket.id);
    socket.join('viewers');

    // Get stream status with duration
    const status = streamService.getStreamStatus();
    // Override viewer count with IP-based count
    status.viewerCount = sessionService.getUniqueViewerCount();
    // Enrich with streamer display name
    const enrichedStatus = await enrichStreamStatus(status);
    socket.emit('stream-status', enrichedStatus);

    // Send random rotation status if active
    if (global.randomStreamRotationService) {
      const rotationStatus = global.randomStreamRotationService.getStatus();
      if (rotationStatus.enabled && rotationStatus.currentStream) {
        socket.emit('random-rotation-status', {
          enabled: true,
          currentStream: rotationStatus.currentStream,
          rotationTiming: rotationStatus.rotationTiming ? {
            nextRotationAt: rotationStatus.rotationTiming.nextRotationAt,
            currentRotationDuration: rotationStatus.rotationTiming.currentRotationDuration,
            serverTime: Date.now()
          } : null
        });

        // Send lock state if rotation is locked
        const lockStatus = global.randomStreamRotationService.getLockStatus();
        if (lockStatus.isLocked) {
          socket.emit('rotation-locked', {
            locked: true,
            remainingMs: lockStatus.remainingTimeWhenLocked,
            currentStream: rotationStatus.currentStream
          });
        }
      }
    }

    // Visual effects sync temporarily disabled to debug rotate_90 issue
    // try {
    //   const activeVisualEffects = await getActiveVisualEffects();
    //   if (activeVisualEffects.length > 0) {
    //     console.log(`🎨 VISUAL FX: Sending ${activeVisualEffects.length} active effects to new viewer ${socket.id}`);
    //
    //     // Send each effect to the viewer with a small delay to prevent overwhelming
    //     activeVisualEffects.forEach((buff, index) => {
    //       setTimeout(() => {
    //         socket.emit('visual-effect-sync', {
    //           effectId: buff.item_name,
    //           itemName: buff.item_name,
    //           displayName: buff.display_name,
    //           duration: buff.remaining_seconds * 1000,
    //           remainingSeconds: buff.remaining_seconds,
    //           effectData: buff.effect_data,
    //           isSyncEvent: true
    //         });
    //       }, index * 100); // 100ms between each effect
    //     });
    //   }
    // } catch (error) {
    //   console.error(`❌ VISUAL FX: Error sending effects to viewer ${socket.id}:`, error);
    // }

    // Emit unique viewer count based on IPs
    io.emit('viewer-count-update', sessionService.getUniqueViewerCount());

    // Start time tracking for viewing session if user is authenticated
    const ip = sessionService.getIpAddress(socket);
    const session = sessionService.getSessionByIp(ip);
    console.log(`📊 TIME DEBUG: join-as-viewer - IP: ${ip}, session: ${JSON.stringify(session)}, hasActiveStream: ${status.hasActiveStream}`);
    if (session && session.userId) {
      const hasActiveStream = status.hasActiveStream;
      timeTrackingService.startViewingSession(session.userId, socket.id, hasActiveStream);
      console.log(`📊 TIME: Started viewing time tracking for user ${session.userId}, active stream: ${hasActiveStream}`);
    } else {
      console.log(`📊 TIME DEBUG: No authenticated user found for socket ${socket.id} (IP: ${ip})`);
    }

    // Check if user has an active cooldown and send it to them
    const canTakeOver = await takeoverService.canTakeOver(socket.id);
    if (!canTakeOver.allowed) {
      console.log(`🔒 COOLDOWN: New viewer ${socket.id} has active cooldown (${canTakeOver.reason}: ${canTakeOver.cooldownRemaining}s)`);
      socket.emit('global-cooldown', {
        cooldownRemaining: canTakeOver.cooldownRemaining,
        reason: canTakeOver.reason
      });
    }
  });

  socket.on('request-to-stream', async (data, callback) => {
    console.log(`📥 STREAMING: Received request-to-stream from socket ${socket.id} at ${new Date().toISOString()}`);
    console.log(`📥 STREAMING: Request data:`, JSON.stringify(data));
    console.log(`📥 STREAMING: Callback type:`, typeof callback);
    console.log(`📥 STREAMING: Current streamer:`, streamService.getCurrentStreamer());
    console.log(`📥 STREAMING: Server state - hasStreamer:`, !!streamService.getCurrentStreamer());

    // CRITICAL: Check for permission confirmation (new in permission system)
    const isViewBot = data.isViewBot || data.streamType === 'viewbot';
    if (!isViewBot && data.streamType === 'webcam') {
      // For real users streaming from webcam, require permission confirmation
      if (!data.permissionsGranted) {
        console.log(`🚫 STREAMING: Request denied - no permission confirmation from ${socket.id}`);
        socket.emit('stream-denied', {
          reason: 'Camera and microphone permissions are required to stream',
          requiresPermissions: true,
          timestamp: new Date().toISOString()
        });
        if (callback && typeof callback === 'function') {
          callback(false);
        }
        return;
      }

      // Validate permission status if provided
      if (data.permissionStatus) {
        const { camera, microphone } = data.permissionStatus;
        if (camera !== 'granted' || microphone !== 'granted') {
          console.log(`🚫 STREAMING: Insufficient permissions - camera: ${camera}, mic: ${microphone}`);
          socket.emit('stream-denied', {
            reason: 'Both camera and microphone permissions must be granted',
            permissionStatus: data.permissionStatus,
            timestamp: new Date().toISOString()
          });
          if (callback && typeof callback === 'function') {
            callback(false);
          }
          return;
        }
      }
      console.log(`✅ STREAMING: Permissions verified for ${socket.id}`);
    }

    // Check if IP is banned before allowing streaming
    const clientIP = IPBanService.getIPFromSocket(socket);
    const isBanned = await IPBanService.isIPBanned(clientIP);

    if (isBanned) {
      console.log(`🚫 STREAMING: Banned IP ${clientIP} attempted to stream`);
      socket.emit('stream-denied', {
        reason: 'Your IP address has been banned from streaming',
        timestamp: new Date().toISOString()
      });
      if (callback && typeof callback === 'function') {
        callback(false);
      }
      return;
    }

    // Send acknowledgment if callback provided
    if (callback && typeof callback === 'function') {
      callback(true);
      console.log(`✅ STREAMING: Sent acknowledgment for request-to-stream`);
    }

    try {
      // Lazy-resolve viewbot services — these are constructed after io wiring
      // in index.js (post-startServer), so they may be null at registration
      // time but populated by the time a real client fires this event.
      const viewbotService = getViewbotService();
      const viewBotClientService = getViewBotClientService();

      // Check if this is a viewbot or real user (already checked above for permissions)
      const isRealUser = !isViewBot;

      // CRITICAL: Check if current streamer is a real user
      const currentStreamer = streamService.getCurrentStreamer();

      // Enhanced ViewBot detection - check both old viewbotService and new ViewBotClientService
      let currentIsViewbot = false;
      if (currentStreamer) {
        // Check old ViewBot system
        const isOldViewBot = viewbotService && viewbotService.isViewbotStream(currentStreamer);

        // Check new ViewBotClientService system - negative user IDs indicate ViewBots
        const userId = sessionService.getUserIdBySocketId(currentStreamer);
        const isNewViewBot = userId && userId < 0;

        currentIsViewbot = isOldViewBot || isNewViewBot;

        console.log(`🔍 VIEWBOT CHECK: Socket ${currentStreamer.substring(0, 12)}...`);
        console.log(`   Old ViewBot: ${isOldViewBot}`);
        console.log(`   New ViewBot: ${isNewViewBot} (userID: ${userId})`);
        console.log(`   Is ViewBot: ${currentIsViewbot}`);
      }

      const currentIsRealUser = currentStreamer && !currentIsViewbot;

      // PRIORITY RULE: Viewbots can NEVER take over from real users
      if (isViewBot && currentIsRealUser) {
        console.log(`🚫 PRIORITY: ViewBot ${socket.id} denied - cannot take over real streamer ${currentStreamer}`);
        socket.emit('takeover-denied', {
          reason: 'Real streamer has priority. ViewBots cannot interrupt real streams.',
          cooldownRemaining: 0
        });
        return;
      }

      // CRITICAL FIX: ViewBots should completely bypass cooldown checks
      // Only check cooldowns for real users
      if (!isViewBot) {
        console.log(`🔍 COOLDOWN: Checking cooldown for real user ${socket.id}`);
        const canTakeOver = await takeoverService.canTakeOver(socket.id);

        if (!canTakeOver.allowed) {
          socket.emit('takeover-denied', {
            reason: canTakeOver.reason,
            cooldownRemaining: canTakeOver.cooldownRemaining
          });
          return;
        }
      } else {
        console.log(`🤖 COOLDOWN: Skipping cooldown check for viewbot ${socket.id} - viewbots bypass all cooldowns`);
      }

      // If real user is taking over, set the realStreamerActive flag
      if (isRealUser && viewBotClientService) {
        console.log(`✅ PRIORITY: Real user ${socket.id} starting stream - protecting from viewbot interruption`);
        viewBotClientService.setRealStreamerStatus(true);
      }

      if (currentStreamer) {
        console.log(`📢 TAKEOVER: Notifying current streamer ${currentStreamer} of takeover by ${socket.id}`);

        // CRITICAL FIX: Comprehensive viewbot detection including LiveKit viewbots
        const isOldViewBot = viewbotService && viewbotService.isViewbotStream(currentStreamer);
        const userId = sessionService.getUserIdBySocketId(currentStreamer);
        const isNewViewBot = userId && userId < 0;
        const isLiveKitViewBot = currentStreamer.startsWith('viewbot-'); // LiveKit viewbots have this prefix
        const currentIsViewbot = isOldViewBot || isNewViewBot || isLiveKitViewBot;

        console.log(`🔍 TAKEOVER: Viewbot detection - old: ${isOldViewBot}, new: ${isNewViewBot}, livekit: ${isLiveKitViewBot}`);

        // Handle viewbot takeover - must stop the viewbot properly
        if (currentIsViewbot) {
          console.log(`🤖 TAKEOVER: Current streamer ${currentStreamer} is a viewbot, stopping it`);

          // Stop OLD viewbot system
          if (isOldViewBot && viewbotService) {
            console.log('🤖 TAKEOVER: Stopping old viewbot service');
            await viewbotService.handleTakeover(socket.id);
          }

          // CRITICAL: Stop LiveKit/SimpleViewBotRotation viewbot
          if (isLiveKitViewBot || isNewViewBot) {
            console.log('🤖 TAKEOVER: Stopping LiveKit viewbot rotation');
            try {
              // Stop via SimpleViewBotRotation (main rotation system)
              if (SimpleViewBotRotation && SimpleViewBotRotation.stopRotation) {
                await SimpleViewBotRotation.stopRotation();
                console.log('✅ TAKEOVER: SimpleViewBotRotation stopped');
              }

              // Also stop via ViewBotClientService if available
              if (viewBotClientService && viewBotClientService.stopViewBotRotation) {
                viewBotClientService.stopViewBotRotation();
                console.log('✅ TAKEOVER: ViewBotClientService rotation stopped');
              }

              // Stop via global viewBotRotation if available
              if (global.viewBotRotation && global.viewBotRotation.stopRotation) {
                await global.viewBotRotation.stopRotation();
                console.log('✅ TAKEOVER: global.viewBotRotation stopped');
              }

              // Stop via unified rotation if available
              if (global.unifiedViewBotRotation && global.unifiedViewBotRotation.stopRotation) {
                await global.unifiedViewBotRotation.stopRotation();
                console.log('✅ TAKEOVER: unifiedViewBotRotation stopped');
              }
            } catch (viewbotStopError) {
              console.error('❌ TAKEOVER: Error stopping viewbot:', viewbotStopError);
            }
          }

          // Set protection for real user taking over from viewbot
          if (isRealUser && viewBotClientService) {
            viewBotClientService.setRealStreamerStatus(true);
            console.log('✅ TAKEOVER: Set real streamer status to protect from viewbot interruption');
          }
        } else {
          // Current streamer is a real user (not a viewbot)
          console.log(`👤 TAKEOVER: Current streamer ${currentStreamer} is a real user`);

          // Set cooldown for real user being taken over
          let cooldownInfo = null;
          console.log(`🔒 TAKEOVER: Setting cooldown for real user ${currentStreamer} being taken over`);
          await takeoverService.setSocketCooldown(currentStreamer, 'stream_taken_over');
          cooldownInfo = await takeoverService.getSocketCooldown(currentStreamer);

          // Emit takeover event with cooldown information and new streamer display name
          const newStreamerDisplayNameForTakeover = await getStreamerDisplayName(socket.id);
          io.to(currentStreamer).emit('stream-takeover', {
            newStreamerId: socket.id,
            newStreamerDisplayName: newStreamerDisplayNameForTakeover,
            cooldownRemaining: cooldownInfo ? cooldownInfo.remaining : takeoverService.getCooldownSeconds()
          });
          console.log(`📢 TAKEOVER: Notified ${currentStreamer} of takeover by ${socket.id} (${newStreamerDisplayNameForTakeover})`);

          // Remove from streamer room but DON'T disconnect the socket
          // The cooldown already prevents them from streaming again
          // Disconnecting the socket causes race conditions with viewer initialization
          const previousStreamerSocket = io.sockets.sockets.get(currentStreamer);
          if (previousStreamerSocket) {
            console.log(`🔌 TAKEOVER: Removing previous streamer ${currentStreamer} from streamer room (keeping socket connected for viewer transition)`);
            previousStreamerSocket.leave('streamer');

            // Send force-disconnect event to signal transition (but don't actually disconnect socket)
            previousStreamerSocket.emit('force-disconnect', {
              reason: 'stream_takeover',
              message: 'Your stream has been taken over by another user',
              shouldReconnect: false
            });
            console.log(`✅ TAKEOVER: Previous streamer ${currentStreamer} notified - socket remains connected for viewer mode`);
          }
        }

        // Emit stream-ended to notify viewers before cleanup, but not to the new streamer
        // Include new streamer's display name so UI can update immediately
        const newStreamerDisplayName = await getStreamerDisplayName(socket.id);
        console.log(`📢 TAKEOVER: Notifying viewers of stream end before cleanup (excluding new streamer ${socket.id}, display: ${newStreamerDisplayName})`);
        // PR 3.1: chokepoint. `excludeSocket: socket` preserves the
        // socket.broadcast.emit semantic (everyone except the new streamer).
        streamNotifier.streamEnded({
          reason: 'takeover',
          excludeSocket: socket,
          previousStreamer: currentStreamer,
          newStreamer: socket.id,
          newStreamerDisplayName,
        });

        // Give viewers time to cleanup their consumers before we close producers
        console.log(`⏳ TAKEOVER: Waiting 200ms for viewer cleanup before producer cleanup`);
        await new Promise(resolve => setTimeout(resolve, 200));

        console.log(`🧹 TAKEOVER: Cleaning up resources for previous streamer ${currentStreamer}`);
        mediasoupService.cleanup(currentStreamer);

        // Clear from notified streamers to allow fresh notifications
        notifiedStreamers.delete(currentStreamer);
      } else {
        // CRITICAL FIX: No current streamer - this is a fresh start (e.g., after server restart)
        console.log(`🚀 STREAMING: No current streamer - ${socket.id} starting fresh stream (isViewBot: ${isViewBot})`);
      }

      streamService.setStreamer(socket.id, data.streamType);
      // CRITICAL FIX: Sync MediasoupService currentStreamer with StreamService immediately
      mediasoupService.currentStreamer = socket.id;

      // Ensure the new streamer is also cleared from notifiedStreamers to allow fresh notifications
      notifiedStreamers.delete(socket.id);
      console.log(`🎯 TAKEOVER: Set ${socket.id} as current streamer in both services, cleared from notified set`);

      // Send StreamBot announcement about the stream takeover or new stream
      if (!isViewBot) {
        try {
          // Get username for the new streamer
          let streamerName = 'Anonymous';
          const userId = sessionService.getUserIdBySocketId(socket.id);

          if (userId && userId > 0) {
            // Real authenticated user
            try {
              const userQuery = `SELECT username FROM users WHERE id = ?`;
              const rows = await database.allAsync(userQuery, [userId]);
              if (rows && rows.length > 0 && rows[0].username) {
                streamerName = rows[0].username;
              }
            } catch (err) {
              console.error('Error fetching username:', err);
            }
          } else {
            // Anonymous user - get chat username from session
            const session = sessionService.getSessionBySocketId(socket.id);
            if (session && session.chatUsername) {
              streamerName = session.chatUsername;
            } else {
              // Fallback to "Anonymous" if no username set yet
              streamerName = 'Anonymous';
            }
          }

          // Determine the appropriate message based on whether this is a takeover or fresh start
          let announcementMessage;
          if (currentStreamer) {
            announcementMessage = `🎬 ${streamerName} took over the stream! They're going live!`;
          } else {
            announcementMessage = `🎬 ${streamerName} is going live!`;
          }

          // Send announcement to chat service
          const chatServiceUrl = process.env.CHAT_SERVICE_URL || 'https://127.0.0.1:8444';

          axios.post(`${chatServiceUrl}/api/system-message`, {
            message: announcementMessage,
            type: currentStreamer ? 'stream_takeover' : 'stream_start'
          }, {
            httpsAgent: new https.Agent({
              rejectUnauthorized: false
            }),
            timeout: 5000
          }).then(response => {
            console.log(`📢 STREAM: Sent StreamBot announcement for ${streamerName}`);
          }).catch(error => {
            console.error('❌ STREAM: Failed to send StreamBot announcement:', error.message);
          });
        } catch (error) {
          console.error('❌ STREAM: Error sending stream announcement:', error);
        }
      }

      // Recording will be handled when stream-ready is emitted (after producers are created)

      // Emit streamer buff updates when user becomes current streamer
      try {
        const streamerBuffs = await buffDebuffService.getActiveBuffsForCurrentStreamer();
        console.log(`🎭 BUFF: Emitting streamer buffs for new streamer ${socket.id}: ${streamerBuffs.length} buffs`);
        io.emit('streamer-buffs-update', { buffs: streamerBuffs });

        // NOTE: Visual effects re-application moved to stream-ready event for better timing
      } catch (error) {
        console.error('❌ BUFF: Error emitting streamer buffs on stream start:', error);
      }

      // Broadcast updated stream status to all viewers so "Current Streamer" updates in real-time
      const updatedStatus = streamService.getStreamStatus();
      updatedStatus.viewerCount = sessionService.getUniqueViewerCount();
      const enrichedStatus = await enrichStreamStatus(updatedStatus);
      io.emit('stream-status', enrichedStatus);
      console.log(`📡 TAKEOVER: Broadcasted updated stream status with streamer: ${enrichedStatus.streamerDisplayName}`);

      // Only record takeover (and trigger global cooldown) for real users, not viewbots
      console.log(`🔍 CRITICAL: Checking if we should record takeover - isViewBot: ${isViewBot}, data: ${JSON.stringify(data)}`);
      if (!isViewBot) {
        console.log(`🔒 TAKEOVER: Recording takeover for real user ${socket.id} - global cooldown will be triggered`);
        await takeoverService.recordTakeover();
      } else {
        console.log(`🤖 TAKEOVER: Viewbot ${socket.id} starting - NOT triggering any cooldown`);
      }

      socket.join('streamer');
      socket.leave('viewers');

      console.log(`✅ STREAMING: Sending streaming-approved to socket ${socket.id} (isViewBot: ${isViewBot})`);
      console.log(`📡 STREAMING: Socket state - connected: ${socket.connected}, transport: ${socket.conn?.transport?.name}`);
      console.log(`📡 STREAMING: Socket rooms:`, Array.from(socket.rooms));

      // CRITICAL: Emit the streaming-approved event with multiple attempts
      socket.emit('streaming-approved');

      // Try volatile emit as well
      socket.volatile.emit('streaming-approved');

      // For ViewBots, also directly call their handler if they have one
      if (isViewBot) {
        console.log(`🔄 STREAMING: Attempting direct ViewBot notification for ${socket.id}`);
        // Send a different event that ViewBots might be listening to
        socket.emit('viewbot-stream-approved', { approved: true });

        // Try with timeout to ensure event is delivered
        setTimeout(() => {
          socket.emit('streaming-approved');
          socket.emit('viewbot-stream-approved', { approved: true });
        }, 100);
      }

      // Also try sending with acknowledgment to verify delivery
      socket.emit('streaming-approved-ack', {}, (ack) => {
        if (ack) {
          console.log(`✅ STREAMING: ViewBot acknowledged streaming-approved`);
        } else {
          console.log(`⚠️ STREAMING: No acknowledgment from ViewBot for streaming-approved`);
        }
      });

      // Track streamer connection in database for IP ban management
      const clientIP = IPBanService.getIPFromSocket(socket);
      const userAgent = socket.handshake.headers['user-agent'] || 'Unknown';
      const streamerName = enrichedStatus.streamerDisplayName || socket.id;

      try {
        await runAsync(`
          INSERT INTO streamer_connections
          (streamer_id, streamer_name, ip_address, connection_type, user_agent)
          VALUES (?, ?, ?, ?, ?)
        `, [socket.id, streamerName, clientIP, 'websocket', userAgent]);
        console.log(`📝 IP TRACKING: Recorded streamer connection for ${streamerName} from IP ${clientIP}`);
      } catch (error) {
        console.error('❌ IP TRACKING: Failed to record streamer connection:', error);
      }

      // Start streaming log session
      const ip = sessionService.getIpAddress(socket);
      const session = sessionService.getSessionByIp(ip);
      const userId = session?.userId || null;

      // Start streaming log session for real streamers
      if (!isViewBot) {
        // CRITICAL: Pause random rotation when a real streamer starts
        // It will auto-restart when the real streamer ends
        if (global.randomStreamRotationService && global.randomStreamRotationService.isEnabled) {
          console.log('⏸️ RANDOM ROTATION: Pausing - real streamer taking over');
          try {
            await global.randomStreamRotationService.pause();
          } catch (err) {
            console.error('❌ RANDOM ROTATION: Failed to pause:', err.message);
          }
        }

        await streamingLogsService.startSession(
          socket.id,
          streamerName,
          userId,
          clientIP,
          userAgent,
          data.streamType || 'standard',
          false // not a viewbot
        );
        console.log(`📝 STREAMING LOGS: Started session for ${streamerName} (${clientIP})`);
      }

      // Start time tracking for streaming session if user is authenticated
      console.log(`📊 TIME DEBUG: request-to-stream approved - IP: ${ip}, session: ${JSON.stringify(session)}`);
      if (session && session.userId) {
        // End any viewing session first
        await timeTrackingService.endViewingSession(session.userId, socket.id);
        // Start streaming session
        timeTrackingService.startStreamingSession(session.userId, socket.id);
        console.log(`📊 TIME: Started streaming time tracking for user ${session.userId}`);
      } else {
        console.log(`📊 TIME DEBUG: No authenticated user found for streaming socket ${socket.id} (IP: ${ip})`);
      }

      // Send stream status to the streamer so they can see duration
      const streamerStatus = streamService.getStreamStatus();
      streamerStatus.viewerCount = sessionService.getUniqueViewerCount();
      // Enrich with streamer display name
      const enrichedStreamerStatus = await enrichStreamStatus(streamerStatus);
      socket.emit('stream-status', enrichedStreamerStatus);

      // For ViewBots, send stream-ready notification immediately since producers are already created
      if (data.isViewBot || data.streamType === 'viewbot') {
        // Track this socket ID as a ViewBot
        viewbotSocketIds.add(socket.id);
        console.log(`🤖 VIEWBOT: Added socket ID ${socket.id} to ViewBot tracking`);

        // Register synthetic negative user ID for viewbot
        // Create a simple hash from socket ID to generate consistent negative user ID
        let hash = 0;
        for (let i = 0; i < socket.id.length; i++) {
          hash = ((hash << 5) - hash) + socket.id.charCodeAt(i);
          hash = hash & hash; // Convert to 32bit integer
        }
        const syntheticUserId = -Math.abs(hash);
        sessionService.linkUserToSocket(socket.id, syntheticUserId);
        console.log(`🎭 VIEWBOT: Registered synthetic user ID ${syntheticUserId} for socket ${socket.id}`);

        // CRITICAL FIX: Update ViewbotService configuration with ViewBot's streamConfig
        if (data.streamConfig && viewbotService) {
          console.log(`🎨 VIEWBOT CONFIG: Updating ViewbotService with config from ${socket.id}:`, data.streamConfig);
          viewbotService.updateViewbotConfig(data.streamConfig);
        }

        // Check if ViewBot has producers ready
        // CRITICAL FIX: ViewBots use GStreamer, not MediaSoup producers
        // Always treat ViewBot producers as ready since they stream via RTP/FFmpeg
        const producerMap = mediasoupService.producers.get(socket.id);
        const hasVideo = data.isViewBot ? true : (producerMap && producerMap.has('video'));
        const hasAudio = data.isViewBot ? true : (producerMap && producerMap.has('audio'));

        // For ViewBots, immediately mark as ready since they handle their own media pipeline
        if ((data.isViewBot || (hasVideo && hasAudio)) && !notifiedStreamers.has(socket.id)) {
          notifiedStreamers.add(socket.id);

          console.log(`🎬 TAKEOVER: ViewBot ${socket.id} ready - notifying viewers immediately (GStreamer mode)`);
          const streamerDisplayName = await getStreamerDisplayName(socket.id);
          const emitTimestamp = Date.now();

          // DEDUP: Check if we already emitted for this stream recently
          if (lastEmittedStreamReady.streamerId === socket.id &&
              (emitTimestamp - lastEmittedStreamReady.timestamp) < 2000) {
            console.log(`⏭️ STREAM-READY: Skipping duplicate ViewBot emission for ${socket.id}`);
          } else {
            io.emit('stream-ready', {
              streamerId: socket.id,
              newStreamId: socket.id,
              isWebRTC: true,
              streamType: 'viewbot',
              isViewBot: true,
              hasVideo: true,  // ViewBots always have video via GStreamer
              hasAudio: true,  // ViewBots always have audio via GStreamer
              producerVerified: true,
              streamStartTime: emitTimestamp,
              timestamp: emitTimestamp,
              streamerDisplayName: streamerDisplayName
            });
            lastEmittedStreamReady.streamerId = socket.id;
            lastEmittedStreamReady.timestamp = emitTimestamp;
            console.log(`📡 STREAM-READY: ViewBot ${socket.id} ready with display name: ${streamerDisplayName}`);
          }

          // Notify existing viewers to start tracking view time
          notifyViewersStreamStarted();
        } else {
          console.log(`📢 TAKEOVER: ViewBot ${socket.id} approved to stream, waiting for producers (video: ${hasVideo}, audio: ${hasAudio})`);
        }
      } else {
        // Note: Regular streamers will be notified via 'stream-ready' event after producers are created and verified
        console.log(`📢 TAKEOVER: ${socket.id} approved to stream, waiting for producers to be created`);
      }

      io.emit('viewer-count-update', sessionService.getUniqueViewerCount());

      // Only broadcast global cooldown for real users, not viewbots
      if (!isViewBot) {
        await broadcastGlobalCooldown(socket.id);
      } else {
        console.log(`🤖 COOLDOWN: Skipping global cooldown broadcast for viewbot ${socket.id}`);
      }

      console.log(`Stream taken over by: ${socket.id}`);
    } catch (error) {
      console.error('Error handling takeover request:', error);
      socket.emit('takeover-error', { message: 'Server error occurred' });
    }
  });

  // Handle streamer sending offer to specific viewer
  socket.on('stream-offer', (data) => {
    const { offer, toViewerId } = data;
    console.log(`Streamer ${socket.id} sending offer to viewer ${toViewerId}`);

    io.to(toViewerId).emit('stream-offer', {
      offer,
      fromStreamerId: socket.id
    });
  });

  // Handle viewer sending answer back to streamer
  socket.on('stream-answer', (data) => {
    const { answer, toStreamerId } = data;
    console.log(`Viewer ${socket.id} sending answer to streamer ${toStreamerId}`);

    io.to(toStreamerId).emit('stream-answer', {
      answer,
      fromViewerId: socket.id
    });
  });

  socket.on('stop-streaming', async () => {
    if (streamService.getCurrentStreamer() === socket.id) {
      // Lazy-resolve viewbot client service — see request-to-stream comment.
      const viewBotClientService = getViewBotClientService();

      // Update streamer connection disconnect time
      try {
        const clientIP = IPBanService.getIPFromSocket(socket);
        const result = await runAsync(`
          UPDATE streamer_connections
          SET disconnected_at = datetime('now'),
              stream_duration = (strftime('%s', 'now') - strftime('%s', connected_at)),
              disconnect_reason = 'voluntary_stop'
          WHERE streamer_id = ? AND disconnected_at IS NULL
        `, [socket.id]);
        console.log(`📝 IP TRACKING: Updated disconnect for streamer ${socket.id}`);
      } catch (error) {
        console.error('❌ IP TRACKING: Failed to update disconnect:', error);
      }

      // End streaming log session
      await streamingLogsService.endSession(socket.id, 'voluntary_stop');

      // End streaming time tracking if user is authenticated
      const ip = sessionService.getIpAddress(socket);
      const session = sessionService.getSessionByIp(ip);
      if (session && session.userId) {
        await timeTrackingService.endStreamingSession(session.userId);
        console.log(`📊 TIME: Ended streaming time tracking for user ${session.userId}`);
      }

      // Apply individual cooldown when streamer voluntarily stops
      await takeoverService.setSocketCooldown(socket.id, 'voluntary_stream_end');
      console.log(`🔒 COOLDOWN: Applied individual cooldown to ${socket.id} for voluntary stream end`);

      streamService.clearStreamer();
      mediasoupService.currentStreamer = null;

      // Handle continuous recording for stream end
      if (recordingService) {
        recordingService.handleStreamEnd(socket.id).catch(error => {
          console.error('❌ RECORDING: Error handling stream end:', error);
        });
      }

      // Clear streamer buff display when streaming ends
      console.log(`🎭 BUFF: Clearing streamer buffs display (streaming ended)`);
      io.emit('streamer-buffs-update', { buffs: [] });
      console.log(`🧹 VOLUNTARY STOP: Cleared ${socket.id} from both services`);

      socket.leave('streamer');
      socket.join('viewers');

      streamNotifier.streamEnded({ reason: 'user_stopped_streaming', previousStreamer: socket.id });
      notifyViewersStreamEnded();
      notifyViewersStreamEnded();
      io.emit('viewer-count-update', sessionService.getUniqueViewerCount());

      console.log(`Stream ended by: ${socket.id}`);

      // CRITICAL: Restart viewbot rotation after real user stops streaming
      // Check if this was a real user (not a viewbot)
      const userId = sessionService.getUserIdBySocketId(socket.id);
      const isViewbot = userId && userId < 0;
      const isLiveKitViewBot = socket.id.startsWith('viewbot-');

      if (!isViewbot && !isLiveKitViewBot && viewBotClientService) {
        console.log(`🔓 VOLUNTARY STOP: Real user ${socket.id} stopped streaming - clearing viewbot protection`);
        viewBotClientService.setRealStreamerStatus(false);

        // Restart viewbot rotation after real user voluntarily stops
        setTimeout(async () => {
          console.log(`🔄 RESTART: Attempting to restart viewbot rotation after voluntary stop`);

          if (global.viewBotRotation && global.viewBotRotation.startRotation) {
            try {
              console.log(`🚀 RESTART: Restarting global.viewBotRotation`);
              await global.viewBotRotation.startRotation();
            } catch (e) {
              console.error(`❌ RESTART: Failed to restart global.viewBotRotation:`, e);
            }
          }

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
    }
  });
};
