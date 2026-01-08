#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

console.log('🔧 Fixing visual effects re-application for resuming streamers...\n');

// The fix: When a streamer starts streaming and has active buffs,
// we need to re-trigger the visual effects for those buffs

const fixes = [
  {
    file: '/root/onestreamer/server/index.js',
    description: 'Re-apply visual effects when streamer with buffs resumes',
    changes: [
      {
        find: `      // Emit streamer buff updates when user becomes current streamer
      try {
        const streamerBuffs = await buffDebuffService.getActiveBuffsForCurrentStreamer();
        console.log(\`🎭 BUFF: Emitting streamer buffs for new streamer \${socket.id}: \${streamerBuffs.length} buffs\`);
        io.emit('streamer-buffs-update', { buffs: streamerBuffs });
      } catch (error) {
        console.error('❌ BUFF: Error emitting streamer buffs on stream start:', error);
      }`,
        replace: `      // Emit streamer buff updates when user becomes current streamer
      try {
        const streamerBuffs = await buffDebuffService.getActiveBuffsForCurrentStreamer();
        console.log(\`🎭 BUFF: Emitting streamer buffs for new streamer \${socket.id}: \${streamerBuffs.length} buffs\`);
        io.emit('streamer-buffs-update', { buffs: streamerBuffs });
        
        // Re-apply visual effects for active buffs when streamer resumes
        if (streamerBuffs.length > 0) {
          console.log(\`🎨 VISUAL FX: Re-applying visual effects for \${streamerBuffs.length} active buffs\`);
          
          // Get the user ID for this streamer
          const session = sessionService.getSessionBySocketId(socket.id);
          const streamerId = session?.userId;
          
          if (streamerId) {
            // Re-trigger visual effects for each active buff
            for (const buff of streamerBuffs) {
              // Check if this buff has visual effects
              const visualEffectItems = [
                'emboss', 'pixelate', 'motion_blur', 'glitch_bomb', 
                'thermal_vision', 'rotate_90', 'potato', 'smoke_bomb', 
                'spotlight', 'disco_ball', 'confetti_cannon', 
                'rainbow_effect', 'freeze_frame'
              ];
              
              if (visualEffectItems.includes(buff.itemName)) {
                console.log(\`🎨 VISUAL FX: Re-triggering effect for \${buff.displayName} (itemName: \${buff.itemName})\`);
                
                // Re-emit the buff-applied event to trigger visual effects
                // This simulates the original buff application
                const buffData = {
                  id: buff.id,
                  user_id: streamerId,
                  item_id: buff.itemId,
                  item_name: buff.itemName,
                  display_name: buff.displayName,
                  buff_type: buff.buffType,
                  remaining_seconds: buff.remainingSeconds,
                  stream_id: socket.id, // Current stream ID
                  isResumed: true // Flag to indicate this is a resumed effect
                };
                
                // Emit to the BuffDebuffService to trigger visual effects
                if (buffDebuffService) {
                  buffDebuffService.emit('buff-applied', buffData);
                  console.log(\`✅ VISUAL FX: Re-triggered \${buff.itemName} effect for resuming streamer\`);
                }
              }
            }
          } else {
            console.log(\`⚠️ VISUAL FX: Could not get user ID for streamer \${socket.id}\`);
          }
        }
      } catch (error) {
        console.error('❌ BUFF: Error emitting streamer buffs on stream start:', error);
      }`
      }
    ]
  },
  {
    file: '/root/onestreamer/server/services/CanvasFxService.js',
    description: 'Handle resumed buff effects for canvas effects like smoke',
    changes: [
      {
        find: `    // Handle buff applied event
    async handleBuffApplied(buffData) {
        console.log(\`🎨 CANVASFX: handleBuffApplied called with buffData:\`, buffData);
        
        // Only handle items that have canvas effects
        if (!this.isBuffSyncedEffect({ name: buffData.item_name })) {
            console.log(\`🎨 CANVASFX: Item \${buffData.item_name} does not have synced canvas effects, skipping\`);
            return;
        }`,
        replace: `    // Handle buff applied event
    async handleBuffApplied(buffData) {
        console.log(\`🎨 CANVASFX: handleBuffApplied called with buffData:\`, buffData);
        
        // Check if this is a resumed buff (streamer coming back online with active buff)
        if (buffData.isResumed) {
            console.log(\`🎨 CANVASFX: This is a RESUMED buff for \${buffData.item_name} - re-applying visual effect\`);
        }
        
        // Only handle items that have canvas effects
        if (!this.isBuffSyncedEffect({ name: buffData.item_name })) {
            console.log(\`🎨 CANVASFX: Item \${buffData.item_name} does not have synced canvas effects, skipping\`);
            return;
        }`
      }
    ]
  },
  {
    file: '/root/onestreamer/server/services/VisualFxService.js',
    description: 'Handle resumed buff effects for video effects',
    changes: [
      {
        find: `    // Handle buff applied event
    async handleBuffApplied(buffData) {
        console.log(\`🎬 VISUALFX: ========================================\`);
        console.log(\`🎬 VISUALFX: handleBuffApplied called at \${new Date().toISOString()}\`);
        console.log(\`🎬 VISUALFX: Buff data:\`, JSON.stringify(buffData, null, 2));
        console.log(\`🎬 VISUALFX: ========================================\`);`,
        replace: `    // Handle buff applied event
    async handleBuffApplied(buffData) {
        console.log(\`🎬 VISUALFX: ========================================\`);
        console.log(\`🎬 VISUALFX: handleBuffApplied called at \${new Date().toISOString()}\`);
        console.log(\`🎬 VISUALFX: Buff data:\`, JSON.stringify(buffData, null, 2));
        
        // Check if this is a resumed buff (streamer coming back online with active buff)
        if (buffData.isResumed) {
            console.log(\`🎬 VISUALFX: This is a RESUMED buff for \${buffData.item_name} - re-applying visual effect\`);
        }
        
        console.log(\`🎬 VISUALFX: ========================================\`);`
      }
    ]
  }
];

