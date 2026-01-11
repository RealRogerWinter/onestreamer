/**
 * GameBroadcaster - Handles broadcasting game state updates to clients
 */

class GameBroadcaster {
    constructor(io) {
        this.io = io;
        this.GAME_ROOM = 'game-players';

        // Stats tracking
        this.broadcastCount = 0;
        this.lastBroadcastTime = 0;
    }

    /**
     * Broadcast state delta to all game players
     */
    broadcastDelta(stateDelta) {
        if (!this.io) return;

        this.io.to(this.GAME_ROOM).emit('game:state-update', {
            playerUpdates: stateDelta.playerUpdates || {},
            itemUpdates: stateDelta.itemUpdates || [],
            worldChanges: stateDelta.worldChanges || [],
            enemyUpdates: stateDelta.enemyUpdates || [],
            timestamp: Date.now()
        });

        this.broadcastCount++;
        this.lastBroadcastTime = Date.now();
    }

    /**
     * Send player state to a specific player (for reconciliation)
     */
    sendPlayerState(player) {
        if (!this.io || !player.socketId) return;

        this.io.to(player.socketId).emit('game:player-state', {
            id: player.id,
            x: Math.round(player.x * 100) / 100,
            y: Math.round(player.y * 100) / 100,
            velocityX: Math.round(player.velocityX * 100) / 100,
            velocityY: Math.round(player.velocityY * 100) / 100,
            direction: player.direction,
            inventory: player.inventory,
            lastInputSequence: player.lastInputSequence,
            timestamp: Date.now()
        });
    }

    /**
     * Send full state to a specific player (on join)
     */
    sendFullState(socketId, fullState) {
        if (!this.io) return;

        this.io.to(socketId).emit('game:full-state', {
            ...fullState,
            timestamp: Date.now()
        });
    }

    /**
     * Broadcast player joined event
     */
    broadcastPlayerJoined(player, excludeSocketId = null) {
        if (!this.io) return;

        const eventData = {
            id: player.id,
            username: player.username,
            x: player.x,
            y: player.y,
            direction: player.direction,
            spriteId: player.spriteId,
            color: player.color,
            timestamp: Date.now()
        };

        if (excludeSocketId) {
            this.io.to(this.GAME_ROOM).except(excludeSocketId).emit('game:player-joined', eventData);
        } else {
            this.io.to(this.GAME_ROOM).emit('game:player-joined', eventData);
        }
    }

    /**
     * Broadcast player left event
     */
    broadcastPlayerLeft(playerId) {
        if (!this.io) return;

        this.io.to(this.GAME_ROOM).emit('game:player-left', {
            id: playerId,
            timestamp: Date.now()
        });
    }

    /**
     * Broadcast item spawned event
     */
    broadcastItemSpawned(item) {
        if (!this.io) return;

        this.io.to(this.GAME_ROOM).emit('game:item-spawned', {
            id: item.id,
            type: item.type,
            x: item.x,
            y: item.y,
            data: item.data,
            timestamp: Date.now()
        });
    }

    /**
     * Broadcast item picked up event
     */
    broadcastItemPickup(playerId, itemId, item) {
        if (!this.io) return;

        this.io.to(this.GAME_ROOM).emit('game:item-pickup', {
            playerId,
            itemId,
            item,
            timestamp: Date.now()
        });
    }

    /**
     * Broadcast item removed event
     */
    broadcastItemRemoved(itemId) {
        if (!this.io) return;

        this.io.to(this.GAME_ROOM).emit('game:item-removed', {
            id: itemId,
            timestamp: Date.now()
        });
    }

    /**
     * Broadcast world change event
     */
    broadcastWorldChange(change) {
        if (!this.io) return;

        this.io.to(this.GAME_ROOM).emit('game:world-change', {
            ...change,
            timestamp: Date.now()
        });
    }

    /**
     * Broadcast game started event to all connected clients
     */
    broadcastGameStarted(startedBy) {
        if (!this.io) return;

        this.io.emit('game:started', {
            startedBy,
            timestamp: Date.now()
        });
    }

    /**
     * Broadcast game ended event to all connected clients
     */
    broadcastGameEnded(endedBy) {
        if (!this.io) return;

        this.io.emit('game:ended', {
            endedBy,
            timestamp: Date.now()
        });
    }

    /**
     * Send error to a specific socket
     */
    sendError(socketId, message, code = 'GAME_ERROR') {
        if (!this.io) return;

        this.io.to(socketId).emit('game:error', {
            message,
            code,
            timestamp: Date.now()
        });
    }

    /**
     * Send message to a specific player
     */
    sendToPlayer(playerId, event, data) {
        if (!this.io) return;

        // Find socket by player ID - need to look up in player manager
        // This is called with socketId directly in most cases
        this.io.to(playerId).emit(event, {
            ...data,
            timestamp: Date.now()
        });
    }

    /**
     * Broadcast to a specific room
     */
    broadcastToRoom(room, event, data) {
        if (!this.io) return;

        this.io.to(room).emit(event, data);
    }

    /**
     * Add socket to game room
     */
    addToGameRoom(socket) {
        socket.join(this.GAME_ROOM);
    }

    /**
     * Remove socket from game room
     */
    removeFromGameRoom(socket) {
        socket.leave(this.GAME_ROOM);
    }

    /**
     * Get number of sockets in game room
     */
    async getGameRoomSize() {
        if (!this.io) return 0;

        try {
            const sockets = await this.io.in(this.GAME_ROOM).fetchSockets();
            return sockets.length;
        } catch (error) {
            console.error('[GameBroadcaster] Error getting room size:', error);
            return 0;
        }
    }

    /**
     * Get broadcast statistics
     */
    getStats() {
        return {
            broadcastCount: this.broadcastCount,
            lastBroadcastTime: this.lastBroadcastTime,
            timeSinceLastBroadcast: Date.now() - this.lastBroadcastTime
        };
    }
}

module.exports = GameBroadcaster;
