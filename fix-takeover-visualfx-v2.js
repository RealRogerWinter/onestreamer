#!/usr/bin/env node

const fs = require('fs');

console.log('🔧 Fixing visual effects re-application on stream takeover (v2)...\n');

// The problem: Effects are not properly cleaned up and re-applied on takeover

const fix = `      // Emit streamer buff updates when user becomes current streamer
      try {
        // CRITICAL: Clear any existing visual effects first to prevent conflicts
        console.log(\`🧹 VISUAL FX: Clearing existing effects before takeover\`);
        if (visualFxService) {
          visualFxService.clearAllEffects();
        }
        
        // Wait a moment for cleanup to complete
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // First, get buffs that should be displayed (might be from previous streamer)
        const streamerBuffs = await buffDebuffService.getActiveBuffsForCurrentStreamer();
        console.log(\`🎭 BUFF: Emitting streamer buffs for new streamer \${socket.id}: \${streamerBuffs.length} buffs\`);
        io.emit('streamer-buffs-update', { buffs: streamerBuffs });
        
        // Re-apply visual effects for ANY active stream-affecting buffs
        console.log(\`🎨 VISUAL FX: Checking for active visual effect buffs to re-apply after takeover...\`);
        
        // Get ALL active buffs that have visual effects
        const allActiveBuffs = await runAsync(\`
          SELECT ab.*, i.name as item_name, i.display_name, i.emoji, i.effect_data,
                 ab.user_id, ab.remaining_seconds, ab.item_id, ab.buff_type
          FROM active_buffs ab
          JOIN items i ON ab.item_id = i.id
          WHERE ab.is_active = 1 AND ab.remaining_seconds > 0
          ORDER BY ab.applied_at DESC
        \`);
        
        if (allActiveBuffs && allActiveBuffs.length > 0) {
          console.log(\`🎨 VISUAL FX: Found \${allActiveBuffs.length} total active buffs in database\`);
          
          // Visual effect items that should re-apply to the stream
          const visualEffectItems = {
            // Canvas effects
            'smoke_bomb': true,
            'spotlight': true,
            'disco_ball': true,
            'confetti_cannon': true,
            'rainbow_effect': true,
            
            // Video effects
            'emboss': true,
            'pixelate': true,
            'motion_blur': true,
            'glitch_bomb': true,
            'thermal_vision': true,
            'rotate_90': true,
            'potato': true,
            'freeze_frame': true,
            'upside_down': true,
            'mirror': true,
            'invert_colors': true,
            'darkness': true,
            'overexposed': true,
            'stream_reducer': true
          };
          
          // Delay between re-applying effects to prevent race conditions
          let effectDelay = 0;
          
          for (const buff of allActiveBuffs) {
            if (visualEffectItems[buff.item_name]) {
              // Schedule effect re-application with staggered timing
              setTimeout(async () => {
                console.log(\`🎨 VISUAL FX: Re-triggering \${buff.display_name} (from user \${buff.user_id}) for takeover\`);
                
                // Create properly formatted buff data for re-application
                const buffData = {
                  id: buff.id,
                  user_id: buff.user_id,
                  item_id: buff.item_id,
                  item_name: buff.item_name,
                  display_name: buff.display_name,
                  buff_type: buff.buff_type || 'debuff',
                  remaining_seconds: buff.remaining_seconds,
                  duration_seconds: buff.remaining_seconds,
                  stream_id: socket.id,
                  effect_data: buff.effect_data,
                  metadata: buff.metadata,
                  isResumed: true,
                  isTakeover: true
                };
                
                // Emit to BuffDebuffService which will trigger the visual effects
                if (buffDebuffService) {
                  buffDebuffService.emit('buff-applied', buffData);
                  console.log(\`✅ VISUAL FX: Scheduled re-trigger of \${buff.item_name} effect\`);
                }
              }, effectDelay);
              
              // Increment delay for next effect (100ms between each)
              effectDelay += 100;
            }
          }
          
          if (effectDelay > 0) {
            console.log(\`⏱️ VISUAL FX: Scheduled \${effectDelay / 100} visual effects to re-apply over \${effectDelay}ms\`);
          }
        } else {
          console.log(\`🎨 VISUAL FX: No active buffs found to re-apply\`);
        }
      } catch (error) {
        console.error('❌ BUFF: Error emitting streamer buffs on stream start:', error);
      }`;

// Read the current file
const filePath = '/root/onestreamer/server/index.js';
let content = fs.readFileSync(filePath, 'utf8');

// Find the section to replace
const startMarker = '      // Emit streamer buff updates when user becomes current streamer';
const endMarker = '      } catch (error) {\n        console.error(\'❌ BUFF: Error emitting streamer buffs on stream start:\', error);\n      }';

const startIndex = content.indexOf(startMarker);
if (startIndex === -1) {
  console.error('❌ Could not find the start marker in the file');
  process.exit(1);
}

const endIndex = content.indexOf(endMarker, startIndex);
if (endIndex === -1) {
  console.error('❌ Could not find the end marker in the file');
  process.exit(1);
}

// Backup the file
const backupFile = filePath + '.backup-' + Date.now();
fs.copyFileSync(filePath, backupFile);
console.log(`📦 Backed up to ${backupFile}`);

// Replace the section
const before = content.substring(0, startIndex);
const after = content.substring(endIndex + endMarker.length);
content = before + fix + after;

// Write the file
fs.writeFileSync(filePath, content);
console.log('✅ File updated successfully');

console.log('\n🎉 Fix complete!');
console.log('\nWhat this fixes:');
console.log('1. Clears existing visual effects before takeover to prevent conflicts');
console.log('2. Re-applies ALL active visual effect buffs with proper timing');
console.log('3. Uses staggered application (100ms between effects) to prevent race conditions');
console.log('4. Includes all visual effect types (canvas, video, stream effects)');
console.log('\nTo apply: pm2 restart onestreamer-server');