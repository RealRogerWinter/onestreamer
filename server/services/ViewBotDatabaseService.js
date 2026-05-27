const { v4: uuidv4 } = require('uuid');
const ViewBotRepository = require('../database/repository/ViewBotRepository');

/**
 * ViewBot Database Service
 * Handles all database operations for ViewBot persistence
 * Enables ViewBots to survive server restarts and maintain state/history
 *
 * PR 6.1: SQL primitives are now wrapped behind `this.repo`
 * (ViewBotRepository). Domain serialization (JSON.stringify) and boolean
 * coercion stay here; the repo only deals in strings/numbers/nullables.
 */
class ViewBotDatabaseService {
    constructor() {
        // Singleton pattern - return existing instance if it exists
        if (ViewBotDatabaseService.instance) {
            return ViewBotDatabaseService.instance;
        }

        this.initialized = false;
        this.repo = new ViewBotRepository();

        // Store the instance
        ViewBotDatabaseService.instance = this;
    }

    /**
     * Initialize the service and ensure tables exist
     */
    async initialize() {
        // Check if already initialized
        if (this.initialized) {
            return true;
        }
        
        try {
            // Check if tables already exist before running migration
            const tableExists = await this.repo.viewbotsTableExists();

            if (!tableExists) {
                // Run migration only if tables don't exist
                console.log('📦 VIEWBOT DB: Tables not found, running migration...');
                const migration = require('../migrations/setup-viewbot-tables');
                await migration.setupViewBotTables();
            } else {
                console.log('✓ VIEWBOT DB: Tables already exist, skipping migration');
            }
            
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

            const result = await this.repo.upsertViewBot({
                botId,
                name,
                configJson,
                contentType,
                isEnabled,
                autoStart,
                timeAllotment,
            });

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
            const row = await this.repo.findEnabledByBotId(botId);

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
            const rows = await this.repo.listEnabled();

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
            const result = await this.repo.deleteByBotId(botId);

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
     * Disable a ViewBot (soft delete - marks as disabled instead of deleting)
     */
    async disableViewBot(botId) {
        if (!this.initialized) await this.initialize();
        
        try {
            const result = await this.repo.setEnabledByBotId(botId, 0);

            if (result.changes > 0) {
                console.log(`🚫 VIEWBOT DB: Disabled ViewBot ${botId}`);
                return true;
            } else {
                console.log(`⚠️ VIEWBOT DB: ViewBot ${botId} not found`);
                return false;
            }
        } catch (error) {
            console.error(`❌ VIEWBOT DB: Failed to disable ViewBot ${botId}:`, error);
            throw error;
        }
    }

    /**
     * Enable a ViewBot
     */
    async enableViewBot(botId) {
        if (!this.initialized) await this.initialize();
        
        try {
            const result = await this.repo.setEnabledByBotId(botId, 1);

            if (result.changes > 0) {
                console.log(`✅ VIEWBOT DB: Enabled ViewBot ${botId}`);
                return true;
            } else {
                console.log(`⚠️ VIEWBOT DB: ViewBot ${botId} not found`);
                return false;
            }
        } catch (error) {
            console.error(`❌ VIEWBOT DB: Failed to enable ViewBot ${botId}:`, error);
            throw error;
        }
    }

    /**
     * Update ViewBot usage statistics
     */
    async updateViewBotUsage(botId) {
        if (!this.initialized) await this.initialize();
        
        try {
            await this.repo.incrementUsageCount(botId);

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
            const result = await this.repo.updateName(botId, name);

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
                maxBots = -1,
                rotationProbability = 0.045,
                rotationCheckIntervalMin = 5000,
                rotationCheckIntervalMax = 10000
            } = state;

            await this.repo.upsertSystemState({
                rotationEnabled,
                currentLiveBot,
                realStreamerActive,
                maxBots,
                rotationProbability,
                rotationCheckIntervalMin,
                rotationCheckIntervalMax,
            });

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
            const row = await this.repo.getSystemState();

            if (!row) {
                console.log('📊 VIEWBOT DB: No system state found, returning defaults');
                // Return default state if none exists
                return {
                    rotationEnabled: false,
                    currentLiveBot: null,
                    realStreamerActive: false,
                    maxBots: -1,
                    rotationProbability: 0.045,
                    rotationCheckIntervalMin: 5000,
                    rotationCheckIntervalMax: 10000
                };
            }
            
            console.log('📊 VIEWBOT DB: Raw database row:', row);
            
            const state = {
                rotationEnabled: Boolean(row.rotation_enabled),
                currentLiveBot: row.current_live_bot,
                realStreamerActive: Boolean(row.real_streamer_active),
                maxBots: row.max_bots,
                rotationProbability: row.rotation_probability || 0.045,
                rotationCheckIntervalMin: row.rotation_check_interval_min || 5000,
                rotationCheckIntervalMax: row.rotation_check_interval_max || 10000,
                updatedAt: row.updated_at
            };
            
            console.log('📊 VIEWBOT DB: Returning state:', state);
            return state;
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

            const result = await this.repo.insertSession({
                sessionId,
                viewbotId: viewbot.id,
                botId,
                streamQuality,
                metadataJson: JSON.stringify(metadata),
            });

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

            await this.repo.endSession(sessionId, {
                duration,
                viewerCount,
                rotationReason,
                status,
                errorMessage,
            });

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

            await this.repo.insertRotation({
                fromBotId,
                toBotId,
                reason,
                rotationType,
                durationBeforeRotation,
                viewerCount,
                metadataJson: JSON.stringify(metadata),
            });

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

            await this.repo.insertMetric({
                viewbotId: viewbot.id,
                botId,
                sessionId,
                metricType,
                metricValue,
                metricUnit,
                additionalDataJson: JSON.stringify(additionalData),
            });

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
            const sessionStats = await this.repo.getSessionAnalytics({
                timeCondition,
                botCondition,
                params,
            });

            // Get rotation statistics (use timestamp column)
            const rotationTimeCondition = timeCondition.replace('started_at', 'timestamp');
            const rotationBotCondition = botCondition ? 'AND (from_bot_id = ? OR to_bot_id = ?)' : '';
            const rotationStats = await this.repo.getRotationAnalytics({
                timeCondition: rotationTimeCondition,
                botCondition: rotationBotCondition,
                params: botId ? [botId, botId] : [],
            });

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
            const sessionsResult = await this.repo.cleanupOldSessions(retentionDays);
            const rotationsResult = await this.repo.cleanupOldRotations(retentionDays);
            const metricsResult = await this.repo.cleanupOldMetrics(retentionDays);

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