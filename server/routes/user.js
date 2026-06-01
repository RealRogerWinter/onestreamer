/**
 * User chat-color preferences + admin dashboard — extracted from
 * `server/index.js`. Three routes:
 *
 *   POST /api/user/chat-color
 *   GET  /api/user/:userId/chat-color
 *   GET  /admin/dashboard
 *
 * The chat-color routes use `database` (module singleton, passed verbatim
 * via the deps bag). The dashboard reads `streamService`/`takeoverService`
 * (both live by mount time). The admin viewbot-client fleet
 * (ViewBotClientService) it formerly queried was deleted — dead under
 * LiveKit — so the dashboard's viewBot block now reports zeros/false/null.
 *
 * Body byte-equivalent except for `app.X(...)` → `router.X(...)`.
 */

const express = require('express');

function createUserRouter(deps) {
    const {
        authenticateAdmin,
        database,
        streamService,
        takeoverService,
        logger,
    } = deps;

    const router = express.Router();

    // Save user's chat color preference
    router.post('/api/user/chat-color', express.json(), async (req, res) => {
        try {
            const { userId, color } = req.body;

            if (!userId || !color) {
                return res.status(400).json({ error: 'Missing userId or color' });
            }

            // Validate hex color
            if (!/^#[0-9A-F]{6}$/i.test(color)) {
                return res.status(400).json({ error: 'Invalid color format' });
            }

            // Check if user_stats exists for this user
            const userStats = await database.getAsync(
                'SELECT id FROM user_stats WHERE user_id = ?',
                [userId]
            );

            if (userStats) {
                // Update existing record
                await database.runAsync(
                    'UPDATE user_stats SET chat_color = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
                    [color, userId]
                );
            } else {
                // Create new record
                await database.runAsync(
                    'INSERT INTO user_stats (user_id, chat_color) VALUES (?, ?)',
                    [userId, color]
                );
            }

            logger.info(`🎨 Saved chat color ${color} for user ${userId}`);
            res.json({ success: true, color });
        } catch (error) {
            logger.error({ err: error }, 'Error saving chat color');
            res.status(500).json({ error: 'Failed to save chat color' });
        }
    });

    // Get user's saved chat color
    router.get('/api/user/:userId/chat-color', async (req, res) => {
        try {
            const { userId } = req.params;

            const result = await database.getAsync(
                'SELECT chat_color FROM user_stats WHERE user_id = ?',
                [userId]
            );

            res.json({
                color: result?.chat_color || null
            });
        } catch (error) {
            logger.error({ err: error }, 'Error fetching chat color');
            res.status(500).json({ error: 'Failed to fetch chat color' });
        }
    });

    // Admin API Routes
    router.get('/admin/dashboard', authenticateAdmin, async (req, res) => {
      try {
        logger.info('🔍 Dashboard request received');

        // The admin viewbot-client fleet (ViewBotClientService) was deleted —
        // it was dead under LiveKit. The dashboard's viewBot block now reports
        // zeros/false/null via the existing optional-chaining defaults below.
        const viewBotData = null;
        const viewBotHealth = null;

        const services = {
          stream: streamService.getStreamStatus(),
          viewBot: {
            totalBots: viewBotData?.totalBots || 0,
            streamingBots: viewBotData?.bots?.filter(bot => bot.isStreaming).length || 0,
            connectedBots: viewBotData?.bots?.filter(bot => bot.isConnected).length || 0,
            rotationEnabled: viewBotHealth?.rotationEnabled || false,
            currentLiveBot: viewBotHealth?.currentLiveBot || null,
            availableBots: viewBotData?.bots?.filter(bot => bot.isConnected && !bot.isStreaming).length || 0,
            realStreamerActive: viewBotHealth?.realStreamerActive || false,
            timeToNextRotation: viewBotHealth?.timeToNextRotation || null,
            timeToNextRotationFormatted: viewBotHealth?.timeToNextRotationFormatted || null
          },
          takeover: {
            cooldownSeconds: takeoverService.getCooldownSeconds(),
            lastTakeover: await takeoverService.getLastTakeoverTime(),
          }
        };

        const cooldowns = await takeoverService.getAllCooldowns();

        // Format cooldowns for backward compatibility with client
        const formattedCooldowns = cooldowns.map(cooldown => ({
          socketId: cooldown.identifier, // For client compatibility
          identifier: cooldown.identifier, // New field for IP tracking
          remaining: cooldown.remaining,
          reason: cooldown.reason,
          duration: cooldown.duration
        }));

        res.json({
          message: 'OneStreamer Admin Dashboard',
          services,
          cooldowns: formattedCooldowns,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Dashboard error');
        res.status(500).json({ error: 'Failed to load dashboard data' });
      }
    });

    return router;
}

module.exports = createUserRouter;
