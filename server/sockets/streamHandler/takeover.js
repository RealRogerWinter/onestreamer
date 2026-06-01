/**
 * StreamHandler sub-module: takeover / stream start.
 *
 * Registers `request-to-stream` — a client asks to become the active
 * streamer. Performs permission/cooldown/IP-ban gating, stops any current
 * viewbot (or marks real-streamer-active), sets the new streamer, emits
 * stream-ended/streaming-approved, opens logging/time-tracking sessions, and
 * for ViewBots emits stream-ready immediately.
 *
 * Handler body is VERBATIM from the original StreamHandler.js; this is a pure
 * extraction with no logic change. Takes the same `(io, socket, deps)`.
 */
const logger = require('../../bootstrap/logger').child({ svc: 'StreamHandler' });

module.exports = function registerTakeover(io, socket, deps) {
  const {
    streamService,
    sessionService,
    takeoverService,
    mediasoupService,
    timeTrackingService,
    buffDebuffService,
    streamingLogsService,
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
    broadcastGlobalCooldown,
    runAsync,
    database,
    axios,
    https,
    streamNotifier,
    viewerCountNotifier,
    buffNotifier,
  } = deps;

  socket.on('request-to-stream', async (data, callback) => {
    logger.info(`📥 STREAMING: Received request-to-stream from socket ${socket.id} at ${new Date().toISOString()}`);
    logger.info({ data }, `📥 STREAMING: Request data`);
    logger.info({ callbackType: typeof callback }, `📥 STREAMING: Callback type`);
    logger.info({ currentStreamer: streamService.getCurrentStreamer() }, `📥 STREAMING: Current streamer`);
    logger.info({ hasStreamer: !!streamService.getCurrentStreamer() }, `📥 STREAMING: Server state - hasStreamer`);

    // CRITICAL: Check for permission confirmation (new in permission system)
    const isViewBot = data.isViewBot || data.streamType === 'viewbot';
    if (!isViewBot && data.streamType === 'webcam') {
      // For real users streaming from webcam, require permission confirmation
      if (!data.permissionsGranted) {
        logger.info(`🚫 STREAMING: Request denied - no permission confirmation from ${socket.id}`);
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
          logger.info(`🚫 STREAMING: Insufficient permissions - camera: ${camera}, mic: ${microphone}`);
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
      logger.info(`✅ STREAMING: Permissions verified for ${socket.id}`);
    }

    // Check if IP is banned before allowing streaming
    const clientIP = IPBanService.getIPFromSocket(socket);
    const isBanned = await IPBanService.isIPBanned(clientIP);

    if (isBanned) {
      logger.info(`🚫 STREAMING: Banned IP ${clientIP} attempted to stream`);
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
      logger.info(`✅ STREAMING: Sent acknowledgment for request-to-stream`);
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

        logger.info(`🔍 VIEWBOT CHECK: Socket ${currentStreamer.substring(0, 12)}...`);
        logger.info(`   Old ViewBot: ${isOldViewBot}`);
        logger.info(`   New ViewBot: ${isNewViewBot} (userID: ${userId})`);
        logger.info(`   Is ViewBot: ${currentIsViewbot}`);
      }

      const currentIsRealUser = currentStreamer && !currentIsViewbot;

      // PRIORITY RULE: Viewbots can NEVER take over from real users
      if (isViewBot && currentIsRealUser) {
        logger.info(`🚫 PRIORITY: ViewBot ${socket.id} denied - cannot take over real streamer ${currentStreamer}`);
        socket.emit('takeover-denied', {
          reason: 'Real streamer has priority. ViewBots cannot interrupt real streams.',
          cooldownRemaining: 0
        });
        return;
      }

      // CRITICAL FIX: ViewBots should completely bypass cooldown checks
      // Only check cooldowns for real users
      if (!isViewBot) {
        logger.info(`🔍 COOLDOWN: Checking cooldown for real user ${socket.id}`);
        const canTakeOver = await takeoverService.canTakeOver(socket.id);

        if (!canTakeOver.allowed) {
          socket.emit('takeover-denied', {
            reason: canTakeOver.reason,
            cooldownRemaining: canTakeOver.cooldownRemaining
          });
          return;
        }
      } else {
        logger.info(`🤖 COOLDOWN: Skipping cooldown check for viewbot ${socket.id} - viewbots bypass all cooldowns`);
      }

      // If real user is taking over, set the realStreamerActive flag
      if (isRealUser && viewBotClientService) {
        logger.info(`✅ PRIORITY: Real user ${socket.id} starting stream - protecting from viewbot interruption`);
        viewBotClientService.setRealStreamerStatus(true);
      }

      if (currentStreamer) {
        logger.info(`📢 TAKEOVER: Notifying current streamer ${currentStreamer} of takeover by ${socket.id}`);

        // CRITICAL FIX: Comprehensive viewbot detection including LiveKit viewbots
        const isOldViewBot = viewbotService && viewbotService.isViewbotStream(currentStreamer);
        const userId = sessionService.getUserIdBySocketId(currentStreamer);
        const isNewViewBot = userId && userId < 0;
        const isLiveKitViewBot = currentStreamer.startsWith('viewbot-'); // LiveKit viewbots have this prefix
        const currentIsViewbot = isOldViewBot || isNewViewBot || isLiveKitViewBot;

        logger.info(`🔍 TAKEOVER: Viewbot detection - old: ${isOldViewBot}, new: ${isNewViewBot}, livekit: ${isLiveKitViewBot}`);

        // Handle viewbot takeover - must stop the viewbot properly
        if (currentIsViewbot) {
          logger.info(`🤖 TAKEOVER: Current streamer ${currentStreamer} is a viewbot, stopping it`);

          // Stop OLD viewbot system
          if (isOldViewBot && viewbotService) {
            logger.info('🤖 TAKEOVER: Stopping old viewbot service');
            await viewbotService.handleTakeover(socket.id);
          }

          // CRITICAL: Stop LiveKit/SimpleViewBotRotation viewbot
          if (isLiveKitViewBot || isNewViewBot) {
            logger.info('🤖 TAKEOVER: Stopping LiveKit viewbot rotation');
            try {
              // Stop via SimpleViewBotRotation (main rotation system)
              if (SimpleViewBotRotation && SimpleViewBotRotation.stopRotation) {
                await SimpleViewBotRotation.stopRotation();
                logger.info('✅ TAKEOVER: SimpleViewBotRotation stopped');
              }

              // Also stop via ViewBotClientService if available
              if (viewBotClientService && viewBotClientService.stopViewBotRotation) {
                viewBotClientService.stopViewBotRotation();
                logger.info('✅ TAKEOVER: ViewBotClientService rotation stopped');
              }

              // Stop via global viewBotRotation if available
              if (global.viewBotRotation && global.viewBotRotation.stopRotation) {
                await global.viewBotRotation.stopRotation();
                logger.info('✅ TAKEOVER: global.viewBotRotation stopped');
              }

              // Stop via unified rotation if available
              if (global.unifiedViewBotRotation && global.unifiedViewBotRotation.stopRotation) {
                await global.unifiedViewBotRotation.stopRotation();
                logger.info('✅ TAKEOVER: unifiedViewBotRotation stopped');
              }
            } catch (viewbotStopError) {
              logger.error({ err: viewbotStopError }, '❌ TAKEOVER: Error stopping viewbot');
            }
          }

          // Set protection for real user taking over from viewbot
          if (isRealUser && viewBotClientService) {
            viewBotClientService.setRealStreamerStatus(true);
            logger.info('✅ TAKEOVER: Set real streamer status to protect from viewbot interruption');
          }
        } else {
          // Current streamer is a real user (not a viewbot)
          logger.info(`👤 TAKEOVER: Current streamer ${currentStreamer} is a real user`);

          // Set cooldown for real user being taken over
          let cooldownInfo = null;
          logger.info(`🔒 TAKEOVER: Setting cooldown for real user ${currentStreamer} being taken over`);
          await takeoverService.setSocketCooldown(currentStreamer, 'stream_taken_over');
          cooldownInfo = await takeoverService.getSocketCooldown(currentStreamer);

          // Emit takeover event with cooldown information and new streamer display name
          const newStreamerDisplayNameForTakeover = await getStreamerDisplayName(socket.id);
          io.to(currentStreamer).emit('stream-takeover', {
            newStreamerId: socket.id,
            newStreamerDisplayName: newStreamerDisplayNameForTakeover,
            cooldownRemaining: cooldownInfo ? cooldownInfo.remaining : takeoverService.getCooldownSeconds()
          });
          logger.info(`📢 TAKEOVER: Notified ${currentStreamer} of takeover by ${socket.id} (${newStreamerDisplayNameForTakeover})`);

          // Remove from streamer room but DON'T disconnect the socket
          // The cooldown already prevents them from streaming again
          // Disconnecting the socket causes race conditions with viewer initialization
          const previousStreamerSocket = io.sockets.sockets.get(currentStreamer);
          if (previousStreamerSocket) {
            logger.info(`🔌 TAKEOVER: Removing previous streamer ${currentStreamer} from streamer room (keeping socket connected for viewer transition)`);
            previousStreamerSocket.leave('streamer');

            // Send force-disconnect event to signal transition (but don't actually disconnect socket)
            previousStreamerSocket.emit('force-disconnect', {
              reason: 'stream_takeover',
              message: 'Your stream has been taken over by another user',
              shouldReconnect: false
            });
            logger.info(`✅ TAKEOVER: Previous streamer ${currentStreamer} notified - socket remains connected for viewer mode`);
          }
        }

        // Emit stream-ended to notify viewers before cleanup, but not to the new streamer
        // Include new streamer's display name so UI can update immediately
        const newStreamerDisplayName = await getStreamerDisplayName(socket.id);
        logger.info(`📢 TAKEOVER: Notifying viewers of stream end before cleanup (excluding new streamer ${socket.id}, display: ${newStreamerDisplayName})`);
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
        logger.info(`⏳ TAKEOVER: Waiting 200ms for viewer cleanup before producer cleanup`);
        await new Promise(resolve => setTimeout(resolve, 200));

        logger.info(`🧹 TAKEOVER: Cleaning up resources for previous streamer ${currentStreamer}`);
        mediasoupService.cleanup(currentStreamer);

        // Clear from notified streamers to allow fresh notifications
        notifiedStreamers.delete(currentStreamer);
      } else {
        // CRITICAL FIX: No current streamer - this is a fresh start (e.g., after server restart)
        logger.info(`🚀 STREAMING: No current streamer - ${socket.id} starting fresh stream (isViewBot: ${isViewBot})`);
      }

      streamService.setStreamer(socket.id, data.streamType);
      // CRITICAL FIX: Sync MediasoupService currentStreamer with StreamService immediately
      mediasoupService.currentStreamer = socket.id;

      // Ensure the new streamer is also cleared from notifiedStreamers to allow fresh notifications
      notifiedStreamers.delete(socket.id);
      logger.info(`🎯 TAKEOVER: Set ${socket.id} as current streamer in both services, cleared from notified set`);

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
              logger.error({ err }, 'Error fetching username');
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
            logger.info(`📢 STREAM: Sent StreamBot announcement for ${streamerName}`);
          }).catch(error => {
            logger.error({ err: error }, '❌ STREAM: Failed to send StreamBot announcement');
          });
        } catch (error) {
          logger.error({ err: error }, '❌ STREAM: Error sending stream announcement');
        }
      }

      // Recording will be handled when stream-ready is emitted (after producers are created)

      // Emit streamer buff updates when user becomes current streamer
      try {
        const streamerBuffs = await buffDebuffService.getActiveBuffsForCurrentStreamer();
        logger.info(`🎭 BUFF: Emitting streamer buffs for new streamer ${socket.id}: ${streamerBuffs.length} buffs`);
        buffNotifier.streamerBuffsUpdate({ buffs: streamerBuffs });

        // NOTE: Visual effects re-application moved to stream-ready event for better timing
      } catch (error) {
        logger.error({ err: error }, '❌ BUFF: Error emitting streamer buffs on stream start');
      }

      // Broadcast updated stream status to all viewers so "Current Streamer" updates in real-time
      const updatedStatus = streamService.getStreamStatus();
      updatedStatus.viewerCount = sessionService.getUniqueViewerCount();
      const enrichedStatus = await enrichStreamStatus(updatedStatus);
      io.emit('stream-status', enrichedStatus);
      logger.info(`📡 TAKEOVER: Broadcasted updated stream status with streamer: ${enrichedStatus.streamerDisplayName}`);

      // Only record takeover (and trigger global cooldown) for real users, not viewbots
      logger.info(`🔍 CRITICAL: Checking if we should record takeover - isViewBot: ${isViewBot}, data: ${JSON.stringify(data)}`);
      if (!isViewBot) {
        logger.info(`🔒 TAKEOVER: Recording takeover for real user ${socket.id} - global cooldown will be triggered`);
        await takeoverService.recordTakeover();
      } else {
        logger.info(`🤖 TAKEOVER: Viewbot ${socket.id} starting - NOT triggering any cooldown`);
      }

      socket.join('streamer');
      socket.leave('viewers');

      logger.info(`✅ STREAMING: Sending streaming-approved to socket ${socket.id} (isViewBot: ${isViewBot})`);
      logger.info(`📡 STREAMING: Socket state - connected: ${socket.connected}, transport: ${socket.conn?.transport?.name}`);
      logger.info({ rooms: Array.from(socket.rooms) }, `📡 STREAMING: Socket rooms`);

      // CRITICAL: Emit the streaming-approved event with multiple attempts
      socket.emit('streaming-approved');

      // Try volatile emit as well
      socket.volatile.emit('streaming-approved');

      // For ViewBots, also directly call their handler if they have one
      if (isViewBot) {
        logger.info(`🔄 STREAMING: Attempting direct ViewBot notification for ${socket.id}`);
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
          logger.info(`✅ STREAMING: ViewBot acknowledged streaming-approved`);
        } else {
          logger.info(`⚠️ STREAMING: No acknowledgment from ViewBot for streaming-approved`);
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
        logger.info(`📝 IP TRACKING: Recorded streamer connection for ${streamerName} from IP ${clientIP}`);
      } catch (error) {
        logger.error({ err: error }, '❌ IP TRACKING: Failed to record streamer connection');
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
          logger.info('⏸️ RANDOM ROTATION: Pausing - real streamer taking over');
          try {
            await global.randomStreamRotationService.pause();
          } catch (err) {
            logger.error({ err }, '❌ RANDOM ROTATION: Failed to pause');
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
        logger.info(`📝 STREAMING LOGS: Started session for ${streamerName} (${clientIP})`);
      }

      // Start time tracking for streaming session if user is authenticated
      logger.info(`📊 TIME DEBUG: request-to-stream approved - IP: ${ip}, session: ${JSON.stringify(session)}`);
      if (session && session.userId) {
        // End any viewing session first
        await timeTrackingService.endViewingSession(session.userId, socket.id);
        // Start streaming session
        timeTrackingService.startStreamingSession(session.userId, socket.id);
        logger.info(`📊 TIME: Started streaming time tracking for user ${session.userId}`);
      } else {
        logger.info(`📊 TIME DEBUG: No authenticated user found for streaming socket ${socket.id} (IP: ${ip})`);
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
        logger.info(`🤖 VIEWBOT: Added socket ID ${socket.id} to ViewBot tracking`);

        // Register synthetic negative user ID for viewbot
        // Create a simple hash from socket ID to generate consistent negative user ID
        let hash = 0;
        for (let i = 0; i < socket.id.length; i++) {
          hash = ((hash << 5) - hash) + socket.id.charCodeAt(i);
          hash = hash & hash; // Convert to 32bit integer
        }
        const syntheticUserId = -Math.abs(hash);
        sessionService.linkUserToSocket(socket.id, syntheticUserId);
        logger.info(`🎭 VIEWBOT: Registered synthetic user ID ${syntheticUserId} for socket ${socket.id}`);

        // CRITICAL FIX: Update ViewbotService configuration with ViewBot's streamConfig
        if (data.streamConfig && viewbotService) {
          logger.info({ streamConfig: data.streamConfig }, `🎨 VIEWBOT CONFIG: Updating ViewbotService with config from ${socket.id}`);
          viewbotService.updateViewbotConfig(data.streamConfig);
        }

        // Check if ViewBot has producers ready
        // CRITICAL FIX: ViewBots stream via LiveKit/ffmpeg, not MediaSoup producers
        // Always treat ViewBot producers as ready since they stream via RTP/FFmpeg
        const producerMap = mediasoupService.producers.get(socket.id);
        const hasVideo = data.isViewBot ? true : (producerMap && producerMap.has('video'));
        const hasAudio = data.isViewBot ? true : (producerMap && producerMap.has('audio'));

        // For ViewBots, immediately mark as ready since they handle their own media pipeline
        if ((data.isViewBot || (hasVideo && hasAudio)) && !notifiedStreamers.has(socket.id)) {
          notifiedStreamers.add(socket.id);

          logger.info(`🎬 TAKEOVER: ViewBot ${socket.id} ready - notifying viewers immediately (LiveKit mode)`);
          const streamerDisplayName = await getStreamerDisplayName(socket.id);
          const emitTimestamp = Date.now();

          // DEDUP: Check if we already emitted for this stream recently
          if (lastEmittedStreamReady.streamerId === socket.id &&
              (emitTimestamp - lastEmittedStreamReady.timestamp) < 2000) {
            logger.info(`⏭️ STREAM-READY: Skipping duplicate ViewBot emission for ${socket.id}`);
          } else {
            io.emit('stream-ready', {
              streamerId: socket.id,
              newStreamId: socket.id,
              isWebRTC: true,
              streamType: 'viewbot',
              isViewBot: true,
              hasVideo: true,  // ViewBots always have video via LiveKit
              hasAudio: true,  // ViewBots always have audio via LiveKit
              producerVerified: true,
              streamStartTime: emitTimestamp,
              timestamp: emitTimestamp,
              streamerDisplayName: streamerDisplayName
            });
            lastEmittedStreamReady.streamerId = socket.id;
            lastEmittedStreamReady.timestamp = emitTimestamp;
            logger.info(`📡 STREAM-READY: ViewBot ${socket.id} ready with display name: ${streamerDisplayName}`);
          }

          // Notify existing viewers to start tracking view time
          notifyViewersStreamStarted();
        } else {
          logger.info(`📢 TAKEOVER: ViewBot ${socket.id} approved to stream, waiting for producers (video: ${hasVideo}, audio: ${hasAudio})`);
        }
      } else {
        // Note: Regular streamers will be notified via 'stream-ready' event after producers are created and verified
        logger.info(`📢 TAKEOVER: ${socket.id} approved to stream, waiting for producers to be created`);
      }

      viewerCountNotifier.broadcast();

      // Only broadcast global cooldown for real users, not viewbots
      if (!isViewBot) {
        await broadcastGlobalCooldown(socket.id);
      } else {
        logger.info(`🤖 COOLDOWN: Skipping global cooldown broadcast for viewbot ${socket.id}`);
      }

      logger.info(`Stream taken over by: ${socket.id}`);
    } catch (error) {
      logger.error({ err: error }, 'Error handling takeover request');
      socket.emit('takeover-error', { message: 'Server error occurred' });
    }
  });
};
