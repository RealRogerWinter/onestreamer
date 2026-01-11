/**
 * EnemyManager - Manages enemy state, AI, and combat
 */

const EventEmitter = require('events');

class EnemyManager extends EventEmitter {
    constructor() {
        super();
        this.enemies = new Map(); // id -> EnemyState
        this.modifiedEnemies = new Set();
        this.nextEnemyId = 1;

        // Enemy constants
        this.ENEMY_SPEED = 75; // pixels per second
        this.ENEMY_RADIUS = 14;
        this.ENEMY_DAMAGE = 10;
        this.ATTACK_COOLDOWN = 1000; // ms between enemy attacks

        // Enemy type definitions
        this.ENEMY_TYPES = {
            slime: {
                maxHealth: 50,
                speed: 75,
                damage: 10,
                color: '#e74c3c'
            }
        };
    }

    /**
     * Spawn a new enemy
     */
    spawnEnemy(type, x, y) {
        const typeData = this.ENEMY_TYPES[type] || this.ENEMY_TYPES.slime;
        const id = `enemy_${this.nextEnemyId++}`;

        const enemy = {
            id,
            type,
            x,
            y,
            velocityX: 0,
            velocityY: 0,
            direction: 'down',
            health: typeData.maxHealth,
            maxHealth: typeData.maxHealth,
            damage: typeData.damage,
            speed: typeData.speed,
            lastAttackTime: 0,
            spawnedAt: Date.now()
        };

        this.enemies.set(id, enemy);
        this.modifiedEnemies.add(id);

        this.emit('enemy-spawned', enemy);
        return enemy;
    }

    /**
     * Remove an enemy
     */
    removeEnemy(id) {
        const enemy = this.enemies.get(id);
        if (!enemy) return null;

        this.enemies.delete(id);
        this.modifiedEnemies.delete(id);

        this.emit('enemy-removed', enemy);
        return enemy;
    }

    /**
     * Get enemy by ID
     */
    getEnemy(id) {
        return this.enemies.get(id);
    }

    /**
     * Get all enemies
     */
    getAllEnemies() {
        return Array.from(this.enemies.values());
    }

    /**
     * Get enemy count
     */
    getEnemyCount() {
        return this.enemies.size;
    }

    /**
     * Update enemy AI - chase nearest player
     */
    updateAI(players, deltaTime) {
        if (players.length === 0) {
            // No players, enemies stop moving
            this.enemies.forEach(enemy => {
                enemy.velocityX = 0;
                enemy.velocityY = 0;
            });
            return;
        }

        this.enemies.forEach((enemy, id) => {
            // Find nearest player
            let nearestPlayer = null;
            let nearestDistance = Infinity;

            for (const player of players) {
                const dx = player.x - enemy.x;
                const dy = player.y - enemy.y;
                const distance = Math.sqrt(dx * dx + dy * dy);

                if (distance < nearestDistance) {
                    nearestDistance = distance;
                    nearestPlayer = player;
                }
            }

            if (nearestPlayer && nearestDistance > 20) {
                // Move towards player
                const dx = nearestPlayer.x - enemy.x;
                const dy = nearestPlayer.y - enemy.y;
                const distance = Math.sqrt(dx * dx + dy * dy);

                // Normalize and apply speed
                enemy.velocityX = (dx / distance) * enemy.speed;
                enemy.velocityY = (dy / distance) * enemy.speed;

                // Update direction for rendering
                if (Math.abs(dy) > Math.abs(dx)) {
                    enemy.direction = dy < 0 ? 'up' : 'down';
                } else {
                    enemy.direction = dx < 0 ? 'left' : 'right';
                }

                this.modifiedEnemies.add(id);
            } else {
                // Close enough, stop moving
                enemy.velocityX = 0;
                enemy.velocityY = 0;
            }
        });
    }

    /**
     * Update physics for all enemies
     */
    updatePhysics(deltaTime) {
        this.enemies.forEach((enemy, id) => {
            if (enemy.velocityX !== 0 || enemy.velocityY !== 0) {
                enemy.x += enemy.velocityX * deltaTime;
                enemy.y += enemy.velocityY * deltaTime;
                this.modifiedEnemies.add(id);
            }
        });
    }

    /**
     * Resolve collision by moving enemy out of obstacle
     */
    resolveCollision(id, resolution) {
        const enemy = this.enemies.get(id);
        if (!enemy) return;

        enemy.x += resolution.x;
        enemy.y += resolution.y;

        // Stop velocity in collision direction
        if (resolution.x !== 0) enemy.velocityX = 0;
        if (resolution.y !== 0) enemy.velocityY = 0;

        this.modifiedEnemies.add(id);
    }

    /**
     * Clamp enemy to world bounds
     */
    clampToWorld(id, worldBounds) {
        const enemy = this.enemies.get(id);
        if (!enemy) return;

        const halfSize = this.ENEMY_RADIUS;
        let clamped = false;

        if (enemy.x < halfSize) {
            enemy.x = halfSize;
            enemy.velocityX = 0;
            clamped = true;
        } else if (enemy.x > worldBounds.width - halfSize) {
            enemy.x = worldBounds.width - halfSize;
            enemy.velocityX = 0;
            clamped = true;
        }

        if (enemy.y < halfSize) {
            enemy.y = halfSize;
            enemy.velocityY = 0;
            clamped = true;
        } else if (enemy.y > worldBounds.height - halfSize) {
            enemy.y = worldBounds.height - halfSize;
            enemy.velocityY = 0;
            clamped = true;
        }

        if (clamped) {
            this.modifiedEnemies.add(id);
        }
    }

    /**
     * Apply damage to enemy
     * Returns true if enemy was killed
     */
    applyDamage(id, amount) {
        const enemy = this.enemies.get(id);
        if (!enemy) return false;

        enemy.health -= amount;
        this.modifiedEnemies.add(id);

        if (enemy.health <= 0) {
            this.removeEnemy(id);
            return true;
        }

        this.emit('enemy-damaged', { id, damage: amount, health: enemy.health });
        return false;
    }

    /**
     * Check if enemy can attack (cooldown expired)
     */
    canAttack(id) {
        const enemy = this.enemies.get(id);
        if (!enemy) return false;

        const now = Date.now();
        return now - enemy.lastAttackTime >= this.ATTACK_COOLDOWN;
    }

    /**
     * Mark enemy as having attacked
     */
    markAttacked(id) {
        const enemy = this.enemies.get(id);
        if (enemy) {
            enemy.lastAttackTime = Date.now();
        }
    }

    /**
     * Get enemy public state (for broadcasting)
     */
    getEnemyPublicState(enemy) {
        return {
            id: enemy.id,
            type: enemy.type,
            x: Math.round(enemy.x * 100) / 100,
            y: Math.round(enemy.y * 100) / 100,
            velocityX: Math.round(enemy.velocityX * 100) / 100,
            velocityY: Math.round(enemy.velocityY * 100) / 100,
            direction: enemy.direction,
            health: enemy.health,
            maxHealth: enemy.maxHealth
        };
    }

    /**
     * Get all enemies state (for broadcasting)
     */
    getAllEnemiesState() {
        return Array.from(this.enemies.values()).map(e => this.getEnemyPublicState(e));
    }

    /**
     * Get delta state (only changed enemies)
     */
    getDelta() {
        const updates = [];
        this.modifiedEnemies.forEach(id => {
            const enemy = this.enemies.get(id);
            if (enemy) {
                updates.push({
                    type: 'moved',
                    enemyId: id,
                    enemy: this.getEnemyPublicState(enemy)
                });
            }
        });
        return updates;
    }

    /**
     * Check if there are modified enemies
     */
    hasChanges() {
        return this.modifiedEnemies.size > 0;
    }

    /**
     * Clear modification flags after broadcasting
     */
    clearModificationFlags() {
        this.modifiedEnemies.clear();
    }

    /**
     * Clear all enemies
     */
    clear() {
        this.enemies.clear();
        this.modifiedEnemies.clear();
    }
}

module.exports = EnemyManager;
