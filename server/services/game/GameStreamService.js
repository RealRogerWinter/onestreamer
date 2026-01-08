/**
 * GameStreamService - Controls game mode activation and integrates with stream system
 * Acts as a bridge between the game system and the existing streaming infrastructure
 */

const EventEmitter = require('events');

class GameStreamService extends EventEmitter {
    constructor(io, gameService, takeoverService = null) {
        super();
        this.io = io;
        this.gameService = gameService;
        this.takeoverService = takeoverService;
        this.isGameActive = false;

        // Special stream ID for game mode
        this.GAME_STREAM_ID = 'SYSTEM_GAME_STREAM';

        // Listen to game service events
        if (this.gameService) {
            this.gameService.on('game-started', () => {
                this.isGameActive = true;
                this.emit('game-mode-activated');
            });

            this.gameService.on('game-stopped', () => {
                this.isGameActive = false;
                this.emit('game-mode-deactivated');
            });
        }

        console.log('[GameStreamService] Initialized');
    }

    /**
     * Start the game stream
     * This will interrupt any current stream and prevent takeovers
     */
    async startGameStream(adminUserId) {
        if (this.isGameActive) {
            return { success: false, error: 'Game already active' };
        }

        try {
            // Force end any current stream
            if (this.takeoverService && typeof this.takeoverService.forceEndStream === 'function') {
                await this.takeoverService.forceEndStream();
            }

            // Broadcast that we're entering game mode
            if (this.io) {
                this.io.emit('stream-status', {
                    hasActiveStream: true,
                    streamerId: this.GAME_STREAM_ID,
                    streamType: 'game',
                    isGameMode: true,
                    startedBy: adminUserId
                });
            }

            // Start the actual game
            const result = await this.gameService.start(adminUserId);

            if (result.success) {
                this.isGameActive = true;
                console.log(`[GameStreamService] Game stream started by admin ${adminUserId}`);
            }

            return result;
        } catch (error) {
            console.error('[GameStreamService] Error starting game stream:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Stop the game stream
     */
    async stopGameStream(adminUserId) {
        if (!this.isGameActive) {
            return { success: false, error: 'No game active' };
        }

        try {
            // Stop the game
            const result = await this.gameService.stop(adminUserId);

            if (result.success) {
                this.isGameActive = false;

                // Broadcast that we're exiting game mode
                if (this.io) {
                    this.io.emit('stream-status', {
                        hasActiveStream: false,
                        streamerId: null,
                        streamType: null,
                        isGameMode: false
                    });
                }

                console.log(`[GameStreamService] Game stream stopped by admin ${adminUserId}`);
            }

            return result;
        } catch (error) {
            console.error('[GameStreamService] Error stopping game stream:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Check if stream takeover should be allowed
     * Called by TakeoverService
     */
    canTakeOver() {
        // When game is active, no one can take over
        return !this.isGameActive;
    }

    /**
     * Get the takeover denial reason if game is active
     */
    getTakeoverDenialReason() {
        if (this.isGameActive) {
            return {
                allowed: false,
                reason: 'GAME_MODE_ACTIVE',
                message: 'Cannot take over stream while game mode is active'
            };
        }
        return null;
    }

    /**
     * Check if the current "stream" is the game
     */
    isGameStream(streamerId) {
        return streamerId === this.GAME_STREAM_ID;
    }

    /**
     * Get game stream status
     */
    getStatus() {
        return {
            isActive: this.isGameActive,
            streamId: this.isGameActive ? this.GAME_STREAM_ID : null,
            gameStatus: this.gameService ? this.gameService.getStatus() : null
        };
    }

    /**
     * Get the special game stream ID
     */
    getGameStreamId() {
        return this.GAME_STREAM_ID;
    }
}

module.exports = GameStreamService;
