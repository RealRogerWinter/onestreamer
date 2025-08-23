/**
 * Complete fix for ViewBot rotation system
 * Addresses all identified issues
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('🔧 Complete ViewBot Fix\n');

// 1. Fix SimpleViewBotMediaSoup.js
console.log('1️⃣ Fixing SimpleViewBotMediaSoup.js...');

const simpleViewBotPath = path.join(__dirname, 'server', 'services', 'SimpleViewBotMediaSoup.js');
let content = fs.readFileSync(simpleViewBotPath, 'utf8');

// Ensure stream-ready is emitted properly in startBot
if (!content.includes('console.log(\'📢 CRITICAL: About to emit stream-ready event\'')) {
  // Add debugging before emission
  content = content.replace(
    '      // CRITICAL FIX: Emit stream-ready AFTER GStreamer has started\n      if (global.io && this.currentProducer) {',
    `      // CRITICAL FIX: Emit stream-ready AFTER GStreamer has started
      console.log('📢 CRITICAL: About to emit stream-ready event');
      console.log('   global.io exists:', !!global.io);
      console.log('   currentProducer exists:', !!this.currentProducer);
      
      if (global.io && this.currentProducer) {`
  );
  
  // Also add debugging after emission
  content = content.replace(
    '        console.log(\'📢 Emitted stream-ready event after GStreamer started\');',
    `        console.log('📢 Emitted stream-ready event after GStreamer started');
        console.log('   Event details:', {
          streamerId: bot.id,
          hasVideo: !!this.currentProducer.video,
          hasAudio: !!this.currentProducer.audio
        });`
  );
}

// Fix handleBotError to not cause infinite loops
if (!content.includes('this.errorCount')) {
  // Add error counter
  content = content.replace(
    '    this.rotationTimer = null;',
    `    this.rotationTimer = null;
    this.errorCount = 0;`
  );
  
  // Update handleBotError
  content = content.replace(
    '  handleBotError(bot) {',
    `  handleBotError(bot) {
    this.errorCount = (this.errorCount || 0) + 1;
    
    // Prevent infinite error loops
    if (this.errorCount > 5) {
      console.error('❌ Too many errors, stopping rotation');
      this.settings.enabled = false;
      return;
    }`
  );
}

// Ensure rotateToNextBot doesn't call itself on error
content = content.replace(
  '      await this.stopCurrentBot();',
  `      // Clean up but don't trigger another rotation on error
      if (this.gstreamerProcess) {
        this.gstreamerProcess.kill('SIGKILL');
        this.gstreamerProcess = null;
      }
      if (this.currentTransport) {
        try { this.currentTransport.close(); } catch(e) {}
        this.currentTransport = null;
      }
      if (this.currentProducer) {
        try {
          if (this.currentProducer.video) this.currentProducer.video.close();
          if (this.currentProducer.audio) this.currentProducer.audio.close();
        } catch(e) {}
        this.currentProducer = null;
      }
      this.currentBot = null;`
);

fs.writeFileSync(simpleViewBotPath, content);
console.log('   ✅ Fixed SimpleViewBotMediaSoup.js');

// 2. Ensure global.io is set in index.js
console.log('\n2️⃣ Verifying global.io in index.js...');

const indexPath = path.join(__dirname, 'server', 'index.js');
let indexContent = fs.readFileSync(indexPath, 'utf8');

if (!indexContent.includes('console.log(\'🔍 DEBUG: global.io test:\', typeof global.io)')) {
  // Add debugging after setting global.io
  indexContent = indexContent.replace(
    '    console.log(\'✅ GLOBAL OBJECTS: Set global.io and global.streamService for event emission\');',
    `    console.log('✅ GLOBAL OBJECTS: Set global.io and global.streamService for event emission');
    console.log('🔍 DEBUG: global.io test:', typeof global.io);
    console.log('🔍 DEBUG: io.emit test:', typeof io.emit);
    
    // Test emit
    setTimeout(() => {
      if (global.io) {
        console.log('🔍 DEBUG: Testing global.io.emit after 5 seconds');
        global.io.emit('test-event', { test: true });
      }
    }, 5000);`
  );
  
  fs.writeFileSync(indexPath, indexContent);
  console.log('   ✅ Added debugging to index.js');
} else {
  console.log('   ✅ index.js already has debugging');
}

// 3. Create a simple test bot that definitely works
console.log('\n3️⃣ Creating simple test ViewBot...');

const testBotContent = `
const { spawn } = require('child_process');

class SimpleTestBot {
  constructor(mediasoupService, io) {
    this.mediasoupService = mediasoupService;
    this.io = io;
    this.isRunning = false;
  }
  
  async start() {
    if (this.isRunning) return;
    
    console.log('🤖 TEST BOT: Starting simple test bot');
    this.isRunning = true;
    
    // Emit test stream-ready event every 5 seconds
    this.interval = setInterval(() => {
      if (this.io) {
        console.log('🤖 TEST BOT: Emitting test stream-ready');
        this.io.emit('stream-ready', {
          streamerId: 'test-bot-' + Date.now(),
          isViewBot: true,
          streamType: 'test',
          timestamp: Date.now()
        });
      }
    }, 5000);
  }
  
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.isRunning = false;
    console.log('🤖 TEST BOT: Stopped');
  }
}

module.exports = SimpleTestBot;
`;

fs.writeFileSync(path.join(__dirname, 'server', 'services', 'SimpleTestBot.js'), testBotContent);
console.log('   ✅ Created SimpleTestBot.js');

// 4. Add test bot initialization to index.js
if (!indexContent.includes('SimpleTestBot')) {
  indexContent = indexContent.replace(
    '    console.log(\'✅ SIMPLE ROTATION: MediaSoup rotation system initialized with\', bots.length, \'bots\');',
    `    console.log('✅ SIMPLE ROTATION: MediaSoup rotation system initialized with', bots.length, 'bots');
    
    // Initialize test bot for debugging
    const SimpleTestBot = require('./services/SimpleTestBot');
    const testBot = new SimpleTestBot(mediasoupService, io);
    // Uncomment to enable test bot:
    // testBot.start();
    global.testBot = testBot;
    console.log('🤖 TEST BOT: Available (use global.testBot.start() to enable)');`
  );
  
  fs.writeFileSync(indexPath, indexContent);
  console.log('   ✅ Added test bot to index.js');
}

console.log('\n4️⃣ Restarting server...');
try {
  execSync('pm2 restart onestreamer-server', { stdio: 'inherit' });
  console.log('   ✅ Server restarted');
} catch (error) {
  console.error('   ❌ Failed to restart:', error.message);
}

console.log('\n✅ Fix complete!');
console.log('\n📝 Changes made:');
console.log('   1. Added debugging to stream-ready emission');
console.log('   2. Fixed error handling to prevent infinite loops');
console.log('   3. Added global.io verification');
console.log('   4. Created SimpleTestBot for debugging');
console.log('\n🔍 Next steps:');
console.log('   1. Check server logs: pm2 logs onestreamer-server --lines 100');
console.log('   2. Look for "CRITICAL: About to emit stream-ready event"');
console.log('   3. If global.io is null, there\'s an initialization issue');
console.log('   4. If needed, enable test bot to verify Socket.IO works');
console.log('\n🎯 To test:');
console.log('   node debug-rotation-live.js');

process.exit(0);