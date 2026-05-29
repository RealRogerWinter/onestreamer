const { usernameFromStreamUrl } = require('./streamUrlUsername');

const logger = require('../../bootstrap/logger').child({ svc: 'RoomParticipantInspector' });

/**
 * RoomParticipantInspector - LiveKit-room-facing collaborator for
 * ContinuousRecordingService. Classifies participants (viewbot / URL relay /
 * real streamer) and resolves the current active stream's display metadata.
 * Extracted verbatim from ContinuousRecordingService; behavior unchanged.
 *
 * @param {Object} deps
 * @param {Object} deps.roomServiceClient - LiveKit RoomServiceClient.
 * @param {string} deps.roomName - Room to inspect.
 * @param {Object} deps.userRepository - UserRepository.
 * @param {Function} deps.getAsync - SQLite get helper (cross-table reads).
 */
class RoomParticipantInspector {
  constructor({ roomServiceClient, roomName, userRepository, getAsync }) {
    this.roomServiceClient = roomServiceClient;
    this.roomName = roomName;
    this.userRepository = userRepository;
    this.getAsync = getAsync;
  }

  /**
   * Predicate: participant is publishing an unmuted video track (type 1 = VIDEO).
   */
  _hasVideo(participant) {
    return !!(participant.tracks && participant.tracks.some(t => t.type === 1 && !t.muted));
  }

  /**
   * Check if a participant is a viewbot (not a real streamer)
   */
  isViewbot(participant) {
    const identity = participant.identity || '';

    // Check identity patterns
    if (identity.startsWith('viewbot-') ||
        identity.includes('viewbot') ||
        identity.startsWith('bot-')) {
      return true;
    }

    // Check metadata
    try {
      const metadata = JSON.parse(participant.metadata || '{}');
      if (metadata.type === 'viewbot') {
        return true;
      }
    } catch (e) {
      // Ignore parse errors
    }

    return false;
  }

  /**
   * Check if a participant is a URL stream relay (not a real person streaming)
   */
  isUrlStreamRelay(participant) {
    const identity = participant.identity || '';
    return identity.startsWith('url-stream-');
  }

  /**
   * Find the real (non-viewbot, non-URL-stream) streamer with video tracks
   * Returns the participant identity if found, null otherwise
   */
  async findRealStreamer() {
    try {
      const participants = await this.roomServiceClient.listParticipants(this.roomName);

      // Find participants with video tracks who are NOT viewbots and NOT URL stream relays
      const realStreamers = participants.filter(p => {
        return this._hasVideo(p) && !this.isViewbot(p) && !this.isUrlStreamRelay(p);
      });

      if (realStreamers.length > 0) {
        // Return the first real streamer found
        const streamer = realStreamers[0];
        logger.debug(`🎯 CONTINUOUS RECORDING: Found real streamer: ${streamer.identity}`);
        return streamer.identity;
      }

      return null;
    } catch (error) {
      logger.error('❌ CONTINUOUS RECORDING: Error finding real streamer:', error.message);
      return null;
    }
  }

  /**
   * Find any URL stream relay that is publishing video
   * Returns the participant identity if found, null otherwise
   */
  async findUrlStreamPublisher() {
    try {
      const participants = await this.roomServiceClient.listParticipants(this.roomName);

      // Find URL stream relays with video tracks
      const urlStreamers = participants.filter(p => {
        return this._hasVideo(p) && this.isUrlStreamRelay(p);
      });

      if (urlStreamers.length > 0) {
        const streamer = urlStreamers[0];
        logger.debug(`🎯 CONTINUOUS RECORDING: Found URL stream publisher: ${streamer.identity}`);
        return streamer.identity;
      }

      return null;
    } catch (error) {
      logger.error('❌ CONTINUOUS RECORDING: Error finding URL stream publisher:', error.message);
      return null;
    }
  }

