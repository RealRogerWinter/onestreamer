const EventEmitter = require('events');

const logger = require('../bootstrap/logger').child({ svc: 'CanvasFxService' });

const BuffEffectBridge = require('./canvasfx/BuffEffectBridge');
const EffectDispatcher = require('./canvasfx/EffectDispatcher');
const EffectRegistry = require('./canvasfx/EffectRegistry');
const EffectLifecycle = require('./canvasfx/EffectLifecycle');

class CanvasFxService extends EventEmitter {
    constructor(io = null, itemService = null, buffDebuffService = null) {
        super();
        this.io = io;
        this.itemService = itemService;
        this.buffDebuffService = buffDebuffService;

        // Track active visual effects
        this.activeEffects = new Map();

        // Track effects that sync with buff duration
        this.buffSyncedEffects = new Map(); // effectId -> buffId

        // Performance monitoring
        this.effectStats = {
            totalTriggered: 0,
            activeCount: 0,
            droppedEffects: 0
        };

        // Configuration
        this.config = {
            maxConcurrentEffects: 10,
            effectQueueSize: 20,
            defaultDuration: 2000
        };

        // Collaborators (all state stays on `this`; these hold no state of their
        // own). Internal cross-calls route back through `this.<method>` so the
        // public-method spies/delegators stay observable.
        this._bridge = new BuffEffectBridge(this);
        this._dispatcher = new EffectDispatcher(this);
        this._registry = new EffectRegistry(this);
        this._lifecycle = new EffectLifecycle(this);

        logger.debug('🎨 CANVASFX: Service initialized');
    }

    // Set dependencies after initialization if needed
    setDependencies(io, itemService, buffDebuffService, streamService = null, sessionService = null) {
        this.io = io;
        this.itemService = itemService;
        this.buffDebuffService = buffDebuffService;
        this.streamService = streamService;
        this.sessionService = sessionService;

        // Hook into buff service events
        if (this.buffDebuffService) {
            this.buffDebuffService.on('buff-applied', this.handleBuffApplied.bind(this));
            this.buffDebuffService.on('buff-expired', this.handleBuffExpired.bind(this));
        }

        // Track current streamer for change detection
        this.currentStreamer = null;
        this.streamerCheckInterval = null;

        // Start monitoring streamer changes if we have stream service
        if (this.streamService) {
            this.startStreamerMonitoring();
        }
    }

    // Handle buff applied event from BuffDebuffService
    async handleBuffApplied(buffData) {
        return this._bridge.handleBuffApplied(buffData);
    }

    // Check if an item has visual effects
    hasVisualEffect(item) {
        return this._registry.hasVisualEffect(item);
    }

    // Check if an item's effect should be synced with buff duration
    isBuffSyncedEffect(item) {
        return this._registry.isBuffSyncedEffect(item);
    }

    // Handle buff expired event from BuffDebuffService
    async handleBuffExpired(buffData) {
        return this._bridge.handleBuffExpired(buffData);
    }

    // Start monitoring for streamer changes
    startStreamerMonitoring() {
        return this._bridge.startStreamerMonitoring();
    }

    // Check for streamer changes and handle them
    async checkStreamerChange() {
        return this._bridge.checkStreamerChange();
    }

    // Handle streamer change
    async handleStreamerChanged(previousStreamer, newStreamer) {
        return this._bridge.handleStreamerChanged(previousStreamer, newStreamer);
    }

    // Handle streamer going live
    async handleStreamerWentLive(newStreamerSocketId) {
        return this._bridge.handleStreamerWentLive(newStreamerSocketId);
    }

    // Handle stream ending
    async handleStreamEnded() {
        return this._bridge.handleStreamEnded();
    }

    // Check if an item requires interactive behavior (click-to-throw)
    isInteractiveItem(item) {
        return this._registry.isInteractiveItem(item);
    }

    // Get interaction configuration for an item
    getInteractionConfig(item) {
        return this._registry.getInteractionConfig(item);
    }

    // Trigger visual effect from item usage
    async triggerItemEffect(userId, itemId, streamId, effectParams = {}) {
        return this._dispatcher.triggerItemEffect(userId, itemId, streamId, effectParams);
    }

    // Trigger visual effect at specific position (for click-to-throw functionality)
    async triggerItemEffectAtPosition(userId, itemId, streamId, position, effectParams = {}) {
        return this._dispatcher.triggerItemEffectAtPosition(userId, itemId, streamId, position, effectParams);
    }

    // Trigger multi-phase effect (like smoke bomb with initial puff + persistent smoke)
    async triggerMultiPhaseEffect(userId, itemId, streamId, item, effectConfig, totalDuration, effectParams) {
        return this._dispatcher.triggerMultiPhaseEffect(userId, itemId, streamId, item, effectConfig, totalDuration, effectParams);
    }

    // Get effect configuration for an item
    getEffectConfig(item) {
        return this._registry.getEffectConfig(item);
    }

    // Get random position for effect placement
    getRandomPosition() {
        return this._registry.getRandomPosition();
    }

    // Cleanup an effect
    cleanupEffect(effectId) {
        return this._lifecycle.cleanupEffect(effectId);
    }

    // Cancel an effect immediately (used for buff expiry or streamer switching)
    async cancelEffect(effectId, reason = 'cancelled') {
        return this._lifecycle.cancelEffect(effectId, reason);
    }

    // Clear all active effects
    clearAllEffects() {
        return this._lifecycle.clearAllEffects();
    }

    // Force clear smoke bomb effects for a specific socket (e.g., former streamer)
    forceCleanupForSocket(socketId, reason = 'manual') {
        return this._lifecycle.forceCleanupForSocket(socketId, reason);
    }

    // Get active effects for a user
    getActiveEffectsForUser(userId) {
        const userEffects = [];
        this.activeEffects.forEach(effect => {
            if (effect.userId === userId) {
                userEffects.push(effect);
            }
        });
        return userEffects;
    }

    // Get all active effects
    getAllActiveEffects() {
        return Array.from(this.activeEffects.values());
    }

    // Get effect statistics
    getStats() {
        return {
            ...this.effectStats,
            activeEffects: Array.from(this.activeEffects.keys())
        };
    }

    // Handle socket connection for a client
    handleClientConnection(socket) {
        // Send current active effects to new viewer
        const activeEffects = this.getAllActiveEffects();
        if (activeEffects.length > 0) {
            socket.emit('canvas-effects-sync', { effects: activeEffects });
        }

        // Handle effect requests
        socket.on('request-effect-sync', () => {
            socket.emit('canvas-effects-sync', { effects: this.getAllActiveEffects() });
        });

        logger.debug(`🔌 CANVASFX: Client connected, sent ${activeEffects.length} active effects`);
    }

    // Lifecycle entry point — uniform name across services for the
    // bootstrap shutdown loop (PR 1.2). Delegates to the existing teardown.
    async stop() {
        this.shutdown();
    }

    // Shutdown cleanup
    shutdown() {
        if (this.streamerCheckInterval) {
            clearInterval(this.streamerCheckInterval);
            this.streamerCheckInterval = null;
        }

        this.activeEffects.clear();
        this.buffSyncedEffects.clear();
        logger.debug('🎨 CANVASFX: Service shutdown complete');
    }
}

module.exports = CanvasFxService;
