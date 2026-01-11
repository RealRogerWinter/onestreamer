/**
 * PlayerManager - Manages player state, movement, and physics
 */

const EventEmitter = require('events');

class PlayerManager extends EventEmitter {
    constructor(db) {
        super();
        this.db = db;
        this.players = new Map(); // odId -> PlayerState
        this.socketToUser = new Map(); // socketId -> odId
        this.modifiedPlayers = new Set();

        // Physics constants
        this.PLAYER_SPEED = 150; // pixels per second
        this.PLAYER_SIZE = 32;

        // Combat constants
        this.MAX_HEALTH = 100;
        this.DAMAGE_COOLDOWN = 500; // ms between taking damage
        this.ATTACK_DAMAGE = 25;
        this.ATTACK_RANGE = 40;
        this.ATTACK_COOLDOWN = 300; // ms between attacks
    }

    /**
     * Create a new player in the game
     */
    createPlayer(userId, data) {
        const player = {
            id: String(userId),
            odId: userId,
            socketId: data.socketId,
            username: data.username,
            x: data.x,
            y: data.y,
            velocityX: 0,
            velocityY: 0,
            targetVelocityX: 0,
            targetVelocityY: 0,
            direction: 'down',
            spriteId: data.spriteId || 'player_default',
            color: data.color || this.getRandomColor(),
            inventory: data.inventory || [],
            lastInputSequence: 0,
            lastProcessedInput: 0,
            joinedAt: Date.now(),
            health: this.MAX_HEALTH,
            maxHealth: this.MAX_HEALTH,
            lastDamageTime: 0,
            lastAttackTime: 0
        };

        this.players.set(String(userId), player);
        this.socketToUser.set(data.socketId, String(userId));
        this.modifiedPlayers.add(String(userId));

        this.emit('player-created', player);
        return player;
    }

    /**
     * Remove a player from the game
     */
    removePlayer(userId) {
        const id = String(userId);
        const player = this.players.get(id);
        if (!player) return null;

        this.socketToUser.delete(player.socketId);
        this.players.delete(id);
        this.modifiedPlayers.delete(id);

        this.emit('player-removed', player);
        return player;
    }

    /**
     * Get player by user ID
     */
    getPlayer(userId) {
        return this.players.get(String(userId));
    }

    /**
     * Get player by socket ID
     */
    getPlayerBySocket(socketId) {
        const odId = this.socketToUser.get(socketId);
        return odId ? this.players.get(odId) : null;
    }

    /**
     * Get all players
     */
    getAllPlayers() {
        return Array.from(this.players.values());
    }

    /**
     * Get player count
     */
    getPlayerCount() {
        return this.players.size;
    }

    /**
     * Get all players state (for broadcasting)
     */
    getAllPlayersState() {
        const state = {};
        this.players.forEach((player, id) => {
            state[id] = this.getPlayerPublicState(player);
        });
        return state;
    }

    /**
     * Get public state for a player (what others see)
     */
    getPlayerPublicState(player) {
        return {
            id: player.id,
            username: player.username,
            x: Math.round(player.x * 100) / 100,
            y: Math.round(player.y * 100) / 100,
            velocityX: Math.round(player.velocityX * 100) / 100,
            velocityY: Math.round(player.velocityY * 100) / 100,
            direction: player.direction,
            spriteId: player.spriteId,
            color: player.color,
            health: player.health,
            maxHealth: player.maxHealth
        };
    }

    /**
     * Get full state for a player (for the player themselves)
     */
    getPlayerFullState(player) {
        return {
            ...this.getPlayerPublicState(player),
            inventory: player.inventory,
            lastInputSequence: player.lastInputSequence
        };
    }