// Apply fixes
fixes.forEach(fix => {
  console.log(`📝 Applying fix to ${fix.file}: ${fix.description}`);
  
  try {
    let content = fs.readFileSync(fix.file, 'utf8');
    let modified = false;
    
    fix.changes.forEach(change => {
      if (content.includes(change.find)) {
        content = content.replace(change.find, change.replace);
        modified = true;
        console.log('   ✅ Applied change');
      } else {
        console.log('   ⚠️ Pattern not found (might already be fixed or code has changed)');
      }
    });
    
    if (modified) {
      // Backup original file
      const backupFile = fix.file + '.backup-' + Date.now();
      fs.copyFileSync(fix.file, backupFile);
      console.log(`   📦 Backed up to ${backupFile}`);
      
      // Write modified content
      fs.writeFileSync(fix.file, content);
      console.log('   ✅ File updated successfully');
    }
  } catch (error) {
    console.error(`   ❌ Error: ${error.message}`);
  }
  
  console.log('');
});

console.log('🎉 Fix complete! Visual effects will now re-apply when streamers with active buffs resume streaming.');
console.log('');
console.log('How it works:');
console.log('1. When a streamer starts streaming, we check for active buffs');
console.log('2. For each buff with visual effects, we re-emit the buff-applied event');
console.log('3. The visual effects services (CanvasFx and VisualFx) handle these events');
console.log('4. Effects are re-applied with the remaining duration');
console.log('');
console.log('To apply the changes:');
console.log('1. Restart the server: pm2 restart onestreamer-server');
console.log('2. Test by applying a visual effect to a streamer');
console.log('3. Have the streamer disconnect and reconnect');
console.log('4. The visual effect should automatically re-apply');