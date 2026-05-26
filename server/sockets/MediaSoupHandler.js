/**
 * MediaSoupHandler
 *
 * Registers MediaSoup WebRTC SFU signalling events on a per-connection basis.
 * Continuation of PR-H's socket-extraction pattern (see AdminHandler,
 * EffectHandler, GameHandler, StreamHandler).
 *
 * Handlers (all logic byte-equivalent to the original inline versions):
 *   - mediasoup:get-rtp-capabilities     Send router RTP capabilities to caller.
 *                                        Used by ViewBots and regular clients
 *                                        during device load.
 *   - mediasoup:create-send-transport    Create a WebRtcTransport for the
 *                                        caller's send direction and return its
 *                                        params for client-side construction.
 *   - mediasoup:connect-transport        Finish DTLS handshake for the send
 *                                        transport created above.
 *   - mediasoup:produce                  Create a producer for an incoming
 *                                        audio/video track. Includes the
 *                                        existing real-user-vs-viewbot priority
 *                                        gating, fresh-streamer registration in
 *                                        StreamService, fallback stream-ready
 *                                        emission (with the 250ms + 4s
 *                                        timeouts intact), auto-start of
 *                                        recording/transcription, view-time
 *                                        tracking kickoff, and the global
 *                                        cooldown broadcast.
 *   - mediasoup:consume                  Create a consumer for the requesting
 *                                        viewer against the current streamer's
 *                                        producer of the requested kind, with
 *                                        the existing producer-presence checks.
 *   - mediasoup:resume-consumer          Resume a paused consumer.
 *   - mediasoup:request-keyframe         Request a keyframe (used by iOS
 *                                        clients to recover from decoder
 *                                        stalls).
 *   - ice-candidate                      Generic ICE candidate signalling
 *                                        pass-through. Handles direct-target,
 *                                        streamer-to-viewers fan-out, and
 *                                        viewer-to-streamer relay. Bundled here
 *                                        because it pairs with MediaSoup WebRTC
 *                                        transport setup and the legacy P2P
 *                                        signalling that depends on it.
 *
 * `deps` (all required unless noted):
 *   - mediasoupService            The MediaSoup SFU wrapper (router,
 *                                 producers, consumers).
 *   - streamService               Current-streamer registry.
 *   - sessionService              Socket/IP -> session + user-id mapping.
 *   - takeoverService             Unused directly today, reserved for parity
 *                                 with neighbouring handlers — NOT injected.
 *   - notifiedStreamers           Shared Set<string> of socket IDs the server
 *                                 has already emitted stream-ready for. MUST
 *                                 be mutated in place.
 *   - lastEmittedStreamReady      Shared mutable { streamerId, timestamp } for
 *                                 stream-ready dedup, also mutated by
 *                                 verifyAndEmitStreamReady.
 *   - verifyAndEmitStreamReady    Helper from index.js: verifies tracks (LiveKit
 *                                 path) and emits stream-ready.
 *   - getStreamerDisplayName      Helper from index.js: socketId -> display
 *                                 name.
 *   - notifyViewersStreamStarted  Helper from index.js: kicks off
 *                                 viewer-side view-time tracking.
 *   - broadcastGlobalCooldown     Helper from index.js: cooldown fanout.
 *   - getRecordingService         () => recordingService. Lazy because
 *                                 continuous-recording orchestration is
 *                                 conditionally initialised; matches the
 *                                 inline check `if (recordingService)`.
 *   - getTranscriptionService     () => transcriptionService. Lazy for the
 *                                 same reason (auto-start path).
 */