    /**
     * Apply movement input from player
     */
    applyMovementInput(userId, direction, sequence) {
        const player = this.players.get(String(userId));
        if (!player) return;

        // Only process newer inputs
        if (sequence <= player.lastInputSequence) return;

        // Calculate target velocity from direction
        player.targetVelocityX = direction.x * this.PLAYER_SPEED;
        player.targetVelocityY = direction.y * this.PLAYER_SPEED;

        // Update direction for animation (only if moving significantly)
        if (Math.abs(direction.y) > 0.5 || Math.abs(direction.x) > 0.5) {
            if (Math.abs(direction.y) > Math.abs(direction.x)) {
                player.direction = direction.y < 0 ? 'up' : 'down';
            } else {
                player.direction = direction.x < 0 ? 'left' : 'right';
            }
        }

        player.lastInputSequence = sequence;
        this.modifiedPlayers.add(String(userId));
    }

    /**
     * Update physics for all players (called each tick)
     */
    updatePhysics(deltaTime) {
        this.players.forEach((player, userId) => {
            // Smoothly interpolate velocity towards target
            player.velocityX = player.targetVelocityX;
            player.velocityY = player.targetVelocityY;

            // Apply movement
            if (player.velocityX !== 0 || player.velocityY !== 0) {
                player.x += player.velocityX * deltaTime;
                player.y += player.velocityY * deltaTime;
                this.modifiedPlayers.add(userId);
            }
        });
    }

    /**
     * Resolve collision by moving player out of obstacle
     */
    resolveCollision(userId, resolution) {
        const player = this.players.get(String(userId));
        if (!player) return;

        player.x += resolution.x;
        player.y += resolution.y;

        // Stop velocity in collision direction
        if (resolution.x !== 0) player.velocityX = 0;
        if (resolution.y !== 0) player.velocityY = 0;

        this.modifiedPlayers.add(String(userId));
    }

    /**
     * Clamp player position to world bounds
     */
    clampToWorld(userId, worldBounds) {
        const player = this.players.get(String(userId));
        if (!player) return;

        const halfSize = this.PLAYER_SIZE / 2;
        let clamped = false;

        if (player.x < halfSize) {
            player.x = halfSize;
            player.velocityX = 0;
            clamped = true;
        } else if (player.x > worldBounds.width - halfSize) {
            player.x = worldBounds.width - halfSize;
            player.velocityX = 0;
            clamped = true;
        }

        if (player.y < halfSize) {
            player.y = halfSize;
            player.velocityY = 0;
            clamped = true;
        } else if (player.y > worldBounds.height - halfSize) {
            player.y = worldBounds.height - halfSize;
            player.velocityY = 0;
            clamped = true;
        }

        if (clamped) {
            this.modifiedPlayers.add(String(userId));
        }
    }

    /**
     * Add item to player inventory
     */
    addToInventory(userId, item) {
        const player = this.players.get(String(userId));
        if (!player) return false;

        player.inventory.push(item);
        this.modifiedPlayers.add(String(userId));
        this.emit('inventory-changed', { odId: userId, item, action: 'add' });
        return true;
    }

    /**
     * Remove item from player inventory
     */
    removeFromInventory(userId, itemId) {
        const player = this.players.get(String(userId));
        if (!player) return null;

        const index = player.inventory.findIndex(i => i.id === itemId);
        if (index === -1) return null;

        const item = player.inventory.splice(index, 1)[0];
        this.modifiedPlayers.add(String(userId));
        this.emit('inventory-changed', { userId, item, action: 'remove' });
        return item;
    }

    /**
     * Update player sprite
     */
    updateSprite(userId, spriteId) {
        const player = this.players.get(String(userId));
        if (!player) return;

        player.spriteId = spriteId;
        this.modifiedPlayers.add(String(userId));
    }

    /**
     * Apply damage to player
     * Returns true if player was killed
     */
    applyDamage(userId, amount) {
        const player = this.players.get(String(userId));
        if (!player) return false;

        const now = Date.now();
        // Check damage cooldown
        if (now - player.lastDamageTime < this.DAMAGE_COOLDOWN) {
            return false;
        }

        player.lastDamageTime = now;
        player.health -= amount;
        this.modifiedPlayers.add(String(userId));

        if (player.health <= 0) {
            player.health = 0;
            this.emit('player-killed', player);
            return true;
        }

        this.emit('player-damaged', { userId, damage: amount, health: player.health });
        return false;
    }

