#!/usr/bin/env node

const fs = require('fs');

console.log('🔧 Fixing visual effects re-application on stream takeover...\n');

// The problem: When a new streamer takes over, buffs belong to the previous streamer
// but visual effects should still apply to the stream

const fix = `      // Emit streamer buff updates when user becomes current streamer
      try {
        // First, get buffs that should be displayed (might be from previous streamer)
        const streamerBuffs = await buffDebuffService.getActiveBuffsForCurrentStreamer();
        console.log(\`🎭 BUFF: Emitting streamer buffs for new streamer \${socket.id}: \${streamerBuffs.length} buffs\`);
        io.emit('streamer-buffs-update', { buffs: streamerBuffs });
        
        // Re-apply visual effects for ANY active stream-affecting buffs
        // This includes buffs from the previous streamer that should still be visible
        console.log(\`🎨 VISUAL FX: Checking for active visual effect buffs to re-apply...\`);
        
        // Get ALL active buffs that have visual effects, not just for current user
        const allActiveBuffs = await runAsync(\`
          SELECT ab.*, i.name as item_name, i.display_name, i.emoji, i.effect_data,
                 ab.user_id, ab.remaining_seconds
          FROM active_buffs ab
          JOIN items i ON ab.item_id = i.id
          WHERE ab.is_active = 1 AND ab.remaining_seconds > 0
          ORDER BY ab.applied_at DESC
        \`);
        
        if (allActiveBuffs && allActiveBuffs.length > 0) {
          console.log(\`🎨 VISUAL FX: Found \${allActiveBuffs.length} total active buffs in database\`);
          
          // Visual effect items that should re-apply to the stream
          const visualEffectItems = [
            'emboss', 'pixelate', 'motion_blur', 'glitch_bomb', 
            'thermal_vision', 'rotate_90', 'potato', 'smoke_bomb', 
            'spotlight', 'disco_ball', 'confetti_cannon', 
            'rainbow_effect', 'freeze_frame'
          ];
          
          // Re-apply visual effects for ALL visual buffs (they affect the stream, not just the user)
          for (const buff of allActiveBuffs) {
            if (visualEffectItems.includes(buff.item_name)) {
              console.log(\`🎨 VISUAL FX: Re-triggering \${buff.display_name} (from user \${buff.user_id}) for new stream\`);
              
              // Re-emit the buff-applied event to trigger visual effects
              const buffData = {
                id: buff.id,
                user_id: buff.user_id, // Original user who applied the buff
                item_id: buff.item_id,
                item_name: buff.item_name,
                display_name: buff.display_name,
                buff_type: buff.buff_type,
                remaining_seconds: buff.remaining_seconds,
                stream_id: socket.id, // NEW streamer's socket ID
                isResumed: true, // Flag to indicate this is a resumed effect
                isTakeover: true // Additional flag for takeover scenario
              };
              
              // Emit to the BuffDebuffService to trigger visual effects
              if (buffDebuffService) {
                buffDebuffService.emit('buff-applied', buffData);
                console.log(\`✅ VISUAL FX: Re-triggered \${buff.item_name} effect for takeover stream\`);
              }
              
              // Also directly trigger canvas/visual effects if services are available
              const canvasFxService = req.app?.get?.('canvasFxService');
              const visualFxService = req.app?.get?.('visualFxService');
              
              if (canvasFxService && ['smoke_bomb', 'spotlight', 'disco_ball', 'confetti_cannon', 'rainbow_effect'].includes(buff.item_name)) {
                console.log(\`🎨 VISUAL FX: Directly triggering canvas effect for \${buff.item_name}\`);
                canvasFxService.handleBuffApplied(buffData);
              }
              
              if (visualFxService && ['emboss', 'pixelate', 'motion_blur', 'glitch_bomb', 'thermal_vision', 'rotate_90', 'potato', 'freeze_frame'].includes(buff.item_name)) {
                console.log(\`🎬 VISUAL FX: Directly triggering video effect for \${buff.item_name}\`);
                visualFxService.handleBuffApplied(buffData);
              }
            }
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
console.log('1. When a new streamer takes over, ALL active visual effect buffs are re-applied');
console.log('2. This includes buffs that were on the previous streamer');
console.log('3. Visual effects (smoke, pixelate, etc.) will now persist across takeovers');
console.log('4. The effects will continue with their remaining duration');
console.log('\nTo apply: pm2 restart onestreamer-server');