const os = require('os');

const logger = require('../../bootstrap/logger').child({ svc: 'VisualFxService' });

/**
 * Owns CPU/memory/effect-count monitoring and periodic cleanup of expired
 * effects/pipelines. Extracted verbatim from VisualFxService; reads service
 * state (config, activeEffects, processingPipelines, removeEffect,
 * removeProcessingPipeline) via `owner`. The `state` object is the former
 * `this.resourceMonitor` and is shared by reference with the service.
 */
class ResourceMonitor {
    constructor(owner) {
        this.owner = owner;
        this.state = {
            cpuUsage: 0,
            memoryUsage: 0,
            activeEffectCount: 0,
            maxConcurrentEffects: 50, // Increased for better performance
            lastCleanup: Date.now(),
            cleanupInterval: 30000 // Cleanup every 30 seconds instead of constantly
        };
    }

    startResourceMonitoring() {
        setInterval(() => {
            this.updateResourceMetrics();
        }, this.owner.config.resourceCheckInterval);
    }

    updateResourceMetrics() {
        const owner = this.owner;
        // Update CPU and memory usage
        const usage = process.cpuUsage();
        const memUsage = process.memoryUsage();

        // Calculate CPU percentage more accurately
        const cpuPercent = os.loadavg()[0] * 100 / os.cpus().length;
        this.state.cpuUsage = cpuPercent;
        this.state.memoryUsage = memUsage.heapUsed / 1024 / 1024; // Convert to MB

        // Only cleanup if truly necessary and not too frequently
        const now = Date.now();
        const timeSinceLastCleanup = now - this.state.lastCleanup;

        if (cpuPercent > owner.config.cpuThreshold && timeSinceLastCleanup > this.state.cleanupInterval) {
            logger.warn(`⚠️ VISUALFX: High CPU usage detected (${cpuPercent.toFixed(1)}%), cleaning up old effects`);
            this.cleanupOldEffects();
            this.state.lastCleanup = now;
        } else if (this.state.memoryUsage > owner.config.memoryThreshold) {
            logger.warn(`⚠️ VISUALFX: High memory usage detected (${this.state.memoryUsage.toFixed(0)}MB), cleaning up`);
            this.cleanupOldEffects();
            this.state.lastCleanup = now;
        }
    }

    checkResourceAvailability() {
        const owner = this.owner;
        // More lenient resource checking
        const cpuOk = this.state.cpuUsage < owner.config.cpuThreshold;
        const memoryOk = this.state.memoryUsage < owner.config.memoryThreshold;
        const effectsOk = this.state.activeEffectCount < this.state.maxConcurrentEffects;

        if (!cpuOk || !memoryOk || !effectsOk) {
            logger.debug(`📊 VISUALFX: Resource check - CPU: ${this.state.cpuUsage.toFixed(1)}% (OK: ${cpuOk}), Memory: ${this.state.memoryUsage.toFixed(0)}MB (OK: ${memoryOk}), Effects: ${this.state.activeEffectCount}/${this.state.maxConcurrentEffects} (OK: ${effectsOk})`);
        }

        return cpuOk && memoryOk && effectsOk;
    }

    cleanupOldEffects() {
        const owner = this.owner;
        const now = Date.now();
        let cleanedCount = 0;

        // Clean up expired effects
        for (const [streamId, effects] of owner.activeEffects.entries()) {
            const effectsToRemove = [];

            for (const effect of effects) {
                // Remove effects that have exceeded their duration
                if (now - effect.startTime > effect.duration) {
                    effectsToRemove.push(effect.id);
                    cleanedCount++;
                }
            }

            // Remove effects in batch to avoid iterator issues
            for (const effectId of effectsToRemove) {
                owner.removeEffect(streamId, effectId).catch(err => {
                    logger.error(`⚠️ VISUALFX: Error removing expired effect:`, err.message);
                });
            }
        }

        // Clean up abandoned pipelines
        for (const [streamId, pipeline] of owner.processingPipelines.entries()) {
            if (!pipeline.isActive || (now - pipeline.stats.startTime > 120000)) {
                owner.removeProcessingPipeline(streamId);
                cleanedCount++;
            }
        }

        // Clear empty effect sets
        for (const [streamId, effects] of owner.activeEffects.entries()) {
            if (effects.size === 0) {
                owner.activeEffects.delete(streamId);
            }
        }

        if (cleanedCount > 0) {
            logger.debug(`🧹 VISUALFX: Cleaned up ${cleanedCount} expired effects/pipelines`);
        }
    }
}

module.exports = ResourceMonitor;
