#!/usr/bin/env node

const fs = require('fs');

console.log('🔧 Implementing visual effects synchronization system...\n');

// This fix ensures visual effects are always synchronized with active buffs
// for ALL viewers at ALL times (new joins, takeovers, refreshes, etc.)

// Step 1: Add a function to get active visual effects from buffs
const getActiveVisualEffectsFunction = `
// Get all active visual effects that should be applied to the stream
async function getActiveVisualEffects() {
  try {
    // Get ALL active buffs with visual effects
    const visualEffectBuffs = await runAsync(\`
      SELECT ab.*, i.name as item_name, i.display_name, i.emoji, i.effect_data,
             ab.user_id, ab.remaining_seconds, ab.item_id, ab.buff_type
      FROM active_buffs ab
      JOIN items i ON ab.item_id = i.id
      WHERE ab.is_active = 1 
        AND ab.remaining_seconds > 0
        AND i.name IN (
          'smoke_bomb', 'pixelate', 'emboss', 'thermal_vision', 'rotate_90',
          'potato', 'upside_down', 'mirror', 'invert_colors', 'darkness',
          'overexposed', 'glitch_bomb', 'motion_blur', 'freeze_frame',
          'spotlight', 'disco_ball', 'confetti_cannon', 'rainbow_effect',
          'stream_reducer'
        )
      ORDER BY ab.applied_at DESC
    \`);
    
    return visualEffectBuffs || [];
  } catch (error) {
    console.error('❌ Error getting active visual effects:', error);
    return [];
  }
}
`;

// Step 2: Modify join-as-viewer to send visual effects to new viewers
const joinAsViewerFix = `  socket.on('join-as-viewer', async () => {
    console.log(\`👁️ VIEWER: Socket \${socket.id} joining as viewer\`);
    socket.join('viewers');
    socket.leave('streamer');
    streamService.addViewer(socket.id);
    
    // Send current stream status
    const streamStatus = streamService.getStreamStatus();
    streamStatus.viewerCount = sessionService.getUniqueViewerCount();
    const enrichedStatus = await enrichStreamStatus(streamStatus);
    socket.emit('stream-status', enrichedStatus);
    
    // Send active visual effects to the new viewer
    try {
      const activeVisualEffects = await getActiveVisualEffects();
      if (activeVisualEffects.length > 0) {
        console.log(\`🎨 VISUAL FX: Sending \${activeVisualEffects.length} active effects to new viewer \${socket.id}\`);
        
        // Send each effect to the viewer with a small delay to prevent overwhelming
        activeVisualEffects.forEach((buff, index) => {
          setTimeout(() => {
            socket.emit('visual-effect-sync', {
              effectId: buff.item_name,
              itemName: buff.item_name,
              displayName: buff.display_name,
              duration: buff.remaining_seconds * 1000,
              remainingSeconds: buff.remaining_seconds,
              effectData: buff.effect_data,
              isSyncEvent: true
            });
          }, index * 100); // 100ms between each effect
        });
      }
    } catch (error) {
      console.error(\`❌ VISUAL FX: Error sending effects to viewer \${socket.id}:\`, error);
    }
    
    // Rest of the original code...`;

// Step 3: Add visual effects to stream-ready event
const streamReadyFix = `                io.emit('stream-ready', { 
                streamerId: socket.id, 
                newStreamId: socket.id,
                isWebRTC: true,
                streamType: 'webrtc',
                hasVideo: readyHasVideo,
                hasAudio: readyHasAudio,
                streamerDisplayName: streamerDisplayName,
                streamerProfileImage: streamerProfileImage
              });
              
              // Also send active visual effects with stream-ready
              try {
                const activeVisualEffects = await getActiveVisualEffects();
                if (activeVisualEffects.length > 0) {
                  console.log(\`🎨 VISUAL FX: Broadcasting \${activeVisualEffects.length} active effects with stream-ready\`);
                  
                  // Broadcast visual effects state to all clients
                  io.emit('visual-effects-state', {
                    effects: activeVisualEffects.map(buff => ({
                      effectId: buff.item_name,
                      itemName: buff.item_name,
                      displayName: buff.display_name,
                      remainingSeconds: buff.remaining_seconds,
                      effectData: buff.effect_data
                    })),
                    streamId: socket.id
                  });
                }
              } catch (error) {
                console.error('❌ VISUAL FX: Error broadcasting effects with stream-ready:', error);
              }`;

