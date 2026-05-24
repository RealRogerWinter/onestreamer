const { runAsync, getAsync, allAsync } = require('../database/database');
const ItemRepository = require('../database/repository/ItemRepository');

class ItemService {
    /**
     * @param {object} [deps]
     * @param {ItemRepository} [deps.itemRepository] - inject a custom repo
     *   (useful for tests). Defaults to a fresh `ItemRepository()` so the
     *   `new ItemService()` callsites scattered throughout the codebase
     *   continue to work unchanged.
     */
    constructor({ itemRepository } = {}) {
        this.itemRepository = itemRepository || new ItemRepository({ getAsync, runAsync, allAsync });
        this.initializeDefaultItems();
    }

    async initializeDefaultItems() {
        try {
            const existingItems = await this.getAllItems();
            if (existingItems.length === 0) {
                await this.createDefaultItems();
            }
        } catch (error) {
            console.error('Error initializing default items:', error);
        }
    }

    async createDefaultItems() {
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
            await this.createItem(item);
        }
        console.log('Default items created successfully');
    }

    async createItem(itemData) {
        const {
            name,
            display_name,
            emoji,
            description,
            item_type,
            category = 'misc',
            rarity,
            base_price = 0,
            is_purchasable = true,
            is_active = true,
            cooldown_seconds = 0,
            max_stack = 0,
            duration_seconds = 0,
            effect_data = null,
            stack_behavior = 'replace'
        } = itemData;

        try {
            const result = await this.itemRepository.create({
                name, display_name, emoji, description, item_type, category,
                rarity, base_price, is_purchasable, is_active,
                cooldown_seconds, max_stack, duration_seconds, effect_data, stack_behavior
            });

            return {
                id: result.id,
                ...itemData
            };
        } catch (error) {
            if (error.message.includes('UNIQUE constraint failed')) {
                console.log(`Item ${name} already exists`);
                return await this.getItemByName(name);
            }
            throw error;
        }
    }

    async getItemById(itemId) {
        return await this.itemRepository.getById(itemId);
    }

    async getItemByName(name) {
        return await this.itemRepository.getByName(name);
    }

    async getAllItems() {
        return await this.itemRepository.listAllActive();
    }

    async getItemsByType(itemType) {
        return await this.itemRepository.listByType(itemType);
    }

    async getItemsByCategory(category) {
        return await this.itemRepository.listByCategory(category);
    }

    async getAllCategories() {
        const result = await this.itemRepository.listDistinctCategories();

        // Transform to a more useful format
        const categories = result.map(row => ({
            value: row.category,
            label: row.category.split('_').map(word =>
                word.charAt(0).toUpperCase() + word.slice(1)
            ).join(' '),
            count: 0
        }));

        // Get counts for each category
        for (const cat of categories) {
            const countResult = await this.itemRepository.countByCategory(cat.value);
            cat.count = countResult.count;
        }

        return categories;
    }

    async getItemsByRarity(rarity) {
        return await this.itemRepository.listByRarity(rarity);
    }

    async updateItem(itemId, updates) {
        const allowedFields = [
            'display_name', 'emoji', 'description', 'base_price',
            'is_purchasable', 'is_active', 'cooldown_seconds', 'max_stack',
            'duration_seconds', 'item_type', 'rarity', 'name', 'category'
        ];

        const filteredEntries = Object.entries(updates).filter(([field]) => allowedFields.includes(field));
        if (filteredEntries.length === 0) {
            throw new Error('No valid fields to update');
        }

        const filteredUpdates = Object.fromEntries(filteredEntries);
        await this.itemRepository.update(itemId, filteredUpdates);

        return await this.getItemById(itemId);
    }

    async deleteItem(itemId) {
        await this.itemRepository.softDelete(itemId);
    }

    async validateItemUsage(userId, itemId) {
        console.log(`🔍 ITEMSERVICE: Validating item usage for user ${userId}, item ${itemId}`);
        
        const item = await this.getItemById(itemId);
        if (!item) {
            console.log(`❌ ITEMSERVICE: Item ${itemId} not found`);
            return { valid: false, error: 'Item not found' };
        }

        console.log(`🔍 ITEMSERVICE: Item ${item.name} has cooldown of ${item.cooldown_seconds}s`);

        if (item.cooldown_seconds > 0) {
            const lastUsage = await getAsync(
                `SELECT * FROM item_usage_log 
                 WHERE user_id = ? AND item_id = ? 
                 ORDER BY used_at DESC LIMIT 1`,
                [userId, itemId]
            );

            console.log(`🔍 ITEMSERVICE: Last usage for user ${userId}, item ${itemId}:`, lastUsage);

            if (lastUsage) {
                const cooldownEnd = new Date(lastUsage.used_at + 'Z').getTime() + (item.cooldown_seconds * 1000);
                const now = Date.now();
                
                console.log(`🔍 ITEMSERVICE: Cooldown check - now: ${now}, cooldownEnd: ${cooldownEnd}, remaining: ${cooldownEnd - now}ms`);
                
                if (now < cooldownEnd) {
                    const remainingSeconds = Math.ceil((cooldownEnd - now) / 1000);
                    console.log(`❌ ITEMSERVICE: Item on cooldown for ${remainingSeconds}s`);
                    return { 
                        valid: false, 
                        error: 'Item on cooldown',
                        cooldownRemaining: remainingSeconds 
                    };
                }
            } else {
                console.log(`✅ ITEMSERVICE: No previous usage found - item can be used`);
            }
        }

        console.log(`✅ ITEMSERVICE: Item usage validation passed`);
        return { valid: true };
    }

    async applyItemCooldown(userId, itemId, streamId = null) {
        await runAsync(
            'INSERT INTO item_usage_log (user_id, item_id, stream_id) VALUES (?, ?, ?)',
            [userId, itemId, streamId]
        );
    }

    async getItemCooldowns(userId) {
        const cooldowns = await allAsync(
            `SELECT 
                iul.item_id,
                iul.used_at,
                i.name,
                i.display_name,
                i.emoji,
                i.cooldown_seconds
             FROM item_usage_log iul
             JOIN items i ON iul.item_id = i.id
             WHERE iul.user_id = ?
               AND datetime(iul.used_at, '+' || i.cooldown_seconds || ' seconds') > datetime('now')
             ORDER BY iul.used_at DESC`,
            [userId]
        );

        return cooldowns.map(cd => {
            const cooldownEnd = new Date(cd.used_at + 'Z').getTime() + (cd.cooldown_seconds * 1000);
            const remainingSeconds = Math.max(0, Math.ceil((cooldownEnd - Date.now()) / 1000));
            
            return {
                itemId: cd.item_id,
                name: cd.name,
                displayName: cd.display_name,
                emoji: cd.emoji,
                cooldownRemaining: remainingSeconds,
                cooldownEnd: cooldownEnd
            };
        });
    }

    async resetAllItemCooldowns() {
        try {
            console.log(`🔄 ITEMSERVICE: Resetting all item cooldowns - checking current state...`);
            
            // First, check what's in the table before deletion
            const beforeCount = await getAsync('SELECT COUNT(*) as count FROM item_usage_log');
            console.log(`🔄 ITEMSERVICE: Found ${beforeCount.count} records in item_usage_log before reset`);
            
            // Show some sample records
            const sampleRecords = await allAsync('SELECT user_id, item_id, used_at FROM item_usage_log ORDER BY used_at DESC LIMIT 5');
            console.log(`🔄 ITEMSERVICE: Sample records before reset:`, sampleRecords);
            
            const result = await runAsync('DELETE FROM item_usage_log');
            const count = result.changes || 0;
            console.log(`🔄 ITEMSERVICE: Reset ${count} item usage cooldowns`);
            
            // Verify deletion
            const afterCount = await getAsync('SELECT COUNT(*) as count FROM item_usage_log');
            console.log(`🔄 ITEMSERVICE: Records remaining after reset: ${afterCount.count}`);
            
            return count;
        } catch (error) {
            console.error('❌ ITEMSERVICE: Failed to reset item cooldowns:', error);
            throw error;
        }
    }

    async resetUserItemCooldowns(userId) {
        try {
            const result = await runAsync('DELETE FROM item_usage_log WHERE user_id = ?', [userId]);
            const count = result.changes || 0;
            console.log(`🔄 ITEMSERVICE: Reset ${count} item usage cooldowns for user ${userId}`);
            return count;
        } catch (error) {
            console.error(`❌ ITEMSERVICE: Failed to reset item cooldowns for user ${userId}:`, error);
            throw error;
        }
    }

    async getItemStats() {
        const stats = await allAsync(
            `SELECT 
                i.id,
                i.name,
                i.display_name,
                i.emoji,
                i.rarity,
                COUNT(DISTINCT iul.user_id) as unique_users,
                COUNT(iul.id) as total_uses,
                MAX(iul.used_at) as last_used
             FROM items i
             LEFT JOIN item_usage_log iul ON i.id = iul.item_id
             GROUP BY i.id
             ORDER BY total_uses DESC`
        );

        return stats;
    }

    // Apply buff/debuff item (requires BuffDebuffService to be injected)
    async applyBuffDebuffItem(userId, itemId, appliedByUserId, buffDebuffService, skipCooldownValidation = false, streamId = null) {
        console.log(`📦 ITEM: applyBuffDebuffItem called with userId: ${userId}, itemId: ${itemId}, appliedByUserId: ${appliedByUserId}, streamId: ${streamId}`);
        
        try {
            // Validate item usage (cooldown, ownership, etc.) unless skipped
            if (!skipCooldownValidation) {
                const validationResult = await this.validateItemUsage(userId, itemId);
                if (!validationResult.valid) {
                    throw new Error(validationResult.error);
                }
            }

            // Get item details
            const item = await this.getItemById(itemId);
            if (!item) {
                throw new Error('Item not found');
            }
            
            console.log(`📦 ITEM: Found item - name: ${item.name}, display_name: ${item.display_name}, type: ${item.item_type}, duration: ${item.duration_seconds}`);

            if (!['buff', 'debuff'].includes(item.item_type)) {
                throw new Error('Item is not a buff or debuff');
            }

            // Apply the buff/debuff
            // Don't skip broadcasts completely for viewbots - we need streamer updates
            const skipBroadcasts = false;
            
            console.log(`📦 ITEM: Calling buffDebuffService.applyBuff with params:`, {
                userId,
                itemId,
                appliedByUserId,
                duration: item.duration_seconds,
                hasEffectData: !!item.effect_data,
                skipBroadcasts,
                streamId
            });
            
            const buffResult = await buffDebuffService.applyBuff(
                userId,
                itemId,
                appliedByUserId,
                item.duration_seconds,
                item.effect_data ? JSON.parse(item.effect_data) : null,
                skipBroadcasts,
                streamId
            );

            // Log the usage only if we're handling cooldown ourselves
            if (!skipCooldownValidation) {
                await this.applyItemCooldown(userId, itemId);
            }

            console.log(`✅ ITEM: Applied ${item.item_type} "${item.display_name}" to user ${userId}`);
            return buffResult;

        } catch (error) {
            console.error(`❌ ITEM: Error applying buff/debuff item ${itemId} to user ${userId}:`, error);
            throw error;
        }
    }

    // Check if item is a buff or debuff
    isBuffOrDebuffItem(item) {
        return item && ['buff', 'debuff'].includes(item.item_type);
    }

    // Check if item affects cooldowns
    isCooldownModifierItem(item) {
        return item && ['guard', 'weapon'].includes(item.item_type);
    }

    // Apply cooldown modifier item (requires TakeoverService to be injected)
    async applyCooldownModifierItem(userId, itemId, appliedByUserId, takeoverService, skipCooldownValidation = false) {
        try {
            // Validate item usage (cooldown, ownership, etc.) unless skipped
            if (!skipCooldownValidation) {
                const validationResult = await this.validateItemUsage(userId, itemId);
                if (!validationResult.valid) {
                    throw new Error(validationResult.error);
                }
            }

            // Get item details
            const item = await this.getItemById(itemId);
            if (!item) {
                throw new Error('Item not found');
            }

            if (!this.isCooldownModifierItem(item)) {
                throw new Error('Item is not a cooldown modifier');
            }

            // Parse effect data
            const effectData = item.effect_data ? JSON.parse(item.effect_data) : {};
            let result = { success: true, effects: [] };

            console.log(`🔧 ITEM: Applying cooldown modifier "${item.display_name}" for user ${userId}`);
            console.log(`🔧 ITEM: Effect data:`, effectData);

            // Apply global cooldown modifications
            if (effectData.global_cooldown_increase) {
                const success = await takeoverService.modifyGlobalCooldown(
                    effectData.global_cooldown_increase, 
                    `${item.name}_guard`
                );
                if (success) {
                    result.effects.push({
                        type: 'global_cooldown_increase',
                        amount: effectData.global_cooldown_increase,
                        message: `Global cooldown increased by ${effectData.global_cooldown_increase} seconds`
                    });
                }
            }

            if (effectData.global_cooldown_decrease) {
                const success = await takeoverService.modifyGlobalCooldown(
                    -effectData.global_cooldown_decrease, 
                    `${item.name}_attack`
                );
                if (success) {
                    result.effects.push({
                        type: 'global_cooldown_decrease',
                        amount: effectData.global_cooldown_decrease,
                        message: `Global cooldown decreased by ${effectData.global_cooldown_decrease} seconds`
                    });
                }
            }

            // Apply individual cooldown modifications
            if (effectData.reset_individual_cooldowns) {
                const count = await takeoverService.resetAllIndividualCooldowns(item.name);
                result.effects.push({
                    type: 'reset_individual_cooldowns',
                    count: count,
                    message: `Reset ${count} individual cooldowns`
                });
            }

            if (effectData.freeze_individual_cooldowns && item.duration_seconds) {
                const count = await takeoverService.freezeIndividualCooldowns(
                    item.duration_seconds, 
                    item.name
                );
                result.effects.push({
                    type: 'freeze_individual_cooldowns',
                    duration: item.duration_seconds,
                    count: count,
                    message: `Froze ${count} individual cooldowns for ${item.duration_seconds} seconds`
                });
            }

            // Log the usage only if we're handling cooldown ourselves
            if (!skipCooldownValidation) {
                await this.applyItemCooldown(userId, itemId);
            }

            console.log(`✅ ITEM: Applied cooldown modifier "${item.display_name}" with effects:`, result.effects);
            return result;

        } catch (error) {
            console.error(`❌ ITEM: Error applying cooldown modifier item ${itemId} for user ${userId}:`, error);
            throw error;
        }
    }

    // Get current global cooldown info (requires TakeoverService)
    async getGlobalCooldownInfo(takeoverService) {
        try {
            console.log(`🔧 ITEMSERVICE: Getting global cooldown info...`);
            console.log(`🔧 ITEMSERVICE: takeoverService.lastStreamStartTime: ${takeoverService.lastStreamStartTime}`);
            console.log(`🔧 ITEMSERVICE: takeoverService.globalCooldownSeconds: ${takeoverService.globalCooldownSeconds}`);
            
            const remaining = await takeoverService.getGlobalCooldownRemaining();
            const result = {
                remainingSeconds: remaining,
                totalSeconds: takeoverService.globalCooldownSeconds,
                isActive: remaining > 0
            };
            
            console.log(`🔧 ITEMSERVICE: Global cooldown info result:`, result);
            return result;
        } catch (error) {
            console.error('Error getting global cooldown info:', error);
            return { remainingSeconds: 0, totalSeconds: 30, isActive: false };
        }
    }
}

module.exports = ItemService;