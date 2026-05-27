/**
 * WorldManager - Manages the game world state, tiles, buildings, and persistence
 */

const EventEmitter = require('events');

const logger = require('../../bootstrap/logger').child({ svc: 'WorldManager' });
class WorldManager extends EventEmitter {
    constructor(db) {
        super();
        this.db = db;
        this.tiles = [];
        this.buildings = [];
        this.interactables = [];
        this.spawnPoints = [];
        this.changes = [];
        this.isLoaded = false;

        // World configuration
        this.config = {
            WORLD_WIDTH: 1600,   // pixels
            WORLD_HEIGHT: 1200,  // pixels
            TILE_SIZE: 32,
            DEFAULT_SPAWN: { x: 800, y: 600 }
        };
    }

    /**
     * Load world from database or generate default
     */
    async loadWorld() {
        if (this.isLoaded) return;

        try {
            if (this.db) {
                const savedWorld = await this.db.getAsync('SELECT * FROM game_world WHERE id = 1');

                if (savedWorld) {
                    this.tiles = JSON.parse(savedWorld.tiles);
                    this.buildings = JSON.parse(savedWorld.buildings);
                    this.spawnPoints = JSON.parse(savedWorld.spawn_points);
                    if (savedWorld.config) {
                        Object.assign(this.config, JSON.parse(savedWorld.config));
                    }
                    logger.debug('[WorldManager] Loaded world from database');
                } else {
                    this.generateDefaultWorld();
                    await this.saveWorld();
                    logger.debug('[WorldManager] Generated and saved new world');
                }
            } else {
                this.generateDefaultWorld();
                logger.debug('[WorldManager] Generated world (no database)');
            }

            this.buildInteractablesList();
            this.isLoaded = true;
        } catch (error) {
            logger.error('[WorldManager] Error loading world:', error);
            this.generateDefaultWorld();
            this.isLoaded = true;
        }
    }

    /**
     * Save world to database
     */
    async saveWorld() {
        if (!this.db) return;

        try {
            await this.db.runAsync(`
                INSERT OR REPLACE INTO game_world (id, tiles, buildings, spawn_points, config, updated_at)
                VALUES (1, ?, ?, ?, ?, datetime('now'))
            `, [
                JSON.stringify(this.tiles),
                JSON.stringify(this.buildings),
                JSON.stringify(this.spawnPoints),
                JSON.stringify(this.config)
            ]);
            logger.debug('[WorldManager] World saved to database');
        } catch (error) {
            logger.error('[WorldManager] Error saving world:', error);
        }
    }

    /**
     * Generate default world with basic terrain
     */
    generateDefaultWorld() {
        const tilesX = Math.ceil(this.config.WORLD_WIDTH / this.config.TILE_SIZE);
        const tilesY = Math.ceil(this.config.WORLD_HEIGHT / this.config.TILE_SIZE);

        // Initialize with grass
        this.tiles = Array(tilesY).fill(null).map((_, y) =>
            Array(tilesX).fill(null).map((_, x) => ({
                type: 'grass',
                walkable: true,
                variant: Math.floor(Math.random() * 3) // Visual variety
            }))
        );

        // Add terrain features
        this.generateTerrain(tilesX, tilesY);

        // Set spawn points
        this.spawnPoints = [
            { x: 800, y: 600, name: 'center' },
            { x: 200, y: 200, name: 'nw' },
            { x: 1400, y: 200, name: 'ne' },
            { x: 200, y: 1000, name: 'sw' },
            { x: 1400, y: 1000, name: 'se' }
        ];

        // Add some default structures
        this.buildings = [
            {
                id: 'fountain_center',
                type: 'fountain',
                x: 784,
                y: 584,
                width: 64,
                height: 64,
                walkable: false,
                interactable: false
            }
        ];
    }

