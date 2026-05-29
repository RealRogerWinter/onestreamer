/**
 * IngressJanitor.js - Orphan ingress/participant/process cleanup for URL
 * streams, extracted from ViewBotURLService.
 *
 * Handles streams that aren't tracked in owner.activeStreams (server restarts,
 * failed cleanup) plus the safety-net pkill of orphaned ffmpeg/streamlink.
 * Reads owner.livekitService config and owner.activeStreams via the `owner`
 * back-reference; process teardown goes through owner._stopProcesses so
 * behavior is identical to the in-service form.
 *
 * Deps: { owner, logger }.
 */

class IngressJanitor {
  constructor(owner, logger) {
    this.owner = owner;
    this.logger = logger;
  }

  /**
   * CRITICAL: Clean up ALL URL stream ingresses and participants from LiveKit
   * This handles orphaned streams that aren't tracked in activeStreams
   * (e.g., from server restarts or failed cleanup)
   * @param {string} excludeUrlId - Optional URL ID to exclude from cleanup (for the new stream being started)
   */
  async cleanupAll(excludeUrlId = null) {
    const owner = this.owner;
    const logger = this.logger;

    if (!owner.livekitService) {
      logger.debug('⚠️ URL STREAM CLEANUP: No LiveKit service, skipping ingress cleanup');
      return;
    }

    try {
      const { IngressClient, RoomServiceClient } = require('livekit-server-sdk');
      const host = owner.livekitService.config?.host || 'http://localhost:7882';
      const apiKey = owner.livekitService.config?.apiKey;
      const apiSecret = owner.livekitService.config?.apiSecret;
      const roomName = owner.livekitService.config?.roomName || 'onestreamer-main';

      const ingressClient = new IngressClient(
        host.startsWith('http') ? host : `http://${host}`,
        apiKey,
        apiSecret
      );
      const roomClient = new RoomServiceClient(
        host.startsWith('http') ? host : `http://${host}`,
        apiKey,
        apiSecret
      );

      // 1. List and delete ALL url-stream AND viewbot ingresses
      logger.debug(`🧹 URL STREAM CLEANUP: Listing all ingresses...${excludeUrlId ? ` (excluding ${excludeUrlId})` : ''}`);
      const allIngresses = await ingressClient.listIngress({ roomName });

      // Find URL stream ingresses (excluding the one we're starting)
      const urlStreamIngresses = allIngresses.filter(ing => {
        const isUrlStream = ing.participantIdentity?.startsWith('url-stream-') ||
          ing.name?.includes('url-stream');
        // If excludeUrlId is set, skip ingresses that match
        if (excludeUrlId && (ing.participantIdentity === excludeUrlId || ing.name?.includes(excludeUrlId))) {
          logger.debug(`🔒 URL STREAM CLEANUP: Preserving ingress for new stream: ${ing.participantIdentity}`);
          return false;
        }
        return isUrlStream;
      });

      // Find viewbot ingresses (they should be stopped when URL stream starts)
      const viewbotIngresses = allIngresses.filter(ing =>
        ing.participantIdentity?.startsWith('viewbot-') ||
        ing.name?.includes('viewbot')
      );

      logger.debug(`🧹 URL STREAM CLEANUP: Found ${urlStreamIngresses.length} URL stream ingresses and ${viewbotIngresses.length} viewbot ingresses to clean up`);

      // Delete URL stream ingresses
      for (const ingress of urlStreamIngresses) {
        try {
          await ingressClient.deleteIngress(ingress.ingressId);
          logger.debug(`🗑️ URL STREAM CLEANUP: Deleted URL stream ingress ${ingress.ingressId} (${ingress.participantIdentity})`);
        } catch (err) {
          logger.error(`⚠️ URL STREAM CLEANUP: Failed to delete ingress ${ingress.ingressId}:`, err.message);
        }
      }

      // Delete viewbot ingresses
      for (const ingress of viewbotIngresses) {
        try {
          await ingressClient.deleteIngress(ingress.ingressId);
          logger.debug(`🗑️ URL STREAM CLEANUP: Deleted viewbot ingress ${ingress.ingressId} (${ingress.participantIdentity})`);
        } catch (err) {
          logger.error(`⚠️ URL STREAM CLEANUP: Failed to delete viewbot ingress ${ingress.ingressId}:`, err.message);
        }
      }

      // 2. Remove ALL url-stream participants from the room (excluding the new stream)
      logger.debug('🧹 URL STREAM CLEANUP: Listing room participants...');
      const participants = await roomClient.listParticipants(roomName);
      const urlStreamParticipants = participants.filter(p => {
        if (!p.identity?.startsWith('url-stream-')) return false;
        // If excludeUrlId is set, skip the new stream's participant
        if (excludeUrlId && p.identity === excludeUrlId) {
          logger.debug(`🔒 URL STREAM CLEANUP: Preserving participant for new stream: ${p.identity}`);
          return false;
        }
        return true;
      });

      logger.debug(`🧹 URL STREAM CLEANUP: Found ${urlStreamParticipants.length} URL stream participants to remove`);

      for (const participant of urlStreamParticipants) {
        try {
          await roomClient.removeParticipant(roomName, participant.identity);
          logger.debug(`🗑️ URL STREAM CLEANUP: Removed participant ${participant.identity}`);
        } catch (err) {
          logger.error(`⚠️ URL STREAM CLEANUP: Failed to remove participant ${participant.identity}:`, err.message);
        }
      }

      // 3. Also remove viewbot participants that have tracks (they shouldn't be publishing alongside URL stream)
      const viewbotParticipants = participants.filter(p =>
        p.identity?.startsWith('viewbot-') && p.tracks && p.tracks.length > 0
      );

      logger.debug(`🧹 URL STREAM CLEANUP: Found ${viewbotParticipants.length} viewbot participants with tracks to remove`);

      for (const participant of viewbotParticipants) {
        try {
          await roomClient.removeParticipant(roomName, participant.identity);
          logger.debug(`🗑️ URL STREAM CLEANUP: Removed viewbot participant ${participant.identity}`);
        } catch (err) {
          logger.error(`⚠️ URL STREAM CLEANUP: Failed to remove viewbot participant ${participant.identity}:`, err.message);
        }
      }

      // 4. CRITICAL: Stop all LOCAL processes (FFmpeg, streamlink) for tracked streams (excluding new stream)
      logger.debug('🧹 URL STREAM CLEANUP: Stopping local processes for tracked streams...');
      for (const [urlId, streamEntry] of owner.activeStreams) {
        // Skip the new stream we're starting
        if (excludeUrlId && urlId === excludeUrlId) {
          logger.debug(`🔒 URL STREAM CLEANUP: Preserving processes for new stream: ${urlId}`);
          continue;
        }
        if (streamEntry.processes && streamEntry.processes.length > 0) {
          logger.debug(`🛑 URL STREAM CLEANUP: Stopping ${streamEntry.processes.length} processes for ${urlId}`);
          await owner._stopProcesses(streamEntry);
        }
      }

      // 5. SAFETY NET: Kill any orphaned ffmpeg/streamlink processes by pattern
      // This catches processes that weren't properly tracked
      // IMPORTANT: Skip pkill if we're preserving a stream - pkill would kill ALL processes including the new one
      if (!excludeUrlId) {
        logger.debug('🧹 URL STREAM CLEANUP: Killing any orphaned streaming processes...');
        try {
          const { exec } = require('child_process');
          await new Promise((resolve) => {
            exec('pkill -9 -f "ffmpeg.*rtmp://127.0.0.1:1935"', (err) => {
              if (!err) logger.debug('🗑️ URL STREAM CLEANUP: Killed orphaned FFmpeg RTMP processes');
              resolve();
            });
          });
          await new Promise((resolve) => {
            exec('pkill -9 -f "streamlink.*twitch|streamlink.*kick"', (err) => {
              if (!err) logger.debug('🗑️ URL STREAM CLEANUP: Killed orphaned streamlink processes');
              resolve();
            });
          });
        } catch (err) {
          logger.error('⚠️ URL STREAM CLEANUP: Error killing orphaned processes:', err.message);
        }
      } else {
        logger.debug('🔒 URL STREAM CLEANUP: Skipping pkill to preserve new stream processes');
      }

      // 6. Clear local tracking (but preserve excluded stream entry)
      if (excludeUrlId) {
        const preservedEntry = owner.activeStreams.get(excludeUrlId);
        owner.activeStreams.clear();
        if (preservedEntry) {
          owner.activeStreams.set(excludeUrlId, preservedEntry);
          logger.debug(`🔒 URL STREAM CLEANUP: Preserved activeStream entry for ${excludeUrlId}`);
        }
      } else {
        owner.activeStreams.clear();
      }
      logger.debug('✅ URL STREAM CLEANUP: Complete - old URL streams, processes, and viewbots cleaned up');

    } catch (error) {
      logger.error('❌ URL STREAM CLEANUP: Error during cleanup:', error.message);
    }
  }

  /**
   * SAFETY NET: Kill any orphaned ffmpeg/streamlink processes by pattern.
   * Fire-and-forget pkill used by stopAllURLStreams after tracked streams
   * are stopped. Extracted verbatim from the inline block.
   */
  killOrphans() {
    try {
      const { exec } = require('child_process');
      exec('pkill -9 -f "ffmpeg.*rtmp://127.0.0.1:1935"', () => {});
      exec('pkill -9 -f "streamlink.*twitch|streamlink.*kick"', () => {});
    } catch (err) {
      // Ignore errors
    }
  }
}

module.exports = IngressJanitor;