module.exports = function registerMediaSoupHandler(io, socket, deps) {
  const {
    mediasoupService,
    streamService,
    sessionService,
    notifiedStreamers,
    lastEmittedStreamReady, // eslint-disable-line no-unused-vars
    verifyAndEmitStreamReady,
    getStreamerDisplayName,
    notifyViewersStreamStarted,
    broadcastGlobalCooldown,
    getRecordingService,
    getTranscriptionService,
    // PR 3.2: viewer-count-update chokepoint.
    viewerCountNotifier,
  } = deps;

  // Handle ICE candidates between peers
  socket.on('ice-candidate', (data) => {
    const { candidate, toSocketId, fromSocketId } = data;

    if (toSocketId && toSocketId !== 'viewers') {
      // Send to specific socket
      io.to(toSocketId).emit('ice-candidate', {
        candidate,
        fromSocketId: socket.id
      });
    } else {
      // Broadcast to appropriate room
      const currentStreamer = streamService.getCurrentStreamer();
      if (socket.id === currentStreamer) {
        // Streamer sending to all viewers
        socket.to('viewers').emit('ice-candidate', {
          candidate,
          fromSocketId: socket.id
        });
      } else {
        // Viewer sending to streamer
        if (currentStreamer) {
          io.to(currentStreamer).emit('ice-candidate', {
            candidate,
            fromSocketId: socket.id
          });
        }
      }
    }
  });

  // Mediasoup WebRTC events
  // Handle MediaSoup RTP capabilities request (for ViewBots and regular clients)
  socket.on('mediasoup:get-rtp-capabilities', async (data, callback) => {
    try {
      const rtpCapabilities = await mediasoupService.getRouterRtpCapabilities();
      console.log(`📊 MEDIASOUP: Sent RTP capabilities to ${socket.id}`);
      callback({ success: true, rtpCapabilities });
    } catch (error) {
      console.error(`❌ MEDIASOUP: Failed to get RTP capabilities for ${socket.id}:`, error);
      callback({ success: false, error: error.message });
    }
  });

  // Handle MediaSoup send transport creation (for ViewBots and regular clients)
  socket.on('mediasoup:create-send-transport', async (data, callback) => {
    try {
      const transport = await mediasoupService.createWebRtcTransport(socket.id);
      console.log(`📡 MEDIASOUP: Send transport created for ${socket.id}`);
      callback({ success: true, ...transport });
    } catch (error) {
      console.error(`❌ MEDIASOUP: Failed to create send transport for ${socket.id}:`, error);
      callback({ success: false, error: error.message });
    }
  });

  // Handle MediaSoup transport connection (for ViewBots and regular clients)
  socket.on('mediasoup:connect-transport', async (data, callback) => {
    try {
      const { dtlsParameters, transportId } = data;

      // All clients including viewbots use the same connection flow
      await mediasoupService.connectTransport(socket.id, dtlsParameters);
      console.log(`🔗 MEDIASOUP: Transport connected for ${socket.id}`);
      callback({ success: true });
    } catch (error) {
      console.error(`❌ MEDIASOUP: Failed to connect transport for ${socket.id}:`, error);
      callback({ success: false, error: error.message });
    }
  });

  socket.on('mediasoup:produce', async (data, callback) => {
    try {
      const { kind, rtpParameters, transportId } = data;

      // Get user info for debugging
      const session = sessionService.getSessionBySocketId(socket.id);
      const username = session?.username || 'unknown';
      const userAgent = socket.handshake?.headers?.['user-agent'] || 'unknown';
      const ip = socket.handshake?.address || 'unknown';

      console.log(`🎬 MEDIASOUP PRODUCE: Request from ${username} (${socket.id})`);
      console.log(`📱 User Agent: ${userAgent}`);
      console.log(`🌐 IP: ${ip}`);
      console.log(`🎥 Track kind: ${kind}, Transport ID: ${transportId}`);

      // Check if there's already an active streamer
      const currentStreamer = streamService.getCurrentStreamer();
      const wasNewStreamer = currentStreamer !== socket.id;

      // Check if current user is a real user (positive user ID or no session)
      const isRealUser = !session?.userId || session.userId > 0;

      // Check if current streamer is a viewbot (negative user ID)
      let currentStreamerIsViewbot = false;
      if (currentStreamer) {
        const currentStreamerSession = sessionService.getSessionBySocketId(currentStreamer);
        currentStreamerIsViewbot = currentStreamerSession?.userId && currentStreamerSession.userId < 0;
      }

      // Allow real users to override viewbots, but prevent viewbots from overriding real users
      if (currentStreamer && wasNewStreamer) {
        if (isRealUser && currentStreamerIsViewbot) {
          console.log(`✅ MEDIASOUP: Real user ${socket.id} (${username}) overriding viewbot streamer ${currentStreamer}`);
          // Clear the viewbot streamer
          streamService.clearStreamer();
          mediasoupService.currentStreamer = null;
        } else if (!isRealUser && !currentStreamerIsViewbot) {
          console.log(`⚠️ MEDIASOUP: Blocking viewbot ${socket.id} - real user ${currentStreamer} is streaming`);
          callback({
            success: false,
            error: 'A real user is currently streaming.'
          });
          return;
        } else if (!isRealUser && currentStreamerIsViewbot) {
          console.log(`⚠️ MEDIASOUP: Blocking viewbot ${socket.id} - another viewbot ${currentStreamer} is streaming`);
          callback({
            success: false,
            error: 'Another viewbot is currently streaming.'
          });
          return;
        } else {
          console.log(`⚠️ MEDIASOUP: Blocking produce attempt from ${socket.id} - active streamer is ${currentStreamer}`);
          callback({
            success: false,
            error: 'Another user is currently streaming. Please request takeover first.'
          });
          return;
        }
      }

      console.log(`🔍 MEDIASOUP: Before producer creation - current streamer: ${currentStreamer}, this socket: ${socket.id}, wasNewStreamer: ${wasNewStreamer}`);

      // ViewBots now use the same producer creation as regular users
      const result = await mediasoupService.createProducer(socket.id, rtpParameters, kind);
      console.log(`✅ Producer created: ${result.id} for ${username} (${kind})`)

      // Only update stream service if this is the first producer or the current streamer
      if (!currentStreamer || socket.id === currentStreamer) {
        streamService.setStreamer(socket.id, 'webrtc');
        socket.join('streamer');
        socket.leave('viewers');
      }

      // Enhanced producer readiness checking with better race condition handling
      const producerMap = mediasoupService.producers.get(socket.id);
      const hasVideo = producerMap && producerMap.has('video');
      const hasAudio = producerMap && producerMap.has('audio');
      const hasBothTracks = hasVideo && hasAudio;

      console.log(`🎬 MEDIASOUP: Producer created - streamer: ${socket.id}, kind: ${kind}, wasNewStreamer: ${wasNewStreamer}, notified: ${notifiedStreamers.has(socket.id)}`);

      // console.log(`🔍 MEDIASOUP DEBUG: Checking notification conditions for ${socket.id}:`);
      // console.log(`🔍   wasNewStreamer: ${wasNewStreamer}`);
      // console.log(`🔍   notifiedStreamers.has(${socket.id}): ${notifiedStreamers.has(socket.id)}`);
      // console.log(`🔍   Current streamer: ${mediasoupService.getCurrentStreamer()}`);
      // console.log(`🔍   notifiedStreamers Set:`, Array.from(notifiedStreamers));

      // Notify viewers if this is a new streamer OR if we haven't notified about this streamer yet
      // This handles both fresh streams and takeover scenarios where the streamer changes
      if ((wasNewStreamer || !notifiedStreamers.has(socket.id)) && mediasoupService.getCurrentStreamer() === socket.id) {
        console.log(`🎬 MEDIASOUP: Processing new streamer ${socket.id} with ${kind} track (video: ${hasVideo}, audio: ${hasAudio})`);

        // Emit stream-ready for any functional producers (don't wait for both tracks)
        let emitReady = false;
        let readyHasVideo = false;
        let readyHasAudio = false;

        if (hasVideo) {
          const videoProducer = producerMap.get('video');
          if (videoProducer && !videoProducer.closed) {
            readyHasVideo = true;
            emitReady = true;
          }
        }

        if (hasAudio) {
          const audioProducer = producerMap.get('audio');
          if (audioProducer && !audioProducer.closed) {
            readyHasAudio = true;
            emitReady = true;
          }
        }

        if (emitReady) {
          console.log(`✅ MEDIASOUP: Producer(s) verified for ${socket.id} (video: ${readyHasVideo}, audio: ${readyHasAudio}), notifying viewers`);

          // Immediately mark as notified to prevent race conditions between video/audio producers
          if (!notifiedStreamers.has(socket.id)) {
            notifiedStreamers.add(socket.id);

            // Add a small delay to ensure MediaSoup internal state is consistent
            setTimeout(async () => {
              // Double-check that we're still the current streamer
              if (mediasoupService.getCurrentStreamer() === socket.id) {
                const streamerDisplayName = await getStreamerDisplayName(socket.id);

                // Emit producer-verified event for clients waiting specifically for producer readiness
                io.emit('producer-verified', {
                  streamerId: socket.id,
                  hasVideo: readyHasVideo,
                  hasAudio: readyHasAudio,
                  timestamp: Date.now()
                });
                console.log(`✅ MEDIASOUP: Producer verified for ${socket.id} (video: ${readyHasVideo}, audio: ${readyHasAudio})`);

                // Use verified emission helper for LiveKit backend track verification
                await verifyAndEmitStreamReady(socket.id, {
                  streamType: 'webrtc',
                  hasVideo: readyHasVideo,
                  hasAudio: readyHasAudio,
                  streamStartTime: streamService.streamStartTime
                });
                console.log(`📡 STREAM-READY: Regular streamer ${socket.id} ready emission completed`);

              // Visual effects sync temporarily disabled to debug rotate_90 issue
              // try {
              //   const activeVisualEffects = await getActiveVisualEffects();
              //   if (activeVisualEffects.length > 0) {
              //     console.log(`🎨 VISUAL FX: Broadcasting ${activeVisualEffects.length} active effects with stream-ready`);
              //
              //     // Broadcast visual effects state to all clients
              //     io.emit('visual-effects-state', {
              //       effects: activeVisualEffects.map(buff => ({
              //         effectId: buff.item_name,
              //         itemName: buff.item_name,
              //         displayName: buff.display_name,
              //         remainingSeconds: buff.remaining_seconds,
              //         effectData: buff.effect_data
              //       })),
              //       streamId: socket.id
              //     });
              //   }
              // } catch (error) {
              //   console.error('❌ VISUAL FX: Error broadcasting effects with stream-ready:', error);
              // }

              // Handle continuous recording now that producers are ready
              const recordingService = getRecordingService();
              if (recordingService) {
                recordingService.handleStreamStart(socket.id).catch(error => {
                  console.error('❌ RECORDING: Error handling stream start:', error);
                });
              }

              // Handle auto-start transcription if enabled
              const transcriptionService = getTranscriptionService();
              if (transcriptionService &&
                  transcriptionService.config.enableTranscription &&
                  transcriptionService.config.autoStart) {
                console.log('🎙️ AUTO-START: Starting transcription automatically for stream');
                transcriptionService.startTranscription(socket.id).then(result => {
                  if (result.success) {
                    console.log(`✅ AUTO-START: Transcription started: ${result.sessionId}`);
                    io.emit('transcription-started', {
                      sessionId: result.sessionId,
                      streamerId: socket.id,
                      startTime: result.startTime,
                      autoStarted: true
                    });
                  } else {
                    console.error(`❌ AUTO-START: Failed to start transcription: ${result.error}`);
                  }
                }).catch(error => {
                  console.error('❌ AUTO-START: Error starting transcription:', error);
                });
              }

              viewerCountNotifier.broadcast();

              // Start view time tracking for existing viewers
              notifyViewersStreamStarted();

              await broadcastGlobalCooldown(socket.id);
            }
          }, 250); // Small delay for MediaSoup stability
          }
        } else {
          console.log(`⚠️ MEDIASOUP: ${socket.id} already notified or not ready to emit (video: ${readyHasVideo}, audio: ${readyHasAudio})`);
        }

        // Always set up fallback notification for reliability
        setTimeout(async () => {
          if (mediasoupService.getCurrentStreamer() === socket.id && !notifiedStreamers.has(socket.id)) {
            const currentProducerMap = mediasoupService.producers.get(socket.id);
            const currentHasVideo = currentProducerMap && currentProducerMap.has('video') && !currentProducerMap.get('video')?.closed;
            const currentHasAudio = currentProducerMap && currentProducerMap.has('audio') && !currentProducerMap.get('audio')?.closed;

            console.log(`🎬 MEDIASOUP: Fallback notification for ${socket.id} (video: ${currentHasVideo}, audio: ${currentHasAudio})`);
            notifiedStreamers.add(socket.id);

            // Use verified emission helper for LiveKit backend track verification
            await verifyAndEmitStreamReady(socket.id, {
              streamType: 'webrtc',
              hasVideo: currentHasVideo,
              hasAudio: currentHasAudio,
              streamStartTime: streamService.streamStartTime
            });
            viewerCountNotifier.broadcast();

            // Start view time tracking for existing viewers
            notifyViewersStreamStarted();

            await broadcastGlobalCooldown(socket.id);
          }
        }, 4000); // Extended timeout for better reliability
      } else {
        console.log(`🎬 MEDIASOUP: Existing streamer ${socket.id} producing additional ${kind} track`);
      }

      callback({ success: true, producerId: result.id });
      console.log(`🎬 MEDIASOUP: ${socket.id} started producing ${kind}`);
    } catch (error) {
      console.error('❌ MEDIASOUP: Failed to create producer:', error);
      callback({ success: false, error: error.message });
    }
  });

  socket.on('mediasoup:consume', async (data, callback) => {
    try {
      const { rtpCapabilities, kind } = data;
      const currentStreamer = mediasoupService.getCurrentStreamer();

      // console.log(`📺 MEDIASOUP: ${socket.id} requesting to consume ${kind || 'any'} from streamer ${currentStreamer}`);
      // console.log(`🔍 MEDIASOUP DEBUG: StreamService current streamer: ${streamService.getCurrentStreamer()}`);
      // console.log(`🔍 MEDIASOUP DEBUG: MediasoupService current streamer: ${mediasoupService.getCurrentStreamer()}`);

      if (!currentStreamer) {
        // console.log(`❌ MEDIASOUP: ${socket.id} tried to consume but no active streamer`);
        callback({ success: false, error: 'No active streamer available' });
        return;
      }

      // Verify producer exists and is functional before attempting consumption
      const producerMap = mediasoupService.producers.get(currentStreamer);
      if (!producerMap || producerMap.size === 0) {
        console.log(`⚠️ MEDIASOUP: ${socket.id} tried to consume from ${currentStreamer} but no producers found yet`);
        console.log(`📺 MEDIASOUP: Streamer ${currentStreamer} is registered but may still be setting up media stream`);
        callback({ success: false, error: `Streamer ${currentStreamer} is preparing stream - please wait` });
        return;
      }

      // If specific kind requested, check if that producer exists and is functional
      if (kind) {
        const specificProducer = producerMap.get(kind);
        if (!specificProducer || specificProducer.closed) {
          console.log(`❌ MEDIASOUP: ${socket.id} requested ${kind} from ${currentStreamer} but producer not available or closed`);
          callback({ success: false, error: `No ${kind} producer available from streamer ${currentStreamer}` });
          return;
        }
      }

      console.log(`📺 MEDIASOUP: ${socket.id} attempting to consume ${kind || 'any'} from ${currentStreamer} (producers: ${producerMap.size})`);

      const result = await mediasoupService.createConsumer(
        socket.id,
        currentStreamer,
        rtpCapabilities,
        kind // Pass the requested track kind
      );

      if (result) {
        // Check if the producer is a viewbot (Plain RTP)
        const isViewbotProducer = currentStreamer.includes('viewbot') ||
                                 currentStreamer.includes('bot-') ||
                                 // Check producer metadata
                                 producerMap?.values()?.next()?.value?.appData?.isViewBot;

        callback({
          success: true,
          consumer: result,
          streamerId: currentStreamer,
          isViewbotStream: isViewbotProducer
        });
        console.log(`✅ MEDIASOUP: ${socket.id} successfully consuming ${kind || 'media'} from ${currentStreamer} (viewbot: ${isViewbotProducer})`);
      } else {
        callback({ success: false, error: `Cannot create consumer for ${kind || 'media'}` });
      }
    } catch (error) {
      console.error('❌ MEDIASOUP: Failed to create consumer:', error);
      callback({ success: false, error: error.message });
    }
  });

  socket.on('mediasoup:resume-consumer', async (data, callback) => {
    try {
      const { consumerId } = data;
      await mediasoupService.resumeConsumer(socket.id, consumerId);
      callback({ success: true });
      console.log(`▶️ MEDIASOUP: ${socket.id} resumed consumer ${consumerId}`);
    } catch (error) {
      console.error('❌ MEDIASOUP: Failed to resume consumer:', error);
      callback({ success: false, error: error.message });
    }
  });

  // Handle keyframe requests for iOS video decoder issues
  socket.on('mediasoup:request-keyframe', async (data, callback) => {
    try {
      const { consumerId } = data;
      const consumer = mediasoupService.getConsumer(socket.id, consumerId);

      if (!consumer) {
        throw new Error('Consumer not found');
      }

      // Request keyframe from the producer
      if (consumer.kind === 'video') {
        console.log(`📱 iOS: Requesting keyframe for consumer ${consumerId}`);
        await consumer.requestKeyFrame();
      }

      callback({ success: true });
    } catch (error) {
      console.error('❌ MEDIASOUP: Failed to request keyframe:', error);
      callback({ success: false, error: error.message });
    }
  });
};