  /**
   * Extract username from a streaming platform URL
   * @param {string} sourceUrl - The source URL (e.g., https://twitch.tv/xqc)
   * @param {string} platform - The platform type (twitch, kick, etc.)
   * @returns {string|null} The extracted username or null if not found
   */
  extractUsernameFromUrl(sourceUrl, platform) {
    return usernameFromStreamUrl(sourceUrl, logger);
  }

  /**
   * Get the current active stream info from the database
   * This determines what's currently being shown (URL stream, real streamer, or viewbot)
   */
  async getCurrentStreamInfo() {
    try {
      // Check for real streamers via LiveKit participants first
      let activePublisher = await this.findRealStreamer();

      // If no real streamer, check for URL stream publishers
      if (!activePublisher) {
        activePublisher = await this.findUrlStreamPublisher();
      }

      if (activePublisher) {
        // Check if this is a URL stream relay (identity starts with 'url-stream-')
        if (activePublisher.startsWith('url-stream-')) {
          // First check the active ViewBotURLService for live stream metadata
          // This is more reliable since it has the current stream info in memory
          if (global.viewBotURLService && global.viewBotURLService.activeStreams) {
            const activeStream = global.viewBotURLService.activeStreams.get(activePublisher);
            if (activeStream) {
              // Extract the actual username from the source URL
              const extractedUsername = this.extractUsernameFromUrl(activeStream.sourceUrl, activeStream.platform);
              return {
                identity: activePublisher,
                type: 'url_stream',
                displayName: extractedUsername || activeStream.platform || 'URL Stream',
                platform: activeStream.platform || 'direct',
                sourceUrl: activeStream.sourceUrl
              };
            }
          }

          // Fallback: Look up the URL stream by its ID in the database
          const urlStream = await this.getAsync(`
            SELECT url_id, source_url, platform, display_name
            FROM url_streams
            WHERE url_id = ?
          `, [activePublisher]);

          if (urlStream) {
            // Extract the actual username from the source URL
            const extractedUsername = this.extractUsernameFromUrl(urlStream.source_url, urlStream.platform);
            return {
              identity: urlStream.url_id,
              type: 'url_stream',
              displayName: extractedUsername || urlStream.platform || 'URL Stream',
              platform: urlStream.platform || 'unknown',
              sourceUrl: urlStream.source_url
            };
          } else {
            // URL stream not found anywhere - use the identity
            return {
              identity: activePublisher,
              type: 'url_stream',
              displayName: 'URL Relay Stream',
              platform: 'unknown',
              sourceUrl: null
            };
          }
        }

        // This is a real user streamer - look up user info
        let displayName = activePublisher;
        try {
          // First try streaming_logs which stores socket ID -> username mapping
          const streamLog = await this.getAsync(
            'SELECT streamer_name FROM streaming_logs WHERE streamer_id = ? ORDER BY id DESC LIMIT 1',
            [activePublisher]
          );
          if (streamLog && streamLog.streamer_name) {
            displayName = streamLog.streamer_name;
          } else {
            // Fall back to users table (in case the identity is a username or user ID)
            const user = await this.userRepository.getByIdOrUsername(
              activePublisher,
              parseInt(activePublisher) || 0
            );
            if (user) {
              displayName = user.username;
            }
          }
        } catch (e) {
          // Use identity as display name
        }

        return {
          identity: activePublisher,
          type: 'real_streamer',
          displayName: displayName,
          platform: 'direct',
          sourceUrl: null
        };
      }

      // Check for viewbots as fallback
      try {
        const participants = await this.roomServiceClient.listParticipants(this.roomName);
        const viewbot = participants.find(p => this.isViewbot(p) && this._hasVideo(p));
        if (viewbot) {
          return {
            identity: viewbot.identity,
            type: 'viewbot',
            displayName: viewbot.name || viewbot.identity,
            platform: null,
            sourceUrl: null
          };
        }
      } catch (e) {
        // Room might not exist
      }

      return null;
    } catch (error) {
      logger.error('❌ STREAM TRACKING: Error getting current stream info:', error.message);
      return null;
    }
  }
}

module.exports = RoomParticipantInspector;
