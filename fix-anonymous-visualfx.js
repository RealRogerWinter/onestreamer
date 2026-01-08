#!/usr/bin/env node

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// This script modifies the server to ensure anonymous streamers can use visual effects

console.log('🔧 Fixing anonymous streamer visual effects issue...\n');

const fixes = [
  {
    file: '/root/onestreamer/server/routes/items.js',
    description: 'Allow visual effects for anonymous streamers',
    changes: [
      {
        find: `            // Check if there's an active stream for interactive items
            if (!streamStatus.hasActiveStream) {
                console.log(\`❌ ITEMS: No active stream for interactive item \${item.display_name}\`);
                return res.status(400).json({ 
                    error: 'No active stream', 
                    message: 'Interactive items can only be used when someone is streaming. Please wait for a streamer to start.',
                    requiresStream: true 
                });
            }`,
        replace: `            // Check if there's an active stream for interactive items
            // Allow anonymous streamers too - check both hasActiveStream and MediaSoup
            const mediasoupService = req.app.get('mediasoupService');
            const hasMediaSoupStreamer = mediasoupService && mediasoupService.currentStreamer;
            
            if (!streamStatus.hasActiveStream && !hasMediaSoupStreamer) {
                console.log(\`❌ ITEMS: No active stream for interactive item \${item.display_name}\`);
                console.log(\`   StreamService hasActiveStream: \${streamStatus.hasActiveStream}\`);
                console.log(\`   MediasoupService currentStreamer: \${hasMediaSoupStreamer}\`);
                return res.status(400).json({ 
                    error: 'No active stream', 
                    message: 'Interactive items can only be used when someone is streaming. Please wait for a streamer to start.',
                    requiresStream: true 
                });
            } else if (!streamStatus.hasActiveStream && hasMediaSoupStreamer) {
                console.log(\`⚠️ ITEMS: StreamService says no stream but MediaSoup has streamer - allowing for anonymous\`);
            }`
      }
    ]
  },
  {
    file: '/root/onestreamer/server/services/StreamService.js',
    description: 'Add fallback check for MediaSoup service',
    changes: [
      {
        find: `  getStreamStatus() {
    return {
      hasActiveStream: !!this.currentStreamer,
      streamerId: this.currentStreamer,
      streamType: this.streamType,
      viewerCount: this.viewers.size,
      streamStartTime: this.streamStartTime,
      streamDuration: this.streamStartTime ? Date.now() - this.streamStartTime : 0
    };
  }`,
        replace: `  getStreamStatus() {
    // Check both local currentStreamer and MediaSoup service as fallback
    let hasActiveStream = !!this.currentStreamer;
    let streamerId = this.currentStreamer;
    
    // Fallback to MediaSoup service if we don't have a currentStreamer
    // This handles cases where anonymous streamers might not properly sync
    if (!hasActiveStream && global.mediasoupService) {
      const mediasoupStreamer = global.mediasoupService.currentStreamer;
      if (mediasoupStreamer) {
        console.log(\`⚠️ STREAM: Using MediaSoup fallback for stream status (found: \${mediasoupStreamer})\`);
        hasActiveStream = true;
        streamerId = mediasoupStreamer;
      }
    }
    
    return {
      hasActiveStream,
      streamerId,
      streamType: this.streamType,
      viewerCount: this.viewers.size,
      streamStartTime: this.streamStartTime,
      streamDuration: this.streamStartTime ? Date.now() - this.streamStartTime : 0
    };
  }`
      }
    ]
  }
];

// Apply fixes
const fs = require('fs');

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
        console.log('   ⚠️ Pattern not found (might already be fixed)');
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

console.log('🎉 Fix complete! Anonymous streamers should now be able to use visual effects.');
console.log('');
console.log('To apply the changes:');
console.log('1. Restart the server: pm2 restart server');
console.log('2. Test with an anonymous streamer');
console.log('');
console.log('The fix adds fallback checks to ensure anonymous streamers are properly detected');
console.log('even if there are synchronization issues between StreamService and MediasoupService.');