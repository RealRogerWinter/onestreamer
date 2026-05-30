/**
 * DefaultItemSeeder.js - default-catalog seeding extracted from ItemService.
 *
 * Owns the canonical default-item list and the empty-catalog seeding flow.
 * Item creation routes through owner.createItem so behavior is byte-identical
 * to the in-service form. Only `this.`→`owner.`.
 */

const logger = require('../../bootstrap/logger').child({ svc: 'ItemService' });

class DefaultItemSeeder {
    constructor(owner) {
        this.owner = owner;
    }

    async initializeDefaultItems() {
        const owner = this.owner;
        try {
            const existingItems = await owner.getAllItems();
            if (existingItems.length === 0) {
                await owner.createDefaultItems();
            }
        } catch (error) {
            logger.error('Error initializing default items:', error);
        }
    }

    async createDefaultItems() {
        const owner = this.owner;
        const defaultItems = [
            {
                name: 'tomato',
                display_name: 'Tomato',
                emoji: '🍅',
                description: 'Throw a tomato at the stream',
                item_type: 'utility',
                rarity: 'common',
                base_price: 25,
                cooldown_seconds: 10,
                max_stack: 0
            },
            {
                name: 'speed_boost',
                display_name: 'Speed Boost',
                emoji: '⚡',
                description: 'Increases stream quality temporarily',
                item_type: 'buff',
                rarity: 'common',
                base_price: 100,
                cooldown_seconds: 60,
                max_stack: 0,
                duration_seconds: 300,
                effect_data: JSON.stringify({ effect_type: 'quality_boost', intensity: 1.5 }),
                stack_behavior: 'extend'
            },
            {
                name: 'spotlight',
                display_name: 'Spotlight',
                emoji: '🌟',
                description: 'Highlights your presence in the stream',
                item_type: 'buff',
                rarity: 'uncommon',
                base_price: 250,
                cooldown_seconds: 120,
                max_stack: 0,
                duration_seconds: 180,
                effect_data: JSON.stringify({ effect_type: 'highlight', glow_color: 'gold' }),
                stack_behavior: 'stack'
            },
            {
                name: 'slow_mode',
                display_name: 'Slow Mode',
                emoji: '🐌',
                description: 'Slows down the stream temporarily',
                item_type: 'debuff',
                rarity: 'common',
                base_price: 150,
                cooldown_seconds: 90,
                max_stack: 0,
                duration_seconds: 120,
                effect_data: JSON.stringify({ effect_type: 'slow_stream', factor: 0.5 }),
                stack_behavior: 'extend'
            },
            {
                name: 'rainbow_effect',
                display_name: 'Rainbow Effect',
                emoji: '🌈',
                description: 'Adds a rainbow filter to the stream',
                item_type: 'utility',
                rarity: 'rare',
                base_price: 500,
                cooldown_seconds: 180,
                max_stack: 0
            },
            {
                name: 'golden_mic',
                display_name: 'Golden Microphone',
                emoji: '🎤',
                description: 'Amplifies your voice in the stream',
                item_type: 'buff',
                rarity: 'epic',
                base_price: 1000,
                cooldown_seconds: 300,
                max_stack: 0,
                duration_seconds: 600,
                effect_data: JSON.stringify({ effect_type: 'voice_amplify', gain: 2.0 }),
                stack_behavior: 'replace'
            },
            {
                name: 'disco_ball',
                display_name: 'Disco Ball',
                emoji: '🪩',
                description: 'Starts a party mode with effects',
                item_type: 'utility',
                rarity: 'epic',
                base_price: 750,
                cooldown_seconds: 240,
                max_stack: 0
            },
            {
                name: 'freeze_frame',
                display_name: 'Freeze Frame',
                emoji: '🧊',
                description: 'Freezes the stream for a moment',
                item_type: 'debuff',
                rarity: 'uncommon',
                base_price: 300,
                cooldown_seconds: 150,
                max_stack: 0,
                duration_seconds: 45,
                effect_data: JSON.stringify({ effect_type: 'freeze', freeze_duration: 3 }),
                stack_behavior: 'stack'
            },
            {
                name: 'confetti_cannon',
                display_name: 'Confetti Cannon',
                emoji: '🎊',
                description: 'Launches confetti on the stream',
                item_type: 'utility',
                rarity: 'common',
                base_price: 50,
                cooldown_seconds: 30,
                max_stack: 0
            },
            {
                name: 'mega_boost',
                display_name: 'Mega Boost',
                emoji: '🚀',
                description: 'Ultimate stream enhancement',
                item_type: 'buff',
                rarity: 'legendary',
                base_price: 2500,
                cooldown_seconds: 600,
                max_stack: 0
            },
            {
                name: 'smoke_bomb',
                display_name: 'Smoke Bomb',
                emoji: '💨',
                description: 'Obscures the stream with smoke',
                item_type: 'debuff',
                rarity: 'rare',
                base_price: 400,
                cooldown_seconds: 200,
                max_stack: 0,
                duration_seconds: 60,
                effect_data: JSON.stringify({
                    effect_type: 'visual_overlay',
                    visual_effect: 'smoke_cloud'
                }),
                stack_behavior: 'replace'
            },
            {
                name: 'megaphone',
                display_name: 'Megaphone',
                emoji: '📢',
                description: 'Broadcast a text-to-speech message to everyone watching',
                item_type: 'utility',
                rarity: 'common',
                base_price: 150,
                cooldown_seconds: 30,
                max_stack: 0,
                effect_data: JSON.stringify({
                    effect_type: 'tts',
                    requires_input: true,
                    max_length: 200
                })
            },
            {
                name: 'potato',
                display_name: 'Potato',
                emoji: '🥔',
                description: 'Give the streamer Potato Quality - ultra low resolution streaming',
                item_type: 'debuff',
                rarity: 'common',
                base_price: 75,
                cooldown_seconds: 45,
                max_stack: 0,
                duration_seconds: 35,
                effect_data: JSON.stringify({
                    effect_type: 'potato_quality',
                    visual_effect: 'bitrate_potato'
                }),
                stack_behavior: 'replace'
            },
            {
                name: 'red_marker',
                display_name: 'Red Marker',
                emoji: '🔴',
                description: 'Draw on the stream with red ink for 10 seconds',
                item_type: 'marker',
                rarity: 'common',
                base_price: 200,
                cooldown_seconds: 30,
                max_stack: 0,
                effect_data: JSON.stringify({
                    effect_type: 'drawing',
                    interactive: true,
                    draw_duration: 10000,
                    display_duration: 10000,
                    line_width: 3,
                    default_color: '#FF0000'
                })
            },
            {
                name: 'blue_marker',
                display_name: 'Blue Marker',
                emoji: '🔵',
                description: 'Draw on the stream with blue ink for 10 seconds',
                item_type: 'marker',
                rarity: 'common',
                base_price: 200,
                cooldown_seconds: 30,
                max_stack: 0,
                effect_data: JSON.stringify({
                    effect_type: 'drawing',
                    interactive: true,
                    draw_duration: 10000,
                    display_duration: 10000,
                    line_width: 3,
                    default_color: '#0000FF'
                })
            },
            {
                name: 'green_marker',
                display_name: 'Green Marker',
                emoji: '🟢',
                description: 'Draw on the stream with green ink for 10 seconds',
                item_type: 'marker',
                rarity: 'common',
                base_price: 200,
                cooldown_seconds: 30,
                max_stack: 0,
                effect_data: JSON.stringify({
                    effect_type: 'drawing',
                    interactive: true,
                    draw_duration: 10000,
                    display_duration: 10000,
                    line_width: 3,
                    default_color: '#00AA00'
                })
            },
            {
                name: 'yellow_marker',
                display_name: 'Yellow Marker',
                emoji: '🟡',
                description: 'Draw on the stream with yellow ink for 10 seconds',
                item_type: 'marker',
                rarity: 'common',
                base_price: 200,
                cooldown_seconds: 30,
                max_stack: 0,
                effect_data: JSON.stringify({
                    effect_type: 'drawing',
                    interactive: true,
                    draw_duration: 10000,
                    display_duration: 10000,
                    line_width: 3,
                    default_color: '#FFDD00'
                })
            },
            {
                name: 'purple_marker',
                display_name: 'Purple Marker',
                emoji: '🟣',
                description: 'Draw on the stream with purple ink for 10 seconds',
                item_type: 'marker',
                rarity: 'common',
                base_price: 250,
                cooldown_seconds: 30,
                max_stack: 0,
                effect_data: JSON.stringify({
                    effect_type: 'drawing',
                    interactive: true,
                    draw_duration: 10000,
                    display_duration: 10000,
                    line_width: 3,
                    default_color: '#AA00AA'
                })
            },
            {
                name: 'orange_marker',
                display_name: 'Orange Marker',
                emoji: '🟠',
                description: 'Draw on the stream with orange ink for 10 seconds',
                item_type: 'marker',
                rarity: 'common',
                base_price: 220,
                cooldown_seconds: 30,
                max_stack: 0,
                effect_data: JSON.stringify({
                    effect_type: 'drawing',
                    interactive: true,
                    draw_duration: 10000,
                    display_duration: 10000,
                    line_width: 3,
                    default_color: '#FF8800'
                })
            },
            {
                name: 'pink_marker',
                display_name: 'Pink Marker',
                emoji: '🩷',
                description: 'Draw on the stream with pink ink for 10 seconds',
                item_type: 'marker',
                rarity: 'common',
                base_price: 240,
                cooldown_seconds: 30,
                max_stack: 0,
                effect_data: JSON.stringify({
                    effect_type: 'drawing',
                    interactive: true,
                    draw_duration: 10000,
                    display_duration: 10000,
                    line_width: 3,
                    default_color: '#FF69B4'
                })
            },
            {
                name: 'black_marker',
                display_name: 'Black Marker',
                emoji: '⚫',
                description: 'Draw on the stream with black ink for 10 seconds',
                item_type: 'marker',
                rarity: 'common',
                base_price: 180,
                cooldown_seconds: 30,
                max_stack: 0,
                effect_data: JSON.stringify({
                    effect_type: 'drawing',
                    interactive: true,
                    draw_duration: 10000,
                    display_duration: 10000,
                    line_width: 3,
                    default_color: '#000000'
                })
            },
            {
                name: 'white_marker',
                display_name: 'White Marker',
                emoji: '⚪',
                description: 'Draw on the stream with white ink for 10 seconds',
                item_type: 'marker',
                rarity: 'common',
                base_price: 200,
                cooldown_seconds: 30,
                max_stack: 0,
                effect_data: JSON.stringify({
                    effect_type: 'drawing',
                    interactive: true,
                    draw_duration: 10000,
                    display_duration: 10000,
                    line_width: 3,
                    default_color: '#FFFFFF'
                })
            },
            {
                name: 'rainbow_marker',
                display_name: 'Rainbow Marker',
                emoji: '🌈',
                description: 'Draw on the stream with rainbow colors for 10 seconds',
                item_type: 'marker',
                rarity: 'uncommon',
                base_price: 350,
                cooldown_seconds: 45,
                max_stack: 0,
                effect_data: JSON.stringify({
                    effect_type: 'drawing',
                    interactive: true,
                    draw_duration: 10000,
                    display_duration: 10000,
                    line_width: 4,
                    default_color: 'rainbow',
                    rainbow_mode: true
                })
            },
            {
                name: 'kill_switch',
                display_name: 'Kill Switch',
                emoji: '💥',
                description: 'Immediately disconnects the current streamer (emergency use only)',
                item_type: 'utility',
                rarity: 'rare',
                base_price: 1000,
                cooldown_seconds: 300,
                max_stack: 0,
                effect_data: JSON.stringify({
                    effect_type: 'disconnect_streamer',
                    target: 'current_streamer',
                    immediate: true
                })
            },
            {
                name: 'shield',
                display_name: 'Shield',
                emoji: '🛡️',
                description: 'Protects the current streamer by increasing global cooldown by 15 seconds',
                item_type: 'guard',
                rarity: 'uncommon',
                base_price: 300,
                cooldown_seconds: 120,
                max_stack: 0,
                duration_seconds: 0,
                effect_data: JSON.stringify({
                    effect_type: 'cooldown_modifier',
                    global_cooldown_increase: 15,
                    target: 'global'
                }),
                stack_behavior: 'stack'
            },
            {
                name: 'reinforced_shield',
                display_name: 'Reinforced Shield',
                emoji: '🛡️⚡',
                description: 'Superior protection that increases global cooldown by 30 seconds',
                item_type: 'guard',
                rarity: 'rare',
                base_price: 600,
                cooldown_seconds: 180,
                max_stack: 0,
                duration_seconds: 0,
                effect_data: JSON.stringify({
                    effect_type: 'cooldown_modifier',
                    global_cooldown_increase: 30,
                    target: 'global'
                }),
                stack_behavior: 'stack'
            },
            {
                name: 'fortress_wall',
                display_name: 'Fortress Wall',
                emoji: '🏰',
                description: 'Ultimate protection - increases global cooldown by 60 seconds',
                item_type: 'guard',
                rarity: 'epic',
                base_price: 1200,
                cooldown_seconds: 300,
                max_stack: 0,
                duration_seconds: 0,
                effect_data: JSON.stringify({
                    effect_type: 'cooldown_modifier',
                    global_cooldown_increase: 60,
                    target: 'global'
                }),
                stack_behavior: 'stack'
            },
            {
                name: 'sword',
                display_name: 'Sword',
                emoji: '⚔️',
                description: 'Attacks the current stream by reducing global cooldown by 10 seconds',
                item_type: 'weapon',
                rarity: 'common',
                base_price: 250,
                cooldown_seconds: 90,
                max_stack: 0,
                duration_seconds: 0,
                effect_data: JSON.stringify({
                    effect_type: 'cooldown_modifier',
                    global_cooldown_decrease: 10,
                    target: 'global'
                }),
                stack_behavior: 'stack'
            },
            {
                name: 'battle_axe',
                display_name: 'Battle Axe',
                emoji: '🪓',
                description: 'Heavy weapon that reduces global cooldown by 20 seconds',
                item_type: 'weapon',
                rarity: 'uncommon',
                base_price: 450,
                cooldown_seconds: 120,
                max_stack: 0,
                duration_seconds: 0,
                effect_data: JSON.stringify({
                    effect_type: 'cooldown_modifier',
                    global_cooldown_decrease: 20,
                    target: 'global'
                }),
                stack_behavior: 'stack'
            },
            {
                name: 'lightning_bolt',
                display_name: 'Lightning Bolt',
                emoji: '⚡',
                description: 'Devastating attack that reduces global cooldown by 45 seconds',
                item_type: 'weapon',
                rarity: 'epic',
                base_price: 900,
                cooldown_seconds: 240,
                max_stack: 0,
                duration_seconds: 0,
                effect_data: JSON.stringify({
                    effect_type: 'cooldown_modifier',
                    global_cooldown_decrease: 45,
                    target: 'global'
                }),
                stack_behavior: 'stack'
            },
            {
                name: 'time_freeze',
                display_name: 'Time Freeze',
                emoji: '⏳',
                description: 'Freezes individual cooldowns for all users for 30 seconds',
                item_type: 'guard',
                rarity: 'legendary',
                base_price: 2000,
                cooldown_seconds: 600,
                max_stack: 0,
                duration_seconds: 30,
                effect_data: JSON.stringify({
                    effect_type: 'cooldown_modifier',
                    freeze_individual_cooldowns: true,
                    target: 'individual'
                }),
                stack_behavior: 'replace'
            },
            {
                name: 'chaos_orb',
                display_name: 'Chaos Orb',
                emoji: '🔮',
                description: 'Resets all individual cooldowns and reduces global cooldown by 20 seconds',
                item_type: 'weapon',
                rarity: 'legendary',
                base_price: 1800,
                cooldown_seconds: 480,
                max_stack: 0,
                duration_seconds: 0,
                effect_data: JSON.stringify({
                    effect_type: 'cooldown_modifier',
                    reset_individual_cooldowns: true,
                    global_cooldown_decrease: 20,
                    target: 'both'
                }),
                stack_behavior: 'replace'
            },
            {
                name: 'stream_reducer',
                display_name: 'Stream Reducer',
                emoji: '📉',
                description: 'Cuts the stream size in half for 1 minute',
                item_type: 'debuff',
                rarity: 'uncommon',
                base_price: 200,
                cooldown_seconds: 90,
                max_stack: 0,
                duration_seconds: 60,
                effect_data: JSON.stringify({
                    effect_type: 'stream_size_reduction',
                    visual_effect: 'resolution_360p'
                }),
                stack_behavior: 'replace'
            },
            {
                name: 'heart_swarm',
                display_name: 'Heart Swarm',
                emoji: '💕',
                description: 'Releases a swarm of floating hearts across the stream',
                item_type: 'utility',
                rarity: 'common',
                base_price: 100,
                cooldown_seconds: 30,
                max_stack: 0
            },
            {
                name: 'summon_bot',
                display_name: 'Summon Bot',
                emoji: '🤖',
                description: 'Summon a custom AI bot to chat for 1 hour',
                item_type: 'utility',
                rarity: 'epic',
                base_price: 800,
                cooldown_seconds: 3600,
                max_stack: 0,
                effect_data: JSON.stringify({
                    effect_type: 'summon_bot',
                    requires_input: true,
                    bot_duration: 3600,
                    max_name_length: 30,
                    max_prompt_length: 200
                })
            },
            {
                name: 'summon_lesser_bot',
                display_name: 'Summon Lesser Bot',
                emoji: '🤖',
                description: 'Summon a custom AI bot to chat for 15 minutes',
                item_type: 'utility',
                rarity: 'uncommon',
                base_price: 300,
                cooldown_seconds: 900,
                max_stack: 0,
                effect_data: JSON.stringify({
                    effect_type: 'summon_bot',
                    requires_input: true,
                    bot_duration: 900,
                    max_name_length: 30,
                    max_prompt_length: 200
                })
            }
        ];

        for (const item of defaultItems) {
            await owner.createItem(item);
        }
        logger.debug('Default items created successfully');
    }
}

module.exports = DefaultItemSeeder;
