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
    //
    // NOTE: this list is INTENTIONALLY narrower than the keys of
    // CANVAS_EFFECT_MAPPINGS. It deliberately omits the buff/debuff items
    // (slow_mode, speed_boost, golden_mic) and the auto-trigger items (fart,
    // thunderstorm) even though those have effect mappings — their visuals are
    // driven through the buff-application / auto-trigger paths, not this gate
    // (used by BuffEffectBridge to decide whether a buff item also gets a
    // generic visual). Do NOT derive this from `name in CANVAS_EFFECT_MAPPINGS`:
    // that would flip those 5 items to true and start firing extra visuals.
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
    //
    // NOTE: this list mirrors the click-to-throw / click-to-draw entries of
    // CANVAS_INTERACTION_CONFIGS but INTENTIONALLY omits 'fart' — fart's
    // interaction config is `mode: 'auto-trigger'`, so it must not be treated
    // as interactive (it would change the ItemUseService dispatch and the
    // ThrowingService notification-suppression flag). Do NOT derive this from
    // `name in CANVAS_INTERACTION_CONFIGS`: that would flip 'fart' to true.
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