    /**
     * Heal player
     */
    heal(userId, amount) {
        const player = this.players.get(String(userId));
        if (!player) return;

        player.health = Math.min(player.health + amount, player.maxHealth);
        this.modifiedPlayers.add(String(userId));
        this.emit('player-healed', { userId, amount, health: player.health });
    }

    /**
     * Respawn player at spawn point
     */
    respawn(userId, spawnPoint) {
        const player = this.players.get(String(userId));
        if (!player) return;

        player.x = spawnPoint.x;
        player.y = spawnPoint.y;
        player.health = player.maxHealth;
        player.velocityX = 0;
        player.velocityY = 0;
        player.targetVelocityX = 0;
        player.targetVelocityY = 0;
        player.lastDamageTime = 0;

        this.modifiedPlayers.add(String(userId));
        this.emit('player-respawned', player);
    }

    /**
     * Check if player can attack (cooldown expired)
     */
    canAttack(userId) {
        const player = this.players.get(String(userId));
        if (!player) return false;

        const now = Date.now();
        return now - player.lastAttackTime >= this.ATTACK_COOLDOWN;
    }

    /**
     * Mark player as having attacked
     */
    markAttacked(userId) {
        const player = this.players.get(String(userId));
        if (player) {
            player.lastAttackTime = Date.now();
        }
    }

    /**
     * Check if there are modified players
     */
    hasChanges() {
        return this.modifiedPlayers.size > 0;
    }

    /**
     * Get modified players list
     */
    getModifiedPlayers() {
        return Array.from(this.modifiedPlayers)
            .map(id => this.players.get(id))
            .filter(Boolean);
    }

    /**
     * Get delta state (only changed players)
     */
    getDelta() {
        const delta = {};
        this.modifiedPlayers.forEach(id => {
            const player = this.players.get(id);
            if (player) {
                delta[id] = {
                    x: Math.round(player.x * 100) / 100,
                    y: Math.round(player.y * 100) / 100,
                    velocityX: Math.round(player.velocityX * 100) / 100,
                    velocityY: Math.round(player.velocityY * 100) / 100,
                    direction: player.direction,
                    lastInputSequence: player.lastInputSequence,
                    health: player.health,
                    maxHealth: player.maxHealth
                };
            }
        });
        return delta;
    }

    /**
     * Clear modification flags after broadcasting
     */
    clearModificationFlags() {
        this.modifiedPlayers.clear();
    }

    /**
     * Save player state to database
     */
    async savePlayerState(userId) {
        const player = this.players.get(String(userId));
        if (!player || !this.db) return;

        try {
            await this.db.runAsync(`
                INSERT OR REPLACE INTO game_player_state
                (user_id, x, y, sprite_id, inventory, stats, last_active)
                VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
            `, [
                player.userId,
                player.x,
                player.y,
                player.spriteId,
                JSON.stringify(player.inventory),
                JSON.stringify({})
            ]);
        } catch (error) {
            console.error('[PlayerManager] Error saving player state:', error);
        }
    }

    /**
     * Load player state from database
     */
    async loadPlayerState(userId) {
        if (!this.db) return null;

        try {
            const state = await this.db.getAsync(
                'SELECT * FROM game_player_state WHERE user_id = ?',
                [userId]
            );

            if (state) {
                return {
                    x: state.x,
                    y: state.y,
                    spriteId: state.sprite_id,
                    inventory: JSON.parse(state.inventory || '[]'),
                    stats: JSON.parse(state.stats || '{}')
                };
            }
        } catch (error) {
            console.error('[PlayerManager] Error loading player state:', error);
        }

        return null;
    }

    /**
     * Save all players state
     */
    async saveAllPlayers() {
        const promises = Array.from(this.players.keys()).map(userId =>
            this.savePlayerState(userId)
        );
        await Promise.all(promises);
    }

    /**
     * Get random color for player
     */
    getRandomColor() {
        const colors = [
            '#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4',
            '#feca57', '#ff9ff3', '#54a0ff', '#5f27cd',
            '#00d2d3', '#ff9f43', '#ee5253', '#10ac84'
        ];
        return colors[Math.floor(Math.random() * colors.length)];
    }
}

module.exports = PlayerManager;
