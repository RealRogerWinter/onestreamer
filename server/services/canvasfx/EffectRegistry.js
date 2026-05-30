/**
 * EffectRegistry — registry/lookup + predicate tables for CanvasFxService.
 *
 * Extracted verbatim from CanvasFxService (item predicates, effect/interaction
 * config lookups, random positioning). ALL state stays on the owning service;
 * these are pure helpers over the static effectDefinitions registry. Methods
 * read `owner.config` where the original read `this.config`. The service keeps
 * thin delegators with identical signatures so the public API is unchanged.
 */

const { CANVAS_EFFECT_MAPPINGS, CANVAS_INTERACTION_CONFIGS } = require('./effectDefinitions');

class EffectRegistry {
    constructor(owner) {
        this.owner = owner;
    }

    // Check if an item has visual effects
    hasVisualEffect(item) {
        const visualEffectItems = [
            'tomato',
            'confetti_cannon',
            'smoke_bomb',
            'rainbow_effect',
            'disco_ball',
            'spotlight',
            'freeze_frame',
            'red_marker',
            'blue_marker',
            'green_marker',
            'yellow_marker',
            'purple_marker',
            'orange_marker',
            'pink_marker',
            'black_marker',
            'white_marker',
            'rainbow_marker',
            'heart_swarm',
            'arrow',
            'molotov',
            'lsd',
            'bugs'
        ];

        return visualEffectItems.includes(item.name);
    }

    // Check if an item's effect should be synced with buff duration
    isBuffSyncedEffect(item) {
        const buffSyncedItems = [
            'smoke_bomb'
        ];

        return buffSyncedItems.includes(item.name);
    }

    // Check if an item requires interactive behavior (click-to-throw)
    isInteractiveItem(item) {
        const interactiveItems = [
            'tomato',
            'snowball',
            'paint_balloon',
            'water_balloon',
            'confetti_cannon',
            'smoke_bomb',
            'disco_ball',
            'spotlight',
            'rainbow_effect',
            'red_marker',
            'blue_marker',
            'green_marker',
            'yellow_marker',
            'purple_marker',
            'orange_marker',
            'pink_marker',
            'black_marker',
            'white_marker',
            'rainbow_marker',
            'heart_swarm',
            'arrow',
            'molotov',
            'lsd',
            'bugs'
        ];

        return interactiveItems.includes(item.name);
    }

    // Get interaction configuration for an item
    getInteractionConfig(item) {
        const interactionConfigs = CANVAS_INTERACTION_CONFIGS;

        const config = interactionConfigs[item.name];
        if (!config) return null;

        // Replace placeholders with actual values
        const itemDisplayName = item.display_name || item.displayName || item.name || 'item';
        return {
            ...config,
            indicator: config.indicator.replace('{itemName}', itemDisplayName),
            chatMessage: config.chatMessage // Will be replaced at runtime with username
        };
    }

    // Get effect configuration for an item
    getEffectConfig(item) {
        const owner = this.owner;
        // Map items to visual effects
        const effectMappings = CANVAS_EFFECT_MAPPINGS;

        return effectMappings[item.name] || {
            type: 'default',
            duration: owner.config.defaultDuration,
            config: {
                color: '#ffffff',
                animation: 'fade'
            }
        };
    }

    // Get random position for effect placement
    getRandomPosition() {
        return {
            x: 0.1 + Math.random() * 0.8, // 10% to 90% of width
            y: 0.1 + Math.random() * 0.8  // 10% to 90% of height
        };
    }
}

module.exports = EffectRegistry;
