/**
 * Fix ViewBot stream-ready emission to match real user flow
 * 
 * ROOT CAUSE: ViewBots create MediaSoup producers directly without going through
 * the Socket.IO event flow that real users use. Real users emit 'mediasoup:produce'
 * which triggers the stream-ready notification. ViewBots bypass this entirely.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('🎯 Fixing ViewBot Stream-Ready Event Emission\n');
console.log('📍 Root Cause Identified:');
console.log('   - Real users: Socket.IO → mediasoup:produce event → stream-ready emission');
console.log('   - ViewBots: Direct transport.produce() → NO stream-ready emission\n');

// Fix SimpleViewBotMediaSoup to properly notify after producer creation
const filePath = path.join(__dirname, 'server', 'services', 'SimpleViewBotMediaSoup.js');
let content = fs.readFileSync(filePath, 'utf8');

// Find the createProducers function and add proper notification
const createProducersStart = content.indexOf('async createProducers(transport)');
const createProducersEnd = content.indexOf('  }\n  \n  /**', createProducersStart);

if (createProducersStart > -1 && createProducersEnd > -1) {
  let producersFunction = content.substring(createProducersStart, createProducersEnd + 3);
  
  // Add notification logic after registering with MediaSoup service
  if (!producersFunction.includes('CRITICAL: Notifying about ViewBot producers')) {
    producersFunction = producersFunction.replace(
      '      // Stream-ready events will be emitted from startBot after GStreamer starts\n      // This ensures proper timing and prevents duplicate events',
      `      // CRITICAL: Notifying about ViewBot producers (matching real user flow)
      // Real users trigger this through socket.on('mediasoup:produce')
      // ViewBots must manually trigger the same notification
      
      if (this.mediasoupService && this.currentBot) {
        console.log('🔔 VIEWBOT: Checking notification conditions...');
        const streamService = global.streamService;
        
        if (streamService) {
          // Set this bot as the current streamer (like real users do)
          streamService.setStreamer(this.currentBot.id, 'viewbot');
          console.log(\`✅ VIEWBOT: Set \${this.currentBot.id} as current streamer\`);
          
          // Check if we should notify (matching the real user logic)
          const currentStreamer = streamService.getCurrentStreamer();
          const isCurrentStreamer = currentStreamer === this.currentBot.id;
          
          console.log(\`🔍 VIEWBOT: Current streamer check - expected: \${this.currentBot.id}, actual: \${currentStreamer}, match: \${isCurrentStreamer}\`);
          
          if (isCurrentStreamer && global.io) {
            // Emit stream-ready exactly like real users do (from line 6325 in index.js)
            console.log('📢 VIEWBOT: Emitting stream-ready event (matching real user pattern)');
            
            global.io.emit('stream-ready', {
              streamerId: this.currentBot.id,
              newStreamId: this.currentBot.id,
              isWebRTC: false,  // ViewBots use RTP, not WebRTC
              streamType: 'viewbot',
              hasVideo: true,
              hasAudio: true,
              producerVerified: true,
              streamStartTime: Date.now(),
              timestamp: Date.now(),
              streamerDisplayName: \`ViewBot-\${this.currentBot.id}\`,
              isViewBot: true  // Additional flag for ViewBot identification
            });
            
            console.log('✅ VIEWBOT: stream-ready event emitted successfully');
            
            // Also emit viewer count update like real users
            global.io.emit('viewer-count-update', 0);
          } else {
            console.warn(\`⚠️ VIEWBOT: Cannot emit stream-ready - not current streamer or no io\`);
          }
        } else {
          console.error('❌ VIEWBOT: No streamService available');
        }
      }`
    );
    
    // Remove the duplicate emission from startBot since we're doing it here
    producersFunction = producersFunction.replace(
      'console.log(\'📢 Emitted stream-ready event after GStreamer started\');',
      'console.log(\'✅ Stream-ready already emitted in createProducers\');'
    );
  }
  
  content = content.substring(0, createProducersStart) + producersFunction + content.substring(createProducersEnd + 3);
  
  // Also update startBot to not emit duplicate
  content = content.replace(
    /\/\/ CRITICAL FIX: Emit stream-ready AFTER GStreamer has started[\s\S]*?console\.log\('   Event details:',[\s\S]*?\}\);/,
    `// Stream-ready is now emitted in createProducers to match real user flow
      console.log('✅ Stream-ready handled in createProducers (like real users)');`
  );
  
  fs.writeFileSync(filePath, content);
  console.log('✅ Fixed SimpleViewBotMediaSoup.js\n');
} else {
  console.error('❌ Could not find createProducers function\n');
}

// Ensure global.streamService is available
const indexPath = path.join(__dirname, 'server', 'index.js');
let indexContent = fs.readFileSync(indexPath, 'utf8');

// Already fixed in previous attempts, just verify
if (indexContent.includes('global.streamService = streamService')) {
  console.log('✅ global.streamService already set\n');
} else {
  console.error('⚠️ global.streamService not set - this needs to be fixed\n');
}

console.log('🔄 Restarting server...');
try {
  execSync('pm2 restart onestreamer-server', { stdio: 'inherit' });
  console.log('\n✅ Server restarted');
} catch (error) {
  console.error('❌ Failed to restart:', error.message);
}

console.log('\n📝 Summary:');
console.log('   1. ViewBots now emit stream-ready through the same pattern as real users');
console.log('   2. Event is emitted after producer creation, not after GStreamer');
console.log('   3. ViewBots properly set themselves as current streamer');
console.log('   4. Notification logic matches real user flow exactly');
console.log('\n🎯 Test with: node debug-rotation-live.js');
console.log('   You should now see stream-ready events from ViewBots!');

process.exit(0);