    /**
     * Generate terrain features (paths, decorations, obstacles)
     */
    generateTerrain(tilesX, tilesY) {
        const centerX = Math.floor(tilesX / 2);
        const centerY = Math.floor(tilesY / 2);

        // Create cross-shaped paths through center
        for (let x = 0; x < tilesX; x++) {
            // Horizontal path
            if (this.tiles[centerY]) {
                this.tiles[centerY][x] = { type: 'path', walkable: true, variant: 0 };
            }
            if (this.tiles[centerY - 1]) {
                this.tiles[centerY - 1][x] = { type: 'path', walkable: true, variant: 0 };
            }
        }

        for (let y = 0; y < tilesY; y++) {
            // Vertical path
            if (this.tiles[y]) {
                this.tiles[y][centerX] = { type: 'path', walkable: true, variant: 0 };
                this.tiles[y][centerX - 1] = { type: 'path', walkable: true, variant: 0 };
            }
        }

        // Add some decorative water features in corners
        this.addWaterBody(2, 2, 4, 3);
        this.addWaterBody(tilesX - 6, 2, 4, 3);
        this.addWaterBody(2, tilesY - 5, 4, 3);
        this.addWaterBody(tilesX - 6, tilesY - 5, 4, 3);

        // Add some random trees/bushes
        for (let i = 0; i < 20; i++) {
            const x = Math.floor(Math.random() * tilesX);
            const y = Math.floor(Math.random() * tilesY);

            // Don't place on paths or water
            if (this.tiles[y] && this.tiles[y][x] &&
                this.tiles[y][x].type === 'grass') {
                // Check not too close to center
                const distFromCenter = Math.sqrt(
                    Math.pow(x - centerX, 2) + Math.pow(y - centerY, 2)
                );
                if (distFromCenter > 5) {
                    this.tiles[y][x] = {
                        type: 'tree',
                        walkable: false,
                        variant: Math.floor(Math.random() * 2)
                    };
                }
            }
        }
    }

    /**
     * Add a water body to the world
     */
    addWaterBody(startX, startY, width, height) {
        for (let y = startY; y < startY + height && y < this.tiles.length; y++) {
            for (let x = startX; x < startX + width && this.tiles[y] && x < this.tiles[y].length; x++) {
                this.tiles[y][x] = {
                    type: 'water',
                    walkable: false,
                    variant: 0
                };
            }
        }
    }

    /**
     * Get tiles data
     */
    getTiles() {
        return this.tiles;
    }

    /**
     * Get buildings data
     */
    getBuildings() {
        return this.buildings;
    }

    /**
     * Get world bounds
     */
    getBounds() {
        return {
            width: this.config.WORLD_WIDTH,
            height: this.config.WORLD_HEIGHT
        };
    }

    /**
     * Get tile size
     */
    getTileSize() {
        return this.config.TILE_SIZE;
    }

    /**
     * Get spawn points
     */
    getSpawnPoints() {
        return this.spawnPoints;
    }

    /**
     * Get random spawn point
     */
    getRandomSpawnPoint() {
        if (this.spawnPoints.length === 0) {
            return this.config.DEFAULT_SPAWN;
        }
        return this.spawnPoints[Math.floor(Math.random() * this.spawnPoints.length)];
    }

    /**
     * Get collidable objects for collision detection
     */
    getCollidables() {
        const collidables = [];

        // Add buildings
        this.buildings.forEach(b => {
            if (!b.walkable) {
                collidables.push({
                    type: 'building',
                    id: b.id,
                    x: b.x,
                    y: b.y,
                    width: b.width,
                    height: b.height
                });
            }
        });

        // Add non-walkable tiles
        this.tiles.forEach((row, y) => {
            row.forEach((tile, x) => {
                if (!tile.walkable) {
                    collidables.push({
                        type: 'tile',
                        tileType: tile.type,
                        x: x * this.config.TILE_SIZE,
                        y: y * this.config.TILE_SIZE,
                        width: this.config.TILE_SIZE,
                        height: this.config.TILE_SIZE
                    });
                }
            });
        });

        return collidables;
    }

    /**
     * Build list of interactable objects
     */
    buildInteractablesList() {
        this.interactables = this.buildings
            .filter(b => b.interactable)
            .map(b => ({
                id: b.id,
                x: b.x + b.width / 2,
                y: b.y + b.height / 2,
                radius: Math.max(b.width, b.height),
                type: b.type,
                data: b.data
            }));
    }

    /**
     * Get interactables near a position
     */
    getInteractablesNear(x, y, radius = 50) {
        return this.interactables.filter(i => {
            const dx = i.x - x;
            const dy = i.y - y;
            return Math.sqrt(dx * dx + dy * dy) < radius + i.radius;
        });
    }

    /**
     * Add a building to the world
     */
    addBuilding(buildingData) {
        const building = {
            id: buildingData.id || `building_${Date.now()}`,
            type: buildingData.type,
            x: buildingData.x,
            y: buildingData.y,
            width: buildingData.width || 64,
            height: buildingData.height || 64,
            walkable: buildingData.walkable || false,
            interactable: buildingData.interactable || false,
            ownerId: buildingData.ownerId,
            data: buildingData.data,
            createdAt: Date.now()
        };

        this.buildings.push(building);
        this.changes.push({ type: 'building-added', data: building });
        this.buildInteractablesList();

        this.emit('building-added', building);
        return building;
    }

    /**
     * Remove a building from the world
     */
    removeBuilding(buildingId) {
        const index = this.buildings.findIndex(b => b.id === buildingId);
        if (index === -1) return null;

        const building = this.buildings.splice(index, 1)[0];
        this.changes.push({ type: 'building-removed', data: { id: buildingId } });
        this.buildInteractablesList();

        this.emit('building-removed', building);
        return building;
    }

    /**
     * Update a tile
     */
    setTile(tileX, tileY, tileData) {
        if (this.tiles[tileY] && this.tiles[tileY][tileX]) {
            this.tiles[tileY][tileX] = { ...this.tiles[tileY][tileX], ...tileData };
            this.changes.push({
                type: 'tile-changed',
                data: { x: tileX, y: tileY, tile: this.tiles[tileY][tileX] }
            });
            this.emit('tile-changed', { x: tileX, y: tileY, tile: this.tiles[tileY][tileX] });
        }
    }

    /**
     * Check if a position is walkable
     */
    isWalkable(worldX, worldY) {
        const tileX = Math.floor(worldX / this.config.TILE_SIZE);
        const tileY = Math.floor(worldY / this.config.TILE_SIZE);

        // Check bounds
        if (tileY < 0 || tileY >= this.tiles.length ||
            tileX < 0 || tileX >= this.tiles[0].length) {
            return false;
        }

        // Check tile
        if (!this.tiles[tileY][tileX].walkable) {
            return false;
        }

        // Check buildings
        for (const building of this.buildings) {
            if (!building.walkable &&
                worldX >= building.x && worldX <= building.x + building.width &&
                worldY >= building.y && worldY <= building.y + building.height) {
                return false;
            }
        }

        return true;
    }

    /**
     * Get delta changes since last broadcast
     */
    getDelta() {
        const changes = [...this.changes];
        this.changes = [];
        return changes;
    }

    /**
     * Clear delta changes
     */
    clearChanges() {
        this.changes = [];
    }

    /**
     * Get full world state for new players
     */
    getFullState() {
        return {
            tiles: this.tiles,
            buildings: this.buildings,
            spawnPoints: this.spawnPoints,
            bounds: this.getBounds(),
            tileSize: this.config.TILE_SIZE
        };
    }

    /**
     * Get compact world state (just tile types, not full objects)
     */
    getCompactTiles() {
        return this.tiles.map(row =>
            row.map(tile => ({
                t: tile.type.charAt(0), // First letter as type code
                w: tile.walkable ? 1 : 0,
                v: tile.variant || 0
            }))
        );
    }
}

module.exports = WorldManager;
