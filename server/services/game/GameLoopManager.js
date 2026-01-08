/**
 * GameLoopManager - Handles the server-side game loop
 * Runs at 20 ticks per second for smooth gameplay
 */

class GameLoopManager {
    constructor(tickCallback) {
        this.tickCallback = tickCallback;
        this.isRunning = false;
        this.tickRate = 20; // 20 ticks per second
        this.tickInterval = 1000 / this.tickRate; // 50ms
        this.lastTickTime = 0;
        this.tickCount = 0;
        this.intervalId = null;

        // Performance tracking
        this.tickTimes = [];
        this.maxTickTimeSamples = 100;
    }

    start() {
        if (this.isRunning) {
            console.log('[GameLoop] Already running');
            return;
        }

        this.isRunning = true;
        this.lastTickTime = Date.now();
        this.tickCount = 0;

        // Use setInterval for consistent tick rate
        this.intervalId = setInterval(() => {
            const now = Date.now();
            const deltaTime = (now - this.lastTickTime) / 1000; // Convert to seconds
            this.lastTickTime = now;

            const tickStart = performance.now();

            try {
                this.tickCount++;
                this.tickCallback(deltaTime, this.tickCount);
            } catch (error) {
                console.error('[GameLoop] Error in tick callback:', error);
            }

            // Track tick performance
            const tickDuration = performance.now() - tickStart;
            this.tickTimes.push(tickDuration);
            if (this.tickTimes.length > this.maxTickTimeSamples) {
                this.tickTimes.shift();
            }

            // Warn if tick took too long
            if (tickDuration > this.tickInterval * 0.8) {
                console.warn(`[GameLoop] Tick ${this.tickCount} took ${tickDuration.toFixed(2)}ms (budget: ${this.tickInterval}ms)`);
            }
        }, this.tickInterval);

        console.log(`[GameLoop] Started at ${this.tickRate} ticks/second`);
    }

    stop() {
        if (!this.isRunning) {
            return;
        }

        this.isRunning = false;
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }

        console.log(`[GameLoop] Stopped after ${this.tickCount} ticks`);
    }

    getTickRate() {
        return this.tickRate;
    }

    getTickCount() {
        return this.tickCount;
    }

    isActive() {
        return this.isRunning;
    }

    getPerformanceStats() {
        if (this.tickTimes.length === 0) {
            return { avg: 0, max: 0, min: 0 };
        }

        const sum = this.tickTimes.reduce((a, b) => a + b, 0);
        return {
            avg: sum / this.tickTimes.length,
            max: Math.max(...this.tickTimes),
            min: Math.min(...this.tickTimes),
            tickCount: this.tickCount,
            isRunning: this.isRunning
        };
    }
}

module.exports = GameLoopManager;
