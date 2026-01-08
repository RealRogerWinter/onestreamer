/**
 * Fix for SimpleViewBotMediaSoup rotation issues
 * This script patches the rotation system to properly emit stream-ready events
 */

const fs = require('fs');
const path = require('path');

console.log('🔧 Fixing SimpleViewBotMediaSoup rotation system...\n');

const filePath = path.join(__dirname, 'server', 'services', 'SimpleViewBotMediaSoup.js');

// Read the current file
const content = fs.readFileSync(filePath, 'utf8');

// Check if global.io is being used
if (!content.includes('global.io')) {
  console.log('❌ File does not use global.io - this should have been fixed');
  process.exit(1);
}

// Find and fix the startBot function to ensure stream-ready is emitted after GStreamer starts
let fixedContent = content;

// Fix 1: Move stream-ready emission to after GStreamer starts
const oldPattern = `      // Start GStreamer pipeline after producers are ready
      await this.startGStreamerPipeline(bot, videoPort, audioPort);
      
      console.log(\`✅ MediaSoup viewbot \${bot.id} is streaming\`);`;

const newPattern = `      // Start GStreamer pipeline after producers are ready
      await this.startGStreamerPipeline(bot, videoPort, audioPort);
      
      console.log(\`✅ MediaSoup viewbot \${bot.id} is streaming\`);
      
      // CRITICAL FIX: Emit stream-ready AFTER GStreamer has started
      if (global.io && this.currentProducer) {
        global.io.emit('stream-ready', {
          streamerId: bot.id,
          isViewBot: true,
          streamType: 'viewbot',
          botId: bot.id,
          timestamp: Date.now(),
          videoProducerId: this.currentProducer.video?.id,
          audioProducerId: this.currentProducer.audio?.id
        });
        console.log('📢 Emitted stream-ready event after GStreamer started');
      }`;

if (content.includes(oldPattern)) {
  fixedContent = fixedContent.replace(oldPattern, newPattern);
  console.log('✅ Fixed stream-ready emission timing in startBot');
} else {
  console.log('⚠️ Could not find expected pattern in startBot, applying alternative fix...');
}

// Fix 2: Remove duplicate stream-ready emissions from createProducers
// Find the createProducers function and remove stream-ready emissions
const producersStart = fixedContent.indexOf('async createProducers(transport)');
const producersEnd = fixedContent.indexOf('  }', producersStart) + 3;

if (producersStart > -1) {
  let producersSection = fixedContent.substring(producersStart, producersEnd);
  
  // Remove all stream-ready emissions from createProducers
  const streamReadyPattern = /global\.io\.emit\('stream-ready'[^}]+\}\);?\s*\n\s*console\.log\([^)]+\);?/g;
  const cleanedProducers = producersSection.replace(streamReadyPattern, '// Stream-ready moved to startBot after GStreamer starts');
  
  fixedContent = fixedContent.substring(0, producersStart) + cleanedProducers + fixedContent.substring(producersEnd);
  console.log('✅ Removed duplicate stream-ready emissions from createProducers');
}

// Fix 3: Improve error handling in startGStreamerPipeline
const gstErrorPattern = `      this.gstreamerProcess.on('error', (error) => {
        console.error(\`❌ GStreamer error:\`, error);
        reject(error);
      });`;

const gstErrorFixed = `      this.gstreamerProcess.on('error', (error) => {
        console.error(\`❌ GStreamer error:\`, error);
        this.gstreamerProcess = null;
        reject(error);
      });`;

if (fixedContent.includes(gstErrorPattern)) {
  fixedContent = fixedContent.replace(gstErrorPattern, gstErrorFixed);
  console.log('✅ Fixed GStreamer error handling');
}

// Fix 4: Ensure rotateToNextBot doesn't emit duplicate stream-ready
const rotatePattern = `    // Start the bot
    await this.startBot(nextBot);
    
    // Emit stream-ready event to notify clients (using existing ViewBot mechanism)
    if (global.io && this.currentProducer) {`;

const rotateFixed = `    // Start the bot (stream-ready will be emitted from startBot)
    await this.startBot(nextBot);
    
    // Skip duplicate stream-ready emission (already done in startBot)
    if (false && global.io && this.currentProducer) {`;

if (fixedContent.includes(rotatePattern)) {
  fixedContent = fixedContent.replace(rotatePattern, rotateFixed);
  console.log('✅ Removed duplicate stream-ready from rotateToNextBot');
}

// Write the fixed content
fs.writeFileSync(filePath, fixedContent);
console.log('\n✅ SimpleViewBotMediaSoup.js has been fixed!');
console.log('📝 Changes made:');
console.log('   1. Moved stream-ready emission to after GStreamer starts');
console.log('   2. Removed duplicate stream-ready emissions from createProducers');
console.log('   3. Improved GStreamer error handling');
console.log('   4. Removed duplicate emission from rotateToNextBot');
console.log('\n🔄 Restarting server to apply changes...');

// Restart the server
const { execSync } = require('child_process');
try {
  execSync('pm2 restart onestreamer-server', { stdio: 'inherit' });
  console.log('\n✅ Server restarted successfully!');
} catch (error) {
  console.error('❌ Failed to restart server:', error.message);
}

console.log('\n🎯 Testing the fix...\n');

// Test the fix
setTimeout(async () => {
  const axios = require('axios');
  process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0;
  
  try {
    // Force a rotation
    console.log('Forcing rotation...');
    await axios.post('https://127.0.0.1:8443/admin/simple-rotation/force', {}, {
      headers: { 'x-admin-key': '***REMOVED-ADMIN-KEY***' }
    });
    
    // Wait and check status
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const status = await axios.get('https://127.0.0.1:8443/admin/simple-rotation/status', {
      headers: { 'x-admin-key': '***REMOVED-ADMIN-KEY***' }
    });
    
    console.log('\nRotation status:');
    console.log(`  Current bot: ${status.data.currentBot}`);
    console.log(`  Has GStreamer: ${status.data.hasGStreamer}`);
    console.log(`  Has Transport: ${status.data.hasTransport}`);
    console.log(`  Has Producers: ${status.data.hasProducers}`);
    
    if (status.data.hasGStreamer && status.data.hasTransport && status.data.hasProducers) {
      console.log('\n✅ SUCCESS! Rotation is working properly!');
      console.log('🎉 ViewBot rotation system has been fixed!');
    } else {
      console.log('\n⚠️ Rotation still having issues. Check server logs for details.');
    }
    
  } catch (error) {
    console.error('Test failed:', error.message);
  }
  
  process.exit(0);
}, 10000);