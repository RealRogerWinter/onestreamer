/**
 * Fix GStreamer to be the actual default for ViewBots
 * The issue: The logic only sets useGStreamer if it's undefined, but we need to ensure it defaults to true
 */

const fs = require('fs');
const path = require('path');

async function fixGStreamerDefault() {
  console.log('🔧 Fixing GStreamer to be the default for ViewBots...');
  
  const filePath = path.join(__dirname, 'server', 'services', 'ViewBotClientService.js');
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Fix 1: Update the createBot logic to properly default to GStreamer
  const oldLogic = `    // Apply global streaming method setting (unless explicitly overridden)
    if (botConfig.contentType === 'videoFile' && botConfig.useGStreamer === undefined) {
      botConfig.useGStreamer = (this.globalStreamingMethod === 'gstreamer');
      console.log(\`🎬 VIEWBOT CLIENT: Using \${this.globalStreamingMethod.toUpperCase()} for video file streaming\`);
    }`;
  
  const newLogic = `    // Apply global streaming method setting
    // Default to GStreamer for video files unless explicitly set to false
    if (botConfig.contentType === 'videoFile') {
      // Only use FFmpeg if explicitly requested, otherwise use GStreamer
      if (botConfig.useGStreamer !== false) {
        botConfig.useGStreamer = true; // Default to GStreamer
        console.log(\`🎬 VIEWBOT CLIENT: Using GSTREAMER for video file streaming (default)\`);
      } else {
        console.log(\`🎬 VIEWBOT CLIENT: Using FFMPEG for video file streaming (explicitly requested)\`);
      }
    }`;
  
  if (content.includes(oldLogic)) {
    content = content.replace(oldLogic, newLogic);
    console.log('✅ Fixed createBot logic to default to GStreamer');
  } else {
    console.log('⚠️ Could not find exact createBot logic, trying alternative fix...');
    
    // Alternative: Find and replace the line more broadly
    const altOldPattern = /if \(botConfig\.contentType === 'videoFile' && botConfig\.useGStreamer === undefined\) \{[\s\S]*?\n\s*\}/;
    const altNewCode = `if (botConfig.contentType === 'videoFile') {
      // Default to GStreamer unless explicitly set to false
      if (botConfig.useGStreamer !== false) {
        botConfig.useGStreamer = true;
        console.log(\`🎬 VIEWBOT CLIENT: Using GSTREAMER for video file streaming (default)\`);
      } else {
        console.log(\`🎬 VIEWBOT CLIENT: Using FFMPEG for video file streaming (explicitly requested)\`);
      }
    }`;
    
    if (altOldPattern.test(content)) {
      content = content.replace(altOldPattern, altNewCode);
      console.log('✅ Fixed createBot logic using alternative pattern');
    } else {
      console.log('❌ Could not find createBot logic to fix');
    }
  }
  
  // Fix 2: Also update the check in startMediaGeneration to ensure GStreamer is preferred
  const oldCheck = `      const useGStreamer = this.config.useGStreamer === true && 
                          this.config.contentType === 'videoFile' && 
                          this.config.videoFile;`;
  
  const newCheck = `      // Use GStreamer by default for video files (unless explicitly set to false)
      const useGStreamer = this.config.useGStreamer !== false && 
                          this.config.contentType === 'videoFile' && 
                          this.config.videoFile;`;
  
  if (content.includes(oldCheck)) {
    content = content.replace(oldCheck, newCheck);
    console.log('✅ Fixed startMediaGeneration check to prefer GStreamer');
  } else {
    console.log('⚠️ Could not find exact startMediaGeneration check');
  }
  
  // Write the fixed content
  fs.writeFileSync(filePath, content, 'utf8');
  
  console.log('\n✅ GStreamer is now the proper default for ViewBots!');
  console.log('\n🔑 Key changes:');
  console.log('1. GStreamer will be used by default for all video file streaming');
  console.log('2. FFmpeg will only be used if explicitly requested (useGStreamer: false)');
  console.log('3. The check now uses !== false instead of === true');
  console.log('\n⚠️ Restart the server for changes to take effect');
}

fixGStreamerDefault().catch(console.error);