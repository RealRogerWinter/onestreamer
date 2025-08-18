const { runAsync, getAsync, allAsync } = require('../database/database');
const { v4: uuidv4 } = require('uuid');

/**
 * ViewBot Database Service
 * Handles all database operations for ViewBot persistence
 * Enables ViewBots to survive server restarts and maintain state/history
 */
class ViewBotDatabaseService {
    constructor() {
        this.initialized = false;
    }

    /**
     * Initialize the service and ensure tables exist
     */
    async initialize() {
        try {
            // Run migration to ensure tables exist
            const migration = require('../migrations/setup-viewbot-tables');
            await migration.setupViewBotTables();
            
            this.initialized = true;
            console.log('✅ VIEWBOT DB: ViewBot Database Service initialized');
            return true;
        } catch (error) {
            console.error('❌ VIEWBOT DB: Failed to initialize ViewBot Database Service:', error);
            throw error;
        }
    }

    /**
     * Save a ViewBot configuration to the database
     */
    async saveViewBot(botData) {
        if (!this.initialized) await this.initialize();
        
        try {
            const {
                botId,
                name,
                config,
                contentType = 'testPattern',
                isEnabled = true,
                autoStart = false,
                timeAllotment = null
            } = botData;

            const configJson = JSON.stringify(config);
            
            const result = await runAsync(`
                INSERT OR REPLACE INTO viewbots 
                (bot_id, name, config, content_type, is_enabled, auto_start, time_allotment, updated_at, usage_count)
                VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 
                    COALESCE((SELECT usage_count FROM viewbots WHERE bot_id = ?), 0))
            `, [botId, name, configJson, contentType, isEnabled, autoStart, timeAllotment, botId]);
            
            console.log(`💾 VIEWBOT DB: Saved ViewBot ${botId} to database`);
            return { success: true, id: result.id };
        } catch (error) {
            console.error(`❌ VIEWBOT DB: Failed to save ViewBot ${botData.botId}:`, error);
            throw error;
        }
    }

    /**
     * Load ViewBot configuration from the database
     */
    async loadViewBot(botId) {
        if (!this.initialized) await this.initialize();
        
        try {
            const row = await getAsync(`
                SELECT * FROM viewbots WHERE bot_id = ? AND is_enabled = 1
            `, [botId]);
            
            if (!row) {
                return null;
            }
            
            return {
                id: row.id,
                botId: row.bot_id,
                name: row.name,
                config: JSON.parse(row.config),
                contentType: row.content_type,
                isEnabled: Boolean(row.is_enabled),
                autoStart: Boolean(row.auto_start),
                timeAllotment: row.time_allotment,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
                lastUsedAt: row.last_used_at,
                usageCount: row.usage_count
            };
        } catch (error) {
            console.error(`❌ VIEWBOT DB: Failed to load ViewBot ${botId}:`, error);
            throw error;
        }
    }

    /**
     * Load all enabled ViewBot configurations
     */
    async loadAllViewBots() {
        if (!this.initialized) await this.initialize();
        
        try {
            const rows = await allAsync(`
                SELECT * FROM viewbots WHERE is_enabled = 1 ORDER BY created_at ASC
            `);
            
            return rows.map(row => ({
                id: row.id,
                botId: row.bot_id,
                name: row.name,
                config: JSON.parse(row.config),
                contentType: row.content_type,
                isEnabled: Boolean(row.is_enabled),
                autoStart: Boolean(row.auto_start),
                timeAllotment: row.time_allotment,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
                lastUsedAt: row.last_used_at,
                usageCount: row.usage_count
            }));
        } catch (error) {
            console.error('❌ VIEWBOT DB: Failed to load ViewBots:', error);
            throw error;
        }
    }

    /**
     * Delete a ViewBot from the database
     */
    async deleteViewBot(botId) {
        if (!this.initialized) await this.initialize();
        
        try {
            const result = await runAsync(`
                DELETE FROM viewbots WHERE bot_id = ?
            `, [botId]);
            
            if (result.changes > 0) {
                console.log(`🗑️ VIEWBOT DB: Deleted ViewBot ${botId} from database`);
                return { success: true };
            } else {
                return { success: false, message: 'ViewBot not found' };
            }
        } catch (error) {
            console.error(`❌ VIEWBOT DB: Failed to delete ViewBot ${botId}:`, error);
            throw error;
        }
    }

    /**
     * Update ViewBot usage statistics
     */
    async updateViewBotUsage(botId) {
        if (!this.initialized) await this.initialize();
        
        try {
            await runAsync(`
                UPDATE viewbots 
                SET usage_count = usage_count + 1, last_used_at = CURRENT_TIMESTAMP
                WHERE bot_id = ?
            `, [botId]);
            
            console.log(`📊 VIEWBOT DB: Updated usage count for ViewBot ${botId}`);
        } catch (error) {
            console.error(`❌ VIEWBOT DB: Failed to update usage for ViewBot ${botId}:`, error);
        }
    }