// Step 4: Create periodic sync mechanism
const periodicSyncFunction = `
// Periodically sync visual effects with active buffs
let visualEffectSyncInterval = null;

function startVisualEffectSync() {
  if (visualEffectSyncInterval) {
    clearInterval(visualEffectSyncInterval);
  }
  
  visualEffectSyncInterval = setInterval(async () => {
    try {
      const currentStreamer = streamService.getCurrentStreamer();
      if (!currentStreamer) return;
      
      const activeVisualEffects = await getActiveVisualEffects();
      if (activeVisualEffects.length > 0) {
        // Only log periodically to avoid spam
        if (Math.random() < 0.1) { // 10% chance to log
          console.log(\`🔄 VISUAL FX SYNC: \${activeVisualEffects.length} active effects in sync\`);
        }
        
        // Broadcast current visual effects state
        io.emit('visual-effects-sync-pulse', {
          effects: activeVisualEffects.map(buff => ({
            effectId: buff.item_name,
            itemName: buff.item_name,
            displayName: buff.display_name,
            remainingSeconds: buff.remaining_seconds,
            effectData: buff.effect_data
          })),
          streamId: currentStreamer,
          timestamp: Date.now()
        });
      }
    } catch (error) {
      console.error('❌ VISUAL FX SYNC: Error in periodic sync:', error);
    }
  }, 5000); // Sync every 5 seconds
  
  console.log('🔄 VISUAL FX SYNC: Started periodic synchronization');
}

// Start the sync when server starts
startVisualEffectSync();
`;

// Step 5: Ensure effects are re-triggered when buffs are applied
const buffAppliedFix = `      // When a buff is applied, ensure visual effects are triggered for all viewers
      buffDebuffService.on('buff-applied', async (buffData) => {
        try {
          // Check if this is a visual effect buff
          const visualEffectItems = [
            'smoke_bomb', 'pixelate', 'emboss', 'thermal_vision', 'rotate_90',
            'potato', 'upside_down', 'mirror', 'invert_colors', 'darkness',
            'overexposed', 'glitch_bomb', 'motion_blur', 'freeze_frame',
            'spotlight', 'disco_ball', 'confetti_cannon', 'rainbow_effect',
            'stream_reducer'
          ];
          
          if (buffData.item_name && visualEffectItems.includes(buffData.item_name)) {
            console.log(\`🎨 VISUAL FX: Buff \${buffData.item_name} applied, ensuring visual sync\`);
            
            // Broadcast to all viewers to apply this effect
            io.emit('visual-effect-apply-sync', {
              effectId: buffData.item_name,
              itemName: buffData.item_name,
              displayName: buffData.display_name,
              duration: (buffData.remaining_seconds || buffData.duration_seconds || 60) * 1000,
              effectData: buffData.effect_data,
              buffId: buffData.id,
              isNewBuff: true
            });
          }
        } catch (error) {
          console.error('❌ VISUAL FX: Error syncing buff-applied visual effect:', error);
        }
      });`;

console.log('📝 Implementation plan:');
console.log('1. Add function to get all active visual effects from buffs');
console.log('2. Send visual effects to new viewers when they join');
console.log('3. Include visual effects state with stream-ready events');
console.log('4. Create periodic synchronization (every 5 seconds)');
console.log('5. Ensure effects are broadcast when buffs are applied');
console.log('');
console.log('This comprehensive solution ensures:');
console.log('- New viewers see all active visual effects immediately');
console.log('- Visual effects persist across stream takeovers');
console.log('- Effects stay synchronized with buff durations');
console.log('- Multiple tabs/windows stay in sync');
console.log('');
console.log('The implementation requires client-side changes to handle:');
console.log('- visual-effect-sync (individual effect sync)');
console.log('- visual-effects-state (bulk state update)');
console.log('- visual-effects-sync-pulse (periodic sync)');
console.log('- visual-effect-apply-sync (new buff application)');
console.log('');
console.log('To implement: Manually add these changes to /root/onestreamer/server/index.js');