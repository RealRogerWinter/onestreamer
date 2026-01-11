/**
 * GameService - Main orchestrator for the multiplayer game system
 */

const EventEmitter = require('events');
const GameLoopManager = require('./GameLoopManager');
const PlayerManager = require('./PlayerManager');
const EnemyManager = require('./EnemyManager');
const WorldManager = require('./WorldManager');
const CollisionManager = require('./CollisionManager');
const GameBroadcaster = require('./GameBroadcaster');

class GameService extends EventEmitter {
    constructor(io, db) {
        super();
        this.io = io;
        this.db = db;
        this.isActive = false;
        this.currentSessionId = null;
        this.startedBy = null;
        this.startedAt = null;
        this.peakPlayers = 0;
        this.totalPlayers = 0;

        // Initialize managers
        this.worldManager = new WorldManager(db);
        this.playerManager = new PlayerManager(db);
        this.enemyManager = new EnemyManager();
        this.collisionManager = new CollisionManager();
        this.broadcaster = new GameBroadcaster(io);
        this.gameLoop = new GameLoopManager(this.tick.bind(this));

        // Item spawning configuration
        this.itemSpawnConfig = {
            enabled: true,
            interval: 30000, // 30 seconds
            maxItems: 20,
            types: ['coin', 'gem', 'powerup']
        };
        this.lastItemSpawn = 0;
        this.worldItems = new Map(); // id -> item

        // Enemy spawning configuration
        this.enemySpawnConfig = {
            enabled: true,
            interval: 15000, // 15 seconds
            maxEnemies: 2
        };
        this.lastEnemySpawn = 0;

        console.log('[GameService] Initialized');
    }

    /**
     * Initialize the game service (load world, etc.)
     */
    async initialize() {
        try {
            await this.worldManager.loadWorld();
            console.log('[GameService] World loaded successfully');
            this.emit('initialized');
        } catch (error) {
            console.error('[GameService] Initialization error:', error);
            throw error;
        }
    }

    /**
     * Start the game
     */
    async start(adminUserId = null) {
        if (this.isActive) {
            console.log('[GameService] Game already active');
            return { success: false, error: 'Game already active' };
        }

        try {
            // Ensure world is loaded
            if (!this.worldManager.isLoaded) {
                await this.worldManager.loadWorld();
            }

            // Create game session
            this.currentSessionId = await this.createGameSession(adminUserId);
            this.isActive = true;
            this.startedBy = adminUserId;
            this.startedAt = Date.now();
            this.peakPlayers = 0;
            this.totalPlayers = 0;

            // Start game loop
            this.gameLoop.start();

            // Broadcast game started
            this.broadcaster.broadcastGameStarted(adminUserId);

            console.log(`[GameService] Game started by user ${adminUserId}`);
            this.emit('game-started', { sessionId: this.currentSessionId, startedBy: adminUserId });

            return { success: true, sessionId: this.currentSessionId };
        } catch (error) {
            console.error('[GameService] Error starting game:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Stop the game
     */
    async stop(adminUserId = null) {
        if (!this.isActive) {
            return { success: false, error: 'No game active' };
        }

        try {
            // Stop game loop
            this.gameLoop.stop();

            // Save all player states
            await this.playerManager.saveAllPlayers();

            // Save world state
            await this.worldManager.saveWorld();

            // End game session
            await this.endGameSession(adminUserId);

            // Broadcast game ended
            this.broadcaster.broadcastGameEnded(adminUserId);

            // Disconnect all players gracefully
            const players = this.playerManager.getAllPlayers();
            for (const player of players) {
                this.handlePlayerLeave(player.id, player.socketId);
            }

            // Clear items and enemies
            this.worldItems.clear();
            this.enemyManager.clear();

            this.isActive = false;
            const sessionId = this.currentSessionId;
            this.currentSessionId = null;

            console.log(`[GameService] Game stopped by user ${adminUserId}`);
            this.emit('game-stopped', { sessionId, endedBy: adminUserId });

            return { success: true };
        } catch (error) {
            console.error('[GameService] Error stopping game:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Main game tick - called 20 times per second
     */
    tick(deltaTime, tickCount) {
        if (!this.isActive) return;

        try {
            const bounds = this.worldManager.getBounds();
            const players = this.playerManager.getAllPlayers();
            const enemies = this.enemyManager.getAllEnemies();

            // 1. Update physics for all players
            this.playerManager.updatePhysics(deltaTime);

            // 2. Update enemy AI and physics
            this.enemyManager.updateAI(players, deltaTime);
            this.enemyManager.updatePhysics(deltaTime);

            // 3. Clamp players to world bounds
            for (const player of players) {
                this.playerManager.clampToWorld(player.id, bounds);
            }

            // 4. Check enemy-wall collisions and resolve them
            const collidables = this.worldManager.getCollidables();
            for (const enemy of enemies) {
                const enemyWallCollision = this.collisionManager.checkEnemyWallCollisions(enemy, collidables);
                if (enemyWallCollision) {
                    this.enemyManager.resolveCollision(enemy.id, enemyWallCollision);
                }
            }

            // 5. Clamp enemies to world bounds
            for (const enemy of enemies) {
                this.enemyManager.clampToWorld(enemy.id, bounds);
            }

            // 6. Check player collisions
            const collisions = this.collisionManager.checkAll(
                players,
                this.worldManager.getCollidables(),
                Array.from(this.worldItems.values())
            );

            // 6. Handle collisions
            this.handleCollisions(collisions);

            // 7. Check enemy-player collisions for damage
            const enemyCollisions = this.collisionManager.checkEnemyCollisions(players, enemies);
            this.handleEnemyCollisions(enemyCollisions);

            // 8. Spawn items periodically
            this.updateItemSpawns(deltaTime);

            // 9. Spawn enemies periodically
            this.updateEnemySpawns(deltaTime);

            // Debug: Log enemy count every 100 ticks (5 seconds)
            if (tickCount % 100 === 0) {
                console.log('[GameService] Tick', tickCount, '- Players:', this.playerManager.getPlayerCount(), 'Enemies:', this.enemyManager.getEnemyCount());
            }

            // 10. Broadcast state delta (every tick)
            const stateDelta = this.getStateDelta();
            if (stateDelta.hasChanges) {
                this.broadcaster.broadcastDelta(stateDelta);
            }

            // 11. Send individual player states for reconciliation (every 3 ticks)
            if (tickCount % 3 === 0) {
                for (const player of this.playerManager.getModifiedPlayers()) {
                    this.broadcaster.sendPlayerState(player);
                }
            }

            // 12. Clear modification flags
            this.playerManager.clearModificationFlags();
            this.enemyManager.clearModificationFlags();
            this.worldManager.clearChanges();

            // 13. Update peak player count
            const currentCount = this.playerManager.getPlayerCount();
            if (currentCount > this.peakPlayers) {
                this.peakPlayers = currentCount;
            }
        } catch (error) {
            console.error('[GameService] Error in tick:', error);
        }
    }

    /**
     * Handle player joining the game
     */
    async handlePlayerJoin(socket, userId, userData) {
        if (!this.isActive) {
            this.broadcaster.sendError(socket.id, 'Game not active', 'GAME_NOT_ACTIVE');
            return null;
        }

        // Check if player already in game
        const existingPlayer = this.playerManager.getPlayer(userId);
        if (existingPlayer) {
            // Update socket ID and return existing player
            existingPlayer.socketId = socket.id;
            this.playerManager.socketToUser.set(socket.id, String(userId));
            this.broadcaster.addToGameRoom(socket);
            this.broadcaster.sendFullState(socket.id, this.getFullState());
            return existingPlayer;
        }

        // Try to load saved state
        const savedState = await this.playerManager.loadPlayerState(userId);

        // Get spawn point
        const spawnPoint = savedState ?
            { x: savedState.x, y: savedState.y } :
            this.worldManager.getRandomSpawnPoint();

        // Create player
        const player = this.playerManager.createPlayer(userId, {
            socketId: socket.id,
            username: userData.username || `Player${userId}`,
            x: spawnPoint.x,
            y: spawnPoint.y,
            spriteId: savedState?.spriteId || this.getRandomSprite(),
            color: userData.chatColor || this.playerManager.getRandomColor(),
            inventory: savedState?.inventory || []
        });

        // Join game room
        this.broadcaster.addToGameRoom(socket);

        // Send full state to new player
        this.broadcaster.sendFullState(socket.id, this.getFullState());

        // Broadcast new player to others
        this.broadcaster.broadcastPlayerJoined(player, socket.id);

        // Track player session
        await this.recordPlayerSession(userId);
        this.totalPlayers++;

        console.log(`[GameService] Player joined: ${userData.username} (${userId})`);
        this.emit('player-joined', { player, userId });

        return player;
    }

    /**
     * Handle player leaving the game
     */
    async handlePlayerLeave(userId, socketId) {
        const player = this.playerManager.getPlayer(userId);
        if (!player) return;

        // Save player state
        await this.playerManager.savePlayerState(userId);

        // Remove from game
        this.playerManager.removePlayer(userId);

        // Remove from room if we have socket
        if (socketId && this.io) {
            const socket = this.io.sockets.sockets.get(socketId);
            if (socket) {
                this.broadcaster.removeFromGameRoom(socket);
            }
        }

        // Broadcast player left
        this.broadcaster.broadcastPlayerLeft(userId);

        console.log(`[GameService] Player left: ${userId}`);
        this.emit('player-left', { userId });
    }

    /**
     * Handle player input
     */
    handlePlayerInput(userId, input) {
        if (!this.isActive) return;

        const player = this.playerManager.getPlayer(userId);
        if (!player) return;

        switch (input.type) {
            case 'movement':
                this.playerManager.applyMovementInput(userId, input.direction, input.sequence);
                break;
            case 'action':
                this.handlePlayerAction(userId, input.action);
                break;
        }
    }

    /**
     * Handle player action (interact, use item, attack, etc.)
     */
    handlePlayerAction(userId, action) {
        const player = this.playerManager.getPlayer(userId);
        if (!player) return;

        switch (action.type) {
            case 'interact':
                this.handleInteraction(userId);
                break;
            case 'use-item':
                this.handleItemUse(userId, action.itemId);
                break;
            case 'primary':
                this.handlePlayerAttack(userId);
                break;
        }
    }

    /**
     * Handle player attack
     */
    handlePlayerAttack(userId) {
        console.log('[GameService] Player attack triggered by:', userId);
        const player = this.playerManager.getPlayer(userId);
        if (!player) {
            console.log('[GameService] Player not found for attack');
            return;
        }

        // Check attack cooldown
        if (!this.playerManager.canAttack(userId)) {
            console.log('[GameService] Attack on cooldown');
            return;
        }

        // Mark as attacked
        this.playerManager.markAttacked(userId);
        console.log('[GameService] Attack executed, checking for enemies');

        // Check for enemies in attack range
        const enemies = this.enemyManager.getAllEnemies();
        const hits = this.collisionManager.checkAttackHits(player, enemies);

        // Apply damage to hit enemies
        for (const enemyId of hits) {
            const killed = this.enemyManager.applyDamage(enemyId, this.playerManager.ATTACK_DAMAGE);
            if (killed) {
                // Broadcast enemy killed
                this.broadcaster.broadcastToRoom('game-players', 'game:enemy-killed', { enemyId });
                this.emit('enemy-killed', { playerId: userId, enemyId });
            }
        }
    }

    /**
     * Handle player interaction with world
     */
    handleInteraction(userId) {
        const player = this.playerManager.getPlayer(userId);
        if (!player) return;

        // Check for nearby interactables
        const nearbyInteractables = this.worldManager.getInteractablesNear(
            player.x, player.y, 50
        );

        if (nearbyInteractables.length > 0) {
            const closest = nearbyInteractables[0];
            this.emit('interaction', { userId, interactable: closest });
        }
    }

    /**
     * Handle item use
     */
    handleItemUse(userId, itemId) {
        const item = this.playerManager.removeFromInventory(userId, itemId);
        if (item) {
            this.emit('item-used', { userId, item });
        }
    }

    /**
     * Handle collision results
     */
    handleCollisions(collisions) {
        // Handle wall collisions
        for (const { playerId, resolution } of collisions.wallCollisions) {
            this.playerManager.resolveCollision(playerId, resolution);
        }

        // Handle item pickups
        for (const { playerId, itemId, item } of collisions.itemPickups) {
            if (this.worldItems.has(itemId)) {
                const pickedItem = this.worldItems.get(itemId);
                this.worldItems.delete(itemId);

                // Add to player inventory
                this.playerManager.addToInventory(playerId, {
                    id: pickedItem.id,
                    type: pickedItem.type,
                    data: pickedItem.data
                });

                // Broadcast pickup
                this.broadcaster.broadcastItemPickup(playerId, itemId, pickedItem);
                this.broadcaster.broadcastItemRemoved(itemId);

                this.emit('item-pickup', { playerId, item: pickedItem });
            }
        }
    }

    /**
     * Handle enemy-player collisions (enemies damage players)
     */
    handleEnemyCollisions(collisions) {
        for (const { playerId, enemyId, enemy } of collisions) {
            // Check if enemy can attack
            if (!this.enemyManager.canAttack(enemyId)) continue;

            // Apply damage to player
            const killed = this.playerManager.applyDamage(playerId, enemy.damage);
            this.enemyManager.markAttacked(enemyId);

            // Broadcast damage
            this.broadcaster.broadcastToRoom('game-players', 'game:player-damaged', {
                playerId,
                damage: enemy.damage,
                health: this.playerManager.getPlayer(playerId)?.health || 0
            });

            if (killed) {
                // Respawn player
                const spawnPoint = this.worldManager.getRandomSpawnPoint();
                this.playerManager.respawn(playerId, spawnPoint);

                this.broadcaster.broadcastToRoom('game-players', 'game:player-respawned', {
                    playerId,
                    x: spawnPoint.x,
                    y: spawnPoint.y
                });
            }
        }
    }

    /**
     * Update enemy spawning
     */
    updateEnemySpawns(deltaTime) {
        if (!this.enemySpawnConfig.enabled) return;

        const now = Date.now();
        if (now - this.lastEnemySpawn < this.enemySpawnConfig.interval) return;
        if (this.enemyManager.getEnemyCount() >= this.enemySpawnConfig.maxEnemies) return;
        if (this.playerManager.getPlayerCount() === 0) return; // No players, no enemies

        console.log('[GameService] Spawning enemy...');
        // Spawn a slime enemy
        const enemy = this.spawnEnemy('slime');
        if (enemy) {
            console.log('[GameService] Enemy spawned:', enemy.id, 'at', enemy.x, enemy.y);
            this.lastEnemySpawn = now;
        }
    }

    /**
     * Spawn an enemy in the world
     */
    spawnEnemy(type) {
        const bounds = this.worldManager.getBounds();

        // Find a walkable position away from players
        let attempts = 0;
        let x, y;
        do {
            x = Math.random() * (bounds.width - 100) + 50;
            y = Math.random() * (bounds.height - 100) + 50;
            attempts++;
        } while (!this.worldManager.isWalkable(x, y) && attempts < 20);

        if (attempts >= 20) return null;

        const enemy = this.enemyManager.spawnEnemy(type, x, y);

        // Broadcast enemy spawned
        this.broadcaster.broadcastToRoom('game-players', 'game:enemy-spawned', {
            enemy: this.enemyManager.getEnemyPublicState(enemy)
        });

        return enemy;
    }

    /**
     * Update item spawning
     */
    updateItemSpawns(deltaTime) {
        if (!this.itemSpawnConfig.enabled) return;

        const now = Date.now();
        if (now - this.lastItemSpawn < this.itemSpawnConfig.interval) return;
        if (this.worldItems.size >= this.itemSpawnConfig.maxItems) return;

        // Spawn a random item
        const item = this.spawnRandomItem();
        if (item) {
            this.lastItemSpawn = now;
        }
    }

    /**
     * Spawn a random item in the world
     */
    spawnRandomItem() {
        const bounds = this.worldManager.getBounds();
        const types = this.itemSpawnConfig.types;
        const type = types[Math.floor(Math.random() * types.length)];

        // Find a walkable position
        let attempts = 0;
        let x, y;
        do {
            x = Math.random() * (bounds.width - 100) + 50;
            y = Math.random() * (bounds.height - 100) + 50;
            attempts++;
        } while (!this.worldManager.isWalkable(x, y) && attempts < 20);

        if (attempts >= 20) return null;

        const item = {
            id: `item_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            type: type,
            x: x,
            y: y,
            data: this.getItemData(type),
            spawnedAt: Date.now()
        };

        this.worldItems.set(item.id, item);
        this.broadcaster.broadcastItemSpawned(item);

        return item;
    }

    /**
     * Get item data by type
     */
    getItemData(type) {
        const itemData = {
            coin: { value: 10, sprite: 'coin' },
            gem: { value: 50, sprite: 'gem' },
            powerup: { effect: 'speed', duration: 10000, sprite: 'powerup' }
        };
        return itemData[type] || { value: 1 };
    }

    /**
     * Get full game state (for new players)
     */
    getFullState() {
        const enemies = this.enemyManager.getAllEnemiesState();
        console.log('[GameService] getFullState - enemies:', enemies.length, enemies);
        return {
            players: this.playerManager.getAllPlayersState(),
            world: this.worldManager.getFullState(),
            items: Array.from(this.worldItems.values()),
            enemies: enemies,
            sessionId: this.currentSessionId,
            startedAt: this.startedAt
        };
    }

    /**
     * Get state delta (for tick updates)
     */
    getStateDelta() {
        const playerDelta = this.playerManager.getDelta();
        const worldDelta = this.worldManager.getDelta();
        const enemyDelta = this.enemyManager.getDelta();

        return {
            hasChanges: Object.keys(playerDelta).length > 0 || worldDelta.length > 0 || enemyDelta.length > 0,
            playerUpdates: playerDelta,
            worldChanges: worldDelta,
            itemUpdates: [],
            enemyUpdates: enemyDelta
        };
    }

    /**
     * Get game status
     */
    getStatus() {
        return {
            isActive: this.isActive,
            sessionId: this.currentSessionId,
            playerCount: this.playerManager.getPlayerCount(),
            peakPlayers: this.peakPlayers,
            totalPlayers: this.totalPlayers,
            startedAt: this.startedAt,
            startedBy: this.startedBy,
            uptime: this.startedAt ? Date.now() - this.startedAt : 0,
            itemCount: this.worldItems.size,
            loopStats: this.gameLoop.getPerformanceStats()
        };
    }

    /**
     * Check if game can be taken over (always false when active)
     */
    canTakeOver() {
        return !this.isActive;
    }

    /**
     * Get random sprite for new player
     */
    getRandomSprite() {
        const sprites = ['player_default', 'player_blue', 'player_green', 'player_red'];
        return sprites[Math.floor(Math.random() * sprites.length)];
    }

    /**
     * Create game session in database
     */
    async createGameSession(startedBy) {
        if (!this.db) return Date.now();

        try {
            const result = await this.db.runAsync(`
                INSERT INTO game_sessions (started_by, started_at)
                VALUES (?, datetime('now'))
            `, [startedBy]);
            return result.id;
        } catch (error) {
            console.error('[GameService] Error creating game session:', error);
            return Date.now();
        }
    }

    /**
     * End game session in database
     */
    async endGameSession(endedBy) {
        if (!this.db || !this.currentSessionId) return;

        try {
            await this.db.runAsync(`
                UPDATE game_sessions
                SET ended_at = datetime('now'),
                    ended_by = ?,
                    peak_players = ?,
                    total_players = ?
                WHERE id = ?
            `, [endedBy, this.peakPlayers, this.totalPlayers, this.currentSessionId]);
        } catch (error) {
            console.error('[GameService] Error ending game session:', error);
        }
    }

    /**
     * Record player session participation
     */
    async recordPlayerSession(userId) {
        if (!this.db || !this.currentSessionId) return;

        try {
            await this.db.runAsync(`
                INSERT INTO game_player_sessions (session_id, user_id, joined_at)
                VALUES (?, ?, datetime('now'))
            `, [this.currentSessionId, userId]);
        } catch (error) {
            console.error('[GameService] Error recording player session:', error);
        }
    }
}

module.exports = GameService;