    /**
     * Update ViewBot name
     */
    async updateViewBotName(botId, name) {
        if (!this.initialized) await this.initialize();
        
        try {
            const result = await runAsync(`
                UPDATE viewbots 
                SET name = ?, updated_at = CURRENT_TIMESTAMP
                WHERE bot_id = ?
            `, [name, botId]);
            
            if (result.changes > 0) {
                console.log(`📝 VIEWBOT DB: Updated name for ViewBot ${botId} to "${name}"`);
                return { success: true };
            } else {
                return { success: false, message: 'ViewBot not found' };
            }
        } catch (error) {
            console.error(`❌ VIEWBOT DB: Failed to update name for ViewBot ${botId}:`, error);
            throw error;
        }
    }

    /**
     * Save ViewBot system state (rotation settings, current active bot, etc.)
     */
    async saveSystemState(state) {
        if (!this.initialized) await this.initialize();
        
        try {
            const {
                rotationEnabled = false,
                currentLiveBot = null,
                realStreamerActive = false,
                maxBots = -1
            } = state;

            await runAsync(`
                INSERT OR REPLACE INTO viewbot_system_state 
                (id, rotation_enabled, current_live_bot, real_streamer_active, max_bots, updated_at)
                VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `, [rotationEnabled, currentLiveBot, realStreamerActive, maxBots]);
            
            console.log('💾 VIEWBOT DB: Saved ViewBot system state');
            return { success: true };
        } catch (error) {
            console.error('❌ VIEWBOT DB: Failed to save system state:', error);
            throw error;
        }
    }

    /**
     * Load ViewBot system state
     */
    async loadSystemState() {
        if (!this.initialized) await this.initialize();
        
        try {
            const row = await getAsync(`
                SELECT * FROM viewbot_system_state WHERE id = 1
            `);
            
            if (!row) {
                // Return default state if none exists
                return {
                    rotationEnabled: false,
                    currentLiveBot: null,
                    realStreamerActive: false,
                    maxBots: -1
                };
            }
            
            return {
                rotationEnabled: Boolean(row.rotation_enabled),
                currentLiveBot: row.current_live_bot,
                realStreamerActive: Boolean(row.real_streamer_active),
                maxBots: row.max_bots,
                updatedAt: row.updated_at
            };
        } catch (error) {
            console.error('❌ VIEWBOT DB: Failed to load system state:', error);
            // Return default state on error
            return {
                rotationEnabled: false,
                currentLiveBot: null,
                realStreamerActive: false,
                maxBots: -1
            };
        }
    }

    /**
     * Start a new ViewBot session
     */
    async startSession(sessionData) {
        if (!this.initialized) await this.initialize();
        
        try {
            const {
                botId,
                sessionId = uuidv4(),
                streamQuality = 'auto',
                metadata = {}
            } = sessionData;

            // Get the viewbot database ID
            const viewbot = await this.loadViewBot(botId);
            if (!viewbot) {
                throw new Error(`ViewBot ${botId} not found in database`);
            }

            const result = await runAsync(`
                INSERT INTO viewbot_sessions 
                (session_id, viewbot_id, bot_id, stream_quality, metadata)
                VALUES (?, ?, ?, ?, ?)
            `, [sessionId, viewbot.id, botId, streamQuality, JSON.stringify(metadata)]);
            
            console.log(`🎬 VIEWBOT DB: Started session ${sessionId} for ViewBot ${botId}`);
            
            // Update usage count
            await this.updateViewBotUsage(botId);
            
            return { success: true, sessionId, id: result.id };
        } catch (error) {
            console.error(`❌ VIEWBOT DB: Failed to start session for ViewBot ${sessionData.botId}:`, error);
            throw error;
        }
    }

    /**
     * End a ViewBot session
     */
    async endSession(sessionId, endData = {}) {
        if (!this.initialized) await this.initialize();
        
        try {
            const {
                duration = null,
                viewerCount = 0,
                rotationReason = null,
                status = 'completed',
                errorMessage = null
            } = endData;

            await runAsync(`
                UPDATE viewbot_sessions 
                SET ended_at = CURRENT_TIMESTAMP, duration_ms = ?, viewer_count = ?, 
                    rotation_reason = ?, status = ?, error_message = ?
                WHERE session_id = ?
            `, [duration, viewerCount, rotationReason, status, errorMessage, sessionId]);
            
            console.log(`🏁 VIEWBOT DB: Ended session ${sessionId}`);
            return { success: true };
        } catch (error) {
            console.error(`❌ VIEWBOT DB: Failed to end session ${sessionId}:`, error);
            throw error;
        }
    }

