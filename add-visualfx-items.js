const { runAsync, getAsync, allAsync } = require('./server/database/database');

async function addVisualFxItems() {
    console.log('🎨 Adding Visual Effects Items\n');
    console.log('=' .repeat(50));
    
    // Define all visual effects items based on the VisualFxService effects
    const visualFxItems = [
        // Bitrate Effects
        {
            name: 'low_bitrate',
            display_name: 'Low Quality Stream',
            emoji: '📉',
            description: 'Reduces stream quality to low bitrate for 20 seconds',
            item_type: 'debuff',
            rarity: 'common',
            base_price: 100,
            cooldown_seconds: 60,
            duration_seconds: 20,
            effect_data: {
                effect_type: 'bitrate_reduction',
                visual_effect: 'bitrate_low'
            }
        },
        {
            name: 'bandwidth_throttle',
            display_name: 'Bandwidth Throttle',
            emoji: '🔄',
            description: 'Throttles stream bandwidth for 30 seconds',
            item_type: 'debuff',
            rarity: 'uncommon',
            base_price: 150,
            cooldown_seconds: 75,
            duration_seconds: 30,
            effect_data: {
                effect_type: 'bitrate_reduction',
                visual_effect: 'bitrate_throttle'
            }
        },
        
        // Frame Rate Effects
        {
            name: 'slideshow_mode',
            display_name: 'Slideshow Mode',
            emoji: '🖼️',
            description: 'Reduces stream to 1 FPS slideshow for 15 seconds',
            item_type: 'debuff',
            rarity: 'rare',
            base_price: 250,
            cooldown_seconds: 90,
            duration_seconds: 15,
            effect_data: {
                effect_type: 'framerate_reduction',
                visual_effect: 'framerate_slideshow'
            }
        },
        {
            name: 'choppy_video',
            display_name: 'Choppy Video',
            emoji: '⚡',
            description: 'Makes video choppy at 10 FPS for 20 seconds',
            item_type: 'debuff',
            rarity: 'uncommon',
            base_price: 175,
            cooldown_seconds: 70,
            duration_seconds: 20,
            effect_data: {
                effect_type: 'framerate_reduction',
                visual_effect: 'framerate_choppy'
            }
        },
        {
            name: 'cinematic_mode',
            display_name: 'Cinematic Mode',
            emoji: '🎬',
            description: 'Sets stream to cinematic 24 FPS for 30 seconds',
            item_type: 'buff',
            rarity: 'common',
            base_price: 75,
            cooldown_seconds: 45,
            duration_seconds: 30,
            effect_data: {
                effect_type: 'framerate_change',
                visual_effect: 'framerate_cinematic'
            }
        },
        
        // Network Simulation Effects
        {
            name: 'mild_packet_loss',
            display_name: 'Network Hiccup',
            emoji: '📶',
            description: 'Causes mild packet loss for 15 seconds',
            item_type: 'debuff',
            rarity: 'common',
            base_price: 125,
            cooldown_seconds: 60,
            duration_seconds: 15,
            effect_data: {
                effect_type: 'network_issue',
                visual_effect: 'packet_loss_mild'
            }
        },
        {
            name: 'lag_spike',
            display_name: 'Lag Spike',
            emoji: '⚠️',
            description: 'Causes severe packet loss for 10 seconds',
            item_type: 'debuff',
            rarity: 'rare',
            base_price: 300,
            cooldown_seconds: 120,
            duration_seconds: 10,
            effect_data: {
                effect_type: 'network_issue',
                visual_effect: 'packet_loss_severe'
            }
        },
        {
            name: 'network_jitter',
            display_name: 'Jitter',
            emoji: '〰️',
            description: 'Adds network jitter for 20 seconds',
            item_type: 'debuff',
            rarity: 'uncommon',
            base_price: 150,
            cooldown_seconds: 70,
            duration_seconds: 20,
            effect_data: {
                effect_type: 'network_issue',
                visual_effect: 'jitter'
            }
        },
        
        // Visual Distortion Effects
        {
            name: 'pixelate',
            display_name: 'Pixelation',
            emoji: '🟩',
            description: 'Pixelates the stream for 15 seconds',
            item_type: 'debuff',
            rarity: 'common',
            base_price: 100,
            cooldown_seconds: 50,
            duration_seconds: 15,
            effect_data: {
                effect_type: 'visual_filter',
                visual_effect: 'pixelate'
            }
        },
        {
            name: 'motion_blur',
            display_name: 'Motion Blur',
            emoji: '💨',
            description: 'Adds motion blur effect for 20 seconds',
            item_type: 'debuff',
            rarity: 'common',
            base_price: 100,
            cooldown_seconds: 55,
            duration_seconds: 20,
            effect_data: {
                effect_type: 'visual_filter',
                visual_effect: 'blur'
            }
        },
        {
            name: 'black_and_white',
            display_name: 'Black & White',
            emoji: '⚫',
            description: 'Converts stream to grayscale for 30 seconds',
            item_type: 'buff',
            rarity: 'common',
            base_price: 75,
            cooldown_seconds: 45,
            duration_seconds: 30,
            effect_data: {
                effect_type: 'visual_filter',
                visual_effect: 'grayscale'
            }
        },
        {
            name: 'sepia_tone',
            display_name: 'Sepia Tone',
            emoji: '🟤',
            description: 'Applies vintage sepia tone for 30 seconds',
            item_type: 'buff',
            rarity: 'common',
            base_price: 75,
            cooldown_seconds: 45,
            duration_seconds: 30,
            effect_data: {
                effect_type: 'visual_filter',
                visual_effect: 'sepia'
            }
        },
        {
            name: 'tv_static',
            display_name: 'TV Static',
            emoji: '📺',
            description: 'Adds TV static noise for 10 seconds',
            item_type: 'debuff',
            rarity: 'uncommon',
            base_price: 175,
            cooldown_seconds: 70,
            duration_seconds: 10,
            effect_data: {
                effect_type: 'visual_filter',
                visual_effect: 'static_noise'
            }
        },
        {
            name: 'glitch_bomb',
            display_name: 'Glitch Bomb',
            emoji: '💥',
            description: 'Creates digital glitch effect for 5 seconds',
            item_type: 'debuff',
            rarity: 'rare',
            base_price: 250,
            cooldown_seconds: 100,
            duration_seconds: 5,
            effect_data: {
                effect_type: 'visual_filter',
                visual_effect: 'glitch'
            }
        },
        
        // Audio Effects
        {
            name: 'chipmunk_voice',
            display_name: 'Chipmunk Voice',
            emoji: '🐿️',
            description: 'Makes voice high-pitched for 20 seconds',
            item_type: 'debuff',
            rarity: 'common',
            base_price: 125,
            cooldown_seconds: 60,
            duration_seconds: 20,
            effect_data: {
                effect_type: 'audio_effect',
                visual_effect: 'audio_pitch_high'
            }
        },
        {
            name: 'demon_voice',
            display_name: 'Demon Voice',
            emoji: '👹',
            description: 'Makes voice deep and scary for 20 seconds',
            item_type: 'debuff',
            rarity: 'common',
            base_price: 125,
            cooldown_seconds: 60,
            duration_seconds: 20,
            effect_data: {
                effect_type: 'audio_effect',
                visual_effect: 'audio_pitch_low'
            }
        },
        {
            name: 'echo_chamber',
            display_name: 'Echo Chamber',
            emoji: '🔊',
            description: 'Adds echo effect to audio for 15 seconds',
            item_type: 'debuff',
            rarity: 'common',
            base_price: 100,
            cooldown_seconds: 50,
            duration_seconds: 15,
            effect_data: {
                effect_type: 'audio_effect',
                visual_effect: 'audio_echo'
            }
        },
        
        // Freeze Effects
        {
            name: 'freeze_ray',
            display_name: 'Freeze Ray',
            emoji: '🧊',
            description: 'Freezes stream for 3 seconds',
            item_type: 'debuff',
            rarity: 'epic',
            base_price: 400,
            cooldown_seconds: 150,
            duration_seconds: 3,
            effect_data: {
                effect_type: 'freeze',
                visual_effect: 'freeze_frame'
            }
        },
        {
            name: 'video_stutter',
            display_name: 'Video Stutter',
            emoji: '📼',
            description: 'Makes video stutter for 10 seconds',
            item_type: 'debuff',
            rarity: 'uncommon',
            base_price: 200,
            cooldown_seconds: 80,
            duration_seconds: 10,
            effect_data: {
                effect_type: 'stutter',
                visual_effect: 'stutter'
            }
        },
        
        // Color & Visual Effects
        {
            name: 'invert_colors',
            display_name: 'Invert Colors',
            emoji: '🔄',
            description: 'Inverts all colors for 20 seconds',
            item_type: 'debuff',
            rarity: 'common',
            base_price: 100,
            cooldown_seconds: 55,
            duration_seconds: 20,
            effect_data: {
                effect_type: 'visual_filter',
                visual_effect: 'invert'
            }
        },
        {
            name: 'darkness',
            display_name: 'Darkness',
            emoji: '🌑',
            description: 'Makes stream very dark for 25 seconds',
            item_type: 'debuff',
            rarity: 'uncommon',
            base_price: 150,
            cooldown_seconds: 65,
            duration_seconds: 25,
            effect_data: {
                effect_type: 'visual_filter',
                visual_effect: 'brightness_dark'
            }
        },
        {
            name: 'overexposed',
            display_name: 'Overexposed',
            emoji: '☀️',
            description: 'Makes stream too bright for 25 seconds',
            item_type: 'debuff',
            rarity: 'uncommon',
            base_price: 150,
            cooldown_seconds: 65,
            duration_seconds: 25,
            effect_data: {
                effect_type: 'visual_filter',
                visual_effect: 'brightness_bright'
            }
        },
        {
            name: 'low_contrast',
            display_name: 'Low Contrast',
            emoji: '🌫️',
            description: 'Reduces contrast for 25 seconds',
            item_type: 'debuff',
            rarity: 'common',
            base_price: 100,
            cooldown_seconds: 50,
            duration_seconds: 25,
            effect_data: {
                effect_type: 'visual_filter',
                visual_effect: 'contrast_low'
            }
        },
        {
            name: 'high_contrast',
            display_name: 'High Contrast',
            emoji: '🎭',
            description: 'Increases contrast for 25 seconds',
            item_type: 'buff',
            rarity: 'common',
            base_price: 75,
            cooldown_seconds: 45,
            duration_seconds: 25,
            effect_data: {
                effect_type: 'visual_filter',
                visual_effect: 'contrast_high'
            }
        },
        {
            name: 'oversaturated',
            display_name: 'Oversaturated',
            emoji: '🌈',
            description: 'Makes colors extremely vibrant for 25 seconds',
            item_type: 'buff',
            rarity: 'common',
            base_price: 75,
            cooldown_seconds: 45,
            duration_seconds: 25,
            effect_data: {
                effect_type: 'visual_filter',
                visual_effect: 'saturate'
            }
        },
        {
            name: 'desaturated',
            display_name: 'Desaturated',
            emoji: '☁️',
            description: 'Makes colors washed out for 25 seconds',
            item_type: 'debuff',
            rarity: 'common',
            base_price: 100,
            cooldown_seconds: 50,
            duration_seconds: 25,
            effect_data: {
                effect_type: 'visual_filter',
                visual_effect: 'desaturate'
            }
        },
        {
            name: 'hue_shift',
            display_name: 'Hue Shift',
            emoji: '🎨',
            description: 'Shifts all colors for 20 seconds',
            item_type: 'buff',
            rarity: 'common',
            base_price: 100,
            cooldown_seconds: 50,
            duration_seconds: 20,
            effect_data: {
                effect_type: 'visual_filter',
                visual_effect: 'hue_rotate'
            }
        },
        {
            name: 'edge_detection',
            display_name: 'Edge Detection',
            emoji: '🔲',
            description: 'Shows only edges for 15 seconds',
            item_type: 'debuff',
            rarity: 'uncommon',
            base_price: 175,
            cooldown_seconds: 70,
            duration_seconds: 15,
            effect_data: {
                effect_type: 'visual_filter',
                visual_effect: 'edge_detect'
            }
        },
        {
            name: 'emboss',
            display_name: 'Emboss',
            emoji: '🗿',
            description: 'Applies emboss effect for 20 seconds',
            item_type: 'buff',
            rarity: 'common',
            base_price: 100,
            cooldown_seconds: 50,
            duration_seconds: 20,
            effect_data: {
                effect_type: 'visual_filter',
                visual_effect: 'emboss'
            }
        },
        {
            name: 'vignette',
            display_name: 'Vignette',
            emoji: '🖼️',
            description: 'Adds dark vignette for 30 seconds',
            item_type: 'buff',
            rarity: 'common',
            base_price: 75,
            cooldown_seconds: 45,
            duration_seconds: 30,
            effect_data: {
                effect_type: 'visual_filter',
                visual_effect: 'vignette'
            }
        },
        
        // Orientation Effects
        {
            name: 'mirror',
            display_name: 'Mirror',
            emoji: '🪞',
            description: 'Mirrors the stream horizontally for 20 seconds',
            item_type: 'debuff',
            rarity: 'common',
            base_price: 125,
            cooldown_seconds: 60,
            duration_seconds: 20,
            effect_data: {
                effect_type: 'visual_filter',
                visual_effect: 'mirror'
            }
        },
        {
            name: 'upside_down',
            display_name: 'Upside Down',
            emoji: '🙃',
            description: 'Flips stream upside down for 20 seconds',
            item_type: 'debuff',
            rarity: 'uncommon',
            base_price: 175,
            cooldown_seconds: 70,
            duration_seconds: 20,
            effect_data: {
                effect_type: 'visual_filter',
                visual_effect: 'flip_vertical'
            }
        },
        {
            name: 'rotate_90',
            display_name: 'Rotate 90°',
            emoji: '↪️',
            description: 'Rotates stream 90 degrees for 20 seconds',
            item_type: 'debuff',
            rarity: 'uncommon',
            base_price: 175,
            cooldown_seconds: 70,
            duration_seconds: 20,
            effect_data: {
                effect_type: 'visual_filter',
                visual_effect: 'rotate_90'
            }
        },
        
        // Distortion Effects
        {
            name: 'wave_distortion',
            display_name: 'Wave Distortion',
            emoji: '🌊',
            description: 'Adds wave distortion for 15 seconds',
            item_type: 'debuff',
            rarity: 'uncommon',
            base_price: 150,
            cooldown_seconds: 65,
            duration_seconds: 15,
            effect_data: {
                effect_type: 'visual_filter',
                visual_effect: 'wave'
            }
        },
        {
            name: 'wobble',
            display_name: 'Wobble',
            emoji: '🔄',
            description: 'Makes stream wobble for 15 seconds',
            item_type: 'debuff',
            rarity: 'uncommon',
            base_price: 150,
            cooldown_seconds: 65,
            duration_seconds: 15,
            effect_data: {
                effect_type: 'visual_filter',
                visual_effect: 'wobble'
            }
        },
        
        // Style Effects
        {
            name: 'vintage_film',
            display_name: 'Vintage Film',
            emoji: '📽️',
            description: 'Applies vintage film look for 30 seconds',
            item_type: 'buff',
            rarity: 'common',
            base_price: 100,
            cooldown_seconds: 50,
            duration_seconds: 30,
            effect_data: {
                effect_type: 'visual_filter',
                visual_effect: 'vintage'
            }
        },
        {
            name: 'thermal_vision',
            display_name: 'Thermal Vision',
            emoji: '🔥',
            description: 'Shows thermal vision for 25 seconds',
            item_type: 'buff',
            rarity: 'uncommon',
            base_price: 150,
            cooldown_seconds: 60,
            duration_seconds: 25,
            effect_data: {
                effect_type: 'visual_filter',
                visual_effect: 'thermal'
            }
        }
    ];
    
    try {
        let addedCount = 0;
        let skippedCount = 0;
        
        for (const item of visualFxItems) {
            // Check if item already exists
            const existingItem = await getAsync('SELECT * FROM items WHERE name = ?', [item.name]);
            
            if (existingItem) {
                console.log(`⏭️  Skipped: ${item.display_name} (already exists)`);
                skippedCount++;
                continue;
            }
            
            // Create the item
            const result = await runAsync(`
                INSERT INTO items (
                    name, display_name, emoji, description, item_type, 
                    rarity, base_price, is_purchasable, is_active, 
                    cooldown_seconds, max_stack, duration_seconds, effect_data, stack_behavior
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                item.name,
                item.display_name,
                item.emoji,
                item.description,
                item.item_type,
                item.rarity,
                item.base_price,
                true,  // is_purchasable
                true,  // is_active
                item.cooldown_seconds,
                0,     // max_stack (0 = unlimited)
                item.duration_seconds,
                JSON.stringify(item.effect_data),
                'replace'  // stack_behavior
            ]);
            
            console.log(`✅ Added: ${item.display_name} (${item.emoji})`);
            addedCount++;
        }
        
        console.log('\n' + '=' .repeat(50));
        console.log(`🎨 Visual Effects Items Summary:`);
        console.log(`   Added: ${addedCount} new items`);
        console.log(`   Skipped: ${skippedCount} existing items`);
        console.log(`   Total: ${visualFxItems.length} items processed`);
        
        if (addedCount > 0) {
            console.log('\n✨ New items are now available in:');
            console.log('   1. The shop (can be purchased with coins)');
            console.log('   2. User inventories (if given via admin)');
            console.log('   3. Visual FX admin panel for testing');
        }
        
    } catch (error) {
        console.error('❌ Error adding visual effects items:', error);
    } finally {
        process.exit(0);
    }
}

// Run the script
addVisualFxItems();