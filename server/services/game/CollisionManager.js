/**
 * CollisionManager - Handles collision detection between players, world, and items
 */

class CollisionManager {
    constructor() {
        this.PLAYER_RADIUS = 14; // Collision radius for players
        this.PICKUP_RADIUS = 24; // Radius for item pickups
        this.ENEMY_RADIUS = 14; // Collision radius for enemies
        this.ATTACK_RANGE = 40; // Range of player attack
    }

    /**
     * Check all collisions for the current tick
     * Returns collision events to be processed
     */
    checkAll(players, collidables, items) {
        const result = {
            wallCollisions: [],
            itemPickups: [],
            playerCollisions: []
        };

        // Check each player
        for (const player of players) {
            // Check wall/obstacle collisions
            const wallCollision = this.checkWallCollisions(player, collidables);
            if (wallCollision) {
                result.wallCollisions.push({
                    playerId: player.id,
                    resolution: wallCollision
                });
            }

            // Check item pickups
            for (const item of items) {
                if (this.checkItemPickup(player, item)) {
                    result.itemPickups.push({
                        playerId: player.id,
                        itemId: item.id,
                        item: item
                    });
                }
            }
        }

        // Check player-player collisions (optional, for pushing)
        // result.playerCollisions = this.checkPlayerCollisions(players);

        return result;
    }

    /**
     * Check if player collides with any walls/obstacles
     * Returns resolution vector or null
     */
    checkWallCollisions(player, collidables) {
        let totalResolutionX = 0;
        let totalResolutionY = 0;
        let hasCollision = false;

        for (const obstacle of collidables) {
            const collision = this.checkCircleRectCollision(
                player.x, player.y, this.PLAYER_RADIUS,
                obstacle.x, obstacle.y, obstacle.width, obstacle.height
            );

            if (collision) {
                totalResolutionX += collision.x;
                totalResolutionY += collision.y;
                hasCollision = true;
            }
        }

        if (hasCollision) {
            return { x: totalResolutionX, y: totalResolutionY };
        }

        return null;
    }

    /**
     * Check circle-rectangle collision
     * Returns resolution vector to push circle out of rectangle
     */
    checkCircleRectCollision(circleX, circleY, circleRadius, rectX, rectY, rectWidth, rectHeight) {
        // Find the closest point on the rectangle to the circle center
        const closestX = Math.max(rectX, Math.min(circleX, rectX + rectWidth));
        const closestY = Math.max(rectY, Math.min(circleY, rectY + rectHeight));

        // Calculate distance from circle center to closest point
        const distanceX = circleX - closestX;
        const distanceY = circleY - closestY;
        const distanceSquared = distanceX * distanceX + distanceY * distanceY;

        // Check if collision occurred
        if (distanceSquared < circleRadius * circleRadius) {
            const distance = Math.sqrt(distanceSquared);

            // Calculate push-out direction
            if (distance === 0) {
                // Circle center is inside rectangle, push out in the shortest direction
                const centerX = rectX + rectWidth / 2;
                const centerY = rectY + rectHeight / 2;
                const dx = circleX - centerX;
                const dy = circleY - centerY;

                if (Math.abs(dx) > Math.abs(dy)) {
                    return { x: Math.sign(dx) * (rectWidth / 2 + circleRadius), y: 0 };
                } else {
                    return { x: 0, y: Math.sign(dy) * (rectHeight / 2 + circleRadius) };
                }
            }

            // Push circle out by the overlap amount
            const overlap = circleRadius - distance;
            return {
                x: (distanceX / distance) * overlap,
                y: (distanceY / distance) * overlap
            };
        }

        return null;
    }

    /**
     * Check if player can pick up an item
     */
    checkItemPickup(player, item) {
        const dx = player.x - item.x;
        const dy = player.y - item.y;
        const distanceSquared = dx * dx + dy * dy;
        const pickupRadiusSquared = this.PICKUP_RADIUS * this.PICKUP_RADIUS;

        return distanceSquared < pickupRadiusSquared;
    }

    /**
     * Check if enemy collides with any walls/obstacles
     * Returns resolution vector or null
     */
    checkEnemyWallCollisions(enemy, collidables) {
        let totalResolutionX = 0;
        let totalResolutionY = 0;
        let hasCollision = false;

        for (const obstacle of collidables) {
            const collision = this.checkCircleRectCollision(
                enemy.x, enemy.y, this.ENEMY_RADIUS,
                obstacle.x, obstacle.y, obstacle.width, obstacle.height
            );

            if (collision) {
                totalResolutionX += collision.x;
                totalResolutionY += collision.y;
                hasCollision = true;
            }
        }

        if (hasCollision) {
            return { x: totalResolutionX, y: totalResolutionY };
        }

        return null;
    }

    /**
     * Check collisions between players and enemies
     * Returns array of { playerId, enemyId, enemy }
     */
    checkEnemyCollisions(players, enemies) {
        const collisions = [];
        const minDistance = this.PLAYER_RADIUS + this.ENEMY_RADIUS;
        const minDistanceSquared = minDistance * minDistance;

        for (const player of players) {
            for (const enemy of enemies) {
                const dx = player.x - enemy.x;
                const dy = player.y - enemy.y;
                const distanceSquared = dx * dx + dy * dy;

                if (distanceSquared < minDistanceSquared) {
                    collisions.push({
                        playerId: player.id,
                        enemyId: enemy.id,
                        enemy
                    });
                }
            }
        }

        return collisions;
    }

    /**
     * Check if player attack hits enemies
     * Returns array of enemy IDs that were hit
     */
    checkAttackHits(attacker, enemies) {
        const hits = [];

        // Get attack direction vector
        const dirVectors = {
            up: { x: 0, y: -1 },
            down: { x: 0, y: 1 },
            left: { x: -1, y: 0 },
            right: { x: 1, y: 0 }
        };
        const dir = dirVectors[attacker.direction] || dirVectors.down;

        for (const enemy of enemies) {
            const dx = enemy.x - attacker.x;
            const dy = enemy.y - attacker.y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            // Check if in range
            if (distance > this.ATTACK_RANGE + this.ENEMY_RADIUS) {
                continue;
            }

            // Check if in attack arc (90 degrees in front)
            if (distance > 0) {
                const dotProduct = (dx * dir.x + dy * dir.y) / distance;
                // cos(45deg) = 0.707, so dot product > 0 means within 90 degree arc
                if (dotProduct > 0) {
                    hits.push(enemy.id);
                }
            } else {
                // Enemy is at same position, always hit
                hits.push(enemy.id);
            }
        }

        return hits;
    }

    /**
     * Check collisions between players (for pushing effect)
     */
    checkPlayerCollisions(players) {
        const collisions = [];
        const playerArray = Array.isArray(players) ? players : Array.from(players);

        for (let i = 0; i < playerArray.length; i++) {
            for (let j = i + 1; j < playerArray.length; j++) {
                const p1 = playerArray[i];
                const p2 = playerArray[j];

                const dx = p2.x - p1.x;
                const dy = p2.y - p1.y;
                const distanceSquared = dx * dx + dy * dy;
                const minDistance = this.PLAYER_RADIUS * 2;

                if (distanceSquared < minDistance * minDistance && distanceSquared > 0) {
                    const distance = Math.sqrt(distanceSquared);
                    const overlap = minDistance - distance;
                    const pushX = (dx / distance) * overlap * 0.5;
                    const pushY = (dy / distance) * overlap * 0.5;

                    collisions.push({
                        player1: p1.id,
                        player2: p2.id,
                        resolution1: { x: -pushX, y: -pushY },
                        resolution2: { x: pushX, y: pushY }
                    });
                }
            }
        }

        return collisions;
    }

    /**
     * Check if a point is inside a rectangle
     */
    pointInRect(x, y, rectX, rectY, rectWidth, rectHeight) {
        return x >= rectX && x <= rectX + rectWidth &&
               y >= rectY && y <= rectY + rectHeight;
    }

    /**
     * Check if two rectangles overlap
     */
    rectOverlap(r1x, r1y, r1w, r1h, r2x, r2y, r2w, r2h) {
        return r1x < r2x + r2w &&
               r1x + r1w > r2x &&
               r1y < r2y + r2h &&
               r1y + r1h > r2y;
    }

    /**
     * Get distance between two points
     */
    getDistance(x1, y1, x2, y2) {
        const dx = x2 - x1;
        const dy = y2 - y1;
        return Math.sqrt(dx * dx + dy * dy);
    }

    /**
     * Check line of sight between two points (for future use)
     */
    hasLineOfSight(x1, y1, x2, y2, collidables) {
        const dx = x2 - x1;
        const dy = y2 - y1;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const steps = Math.ceil(distance / 8); // Check every 8 pixels

        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const checkX = x1 + dx * t;
            const checkY = y1 + dy * t;

            for (const obstacle of collidables) {
                if (this.pointInRect(checkX, checkY, obstacle.x, obstacle.y, obstacle.width, obstacle.height)) {
                    return false;
                }
            }
        }

        return true;
    }
}

module.exports = CollisionManager;