    /**
     * Record a rotation event
     */
    async recordRotation(rotationData) {
        if (!this.initialized) await this.initialize();
        
        try {
            const {
                fromBotId,
                toBotId,
                reason,
                rotationType = 'automatic',
                durationBeforeRotation = null,
                viewerCount = 0,
                metadata = {}
            } = rotationData;

            await runAsync(`
                INSERT INTO viewbot_rotation_history 
                (from_bot_id, to_bot_id, rotation_reason, rotation_type, 
                 duration_before_rotation, viewer_count_at_rotation, metadata)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [fromBotId, toBotId, reason, rotationType, durationBeforeRotation, 
                viewerCount, JSON.stringify(metadata)]);
            
            console.log(`🔄 VIEWBOT DB: Recorded rotation: ${fromBotId} → ${toBotId} (${reason})`);
            return { success: true };
        } catch (error) {
            console.error('❌ VIEWBOT DB: Failed to record rotation:', error);
        }
    }

    /**
     * Record a performance metric
     */
    async recordMetric(metricData) {
        if (!this.initialized) await this.initialize();
        
        try {
            const {
                botId,
                sessionId = null,
                metricType,
                metricValue,
                metricUnit = null,
                additionalData = {}
            } = metricData;

            // Get the viewbot database ID
            const viewbot = await this.loadViewBot(botId);
            if (!viewbot) {
                console.warn(`⚠️ VIEWBOT DB: ViewBot ${botId} not found, skipping metric recording`);
                return { success: false };
            }

            await runAsync(`
                INSERT INTO viewbot_metrics 
                (viewbot_id, bot_id, session_id, metric_type, metric_value, metric_unit, additional_data)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [viewbot.id, botId, sessionId, metricType, metricValue, metricUnit, 
                JSON.stringify(additionalData)]);
            
            return { success: true };
        } catch (error) {
            console.error('❌ VIEWBOT DB: Failed to record metric:', error);
        }
    }

    /**
     * Get ViewBot analytics and statistics
     */
    async getAnalytics(botId = null, timeframe = '24h') {
        if (!this.initialized) await this.initialize();
        
        try {
            let timeCondition = '';
            const now = new Date();
            
            switch (timeframe) {
                case '1h':
                    timeCondition = `AND started_at > datetime('now', '-1 hour')`;
                    break;
                case '24h':
                    timeCondition = `AND started_at > datetime('now', '-1 day')`;
                    break;
                case '7d':
                    timeCondition = `AND started_at > datetime('now', '-7 days')`;
                    break;
                case '30d':
                    timeCondition = `AND started_at > datetime('now', '-30 days')`;
                    break;
                default:
                    timeCondition = '';
            }

            const botCondition = botId ? 'AND bot_id = ?' : '';
            const params = botId ? [botId] : [];

            // Get session statistics
            const sessionStats = await getAsync(`
                SELECT 
                    COUNT(*) as total_sessions,
                    AVG(duration_ms) as avg_duration,
                    SUM(duration_ms) as total_duration,
                    AVG(viewer_count) as avg_viewers,
                    COUNT(CASE WHEN status = 'completed' THEN 1 END) as successful_sessions,
                    COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_sessions
                FROM viewbot_sessions 
                WHERE 1=1 ${timeCondition} ${botCondition}
            `, params);

            // Get rotation statistics (use timestamp column)
            const rotationTimeCondition = timeCondition.replace('started_at', 'timestamp');
            const rotationStats = await getAsync(`
                SELECT 
                    COUNT(*) as total_rotations,
                    AVG(duration_before_rotation) as avg_rotation_time
                FROM viewbot_rotation_history 
                WHERE 1=1 ${rotationTimeCondition} ${botCondition ? 'AND (from_bot_id = ? OR to_bot_id = ?)' : ''}
            `, botId ? [botId, botId] : []);

            return {
                timeframe,
                botId,
                sessions: sessionStats,
                rotations: rotationStats,
                generatedAt: new Date().toISOString()
            };
        } catch (error) {
            console.error('❌ VIEWBOT DB: Failed to get analytics:', error);
            throw error;
        }
    }

    /**
     * Clean up old data based on retention policy
     */
    async cleanup(retentionDays = 30) {
        if (!this.initialized) await this.initialize();
        
        try {
            const cutoffDate = `datetime('now', '-${retentionDays} days')`;
            
            // Clean up old sessions
            const sessionsResult = await runAsync(`
                DELETE FROM viewbot_sessions 
                WHERE created_at < ${cutoffDate} AND status IN ('completed', 'failed')
            `);
            
            // Clean up old rotation history
            const rotationsResult = await runAsync(`
                DELETE FROM viewbot_rotation_history 
                WHERE timestamp < ${cutoffDate}
            `);
            
            // Clean up old metrics
            const metricsResult = await runAsync(`
                DELETE FROM viewbot_metrics 
                WHERE measured_at < ${cutoffDate}
            `);
            
            console.log(`🧹 VIEWBOT DB: Cleanup completed - removed ${sessionsResult.changes} sessions, ${rotationsResult.changes} rotations, ${metricsResult.changes} metrics`);
            
            return {
                success: true,
                sessionsRemoved: sessionsResult.changes,
                rotationsRemoved: rotationsResult.changes,
                metricsRemoved: metricsResult.changes
            };
        } catch (error) {
            console.error('❌ VIEWBOT DB: Failed to cleanup old data:', error);
            throw error;
        }
    }
}

module.exports = ViewBotDatabaseService;