const fs = require('fs');
const path = require('path');

// Fix for GStreamer cleanup issue - prevents orphaned processes
// The problem: Process references are cleared before SIGKILL fallback executes
// The solution: Keep process references until SIGKILL completes

const serviceFile = path.join(__dirname, 'server', 'services', 'ViewBotClientService.js');

console.log('🔧 Fixing GStreamer cleanup mechanism...');

// Read the file
const content = fs.readFileSync(serviceFile, 'utf8');

// Find and replace the cleanupGStreamerProcesses function
const fixedCleanup = `  cleanupGStreamerProcesses() {
    console.log(\`🧹 ViewBot \${this.botId}: Cleaning up GStreamer processes...\`);
    
    // Clear duration timer if set
    if (this.videoDurationTimer) {
      clearTimeout(this.videoDurationTimer);
      this.videoDurationTimer = null;
    }
    
    // Clear health check timer if set
    if (this.pipelineHealthCheckTimer) {
      clearInterval(this.pipelineHealthCheckTimer);
      this.pipelineHealthCheckTimer = null;
    }
    
    // Clear recovery timer if set
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    
    // Store references for delayed cleanup
    const processesToKill = [];
    
    // Enhanced cleanup with SIGKILL fallback
    const killProcess = (process, name) => {
      if (process && !process.killed) {
        const pid = process.pid;
        console.log(\`   Killing \${name} pipeline (PID: \${pid})\`);
        
        try {
          // First try SIGTERM
          process.kill('SIGTERM');
          
          // Store reference for delayed SIGKILL
          processesToKill.push({ process, name, pid });
          
          // Set a timeout to force kill if process doesn't die
          setTimeout(() => {
            try {
              // Check if process still exists and force kill
              process.kill(0); // Test if process exists
              console.log(\`   ⚠️ \${name} (PID: \${pid}) didn't die from SIGTERM, using SIGKILL\`);
              process.kill('SIGKILL');
              
              // Additional system-level kill as fallback
              if (process.platform !== 'win32') {
                const { exec } = require('child_process');
                exec(\`kill -9 \${pid} 2>/dev/null\`, (err) => {
                  if (!err) {
                    console.log(\`   🔨 Force killed \${name} at system level (PID: \${pid})\`);
                  }
                });
              }
            } catch (e) {
              // Process already dead, which is good
              console.log(\`   ✅ \${name} process terminated (PID: \${pid})\`);
            }
          }, 2000); // Give 2 seconds for graceful shutdown
        } catch (error) {
          console.log(\`   ⚠️ Error killing \${name}: \${error.message}\`);
        }
      }
    };
    
    // Kill all processes
    killProcess(this.gstreamerVideoProcess, 'video');
    killProcess(this.gstreamerAudioProcess, 'audio');
    killProcess(this.gstreamerProcess, 'gstreamer');
    
    // Clear references only after SIGKILL timeout completes
    setTimeout(() => {
      this.gstreamerVideoProcess = null;
      this.gstreamerAudioProcess = null;
      this.gstreamerProcess = null;
      console.log(\`   🧹 Process references cleared\`);
    }, 2500); // Clear references after SIGKILL timeout
    
    console.log(\`   ✅ Cleanup initiated\`);
  }`;

// Replace the old function
const startPattern = /cleanupGStreamerProcesses\(\) \{[\s\S]*?console\.log\(`   ✅ Cleanup complete`\);\s*\}/;
const newContent = content.replace(startPattern, fixedCleanup);

if (newContent === content) {
  console.error('❌ Failed to find and replace the cleanupGStreamerProcesses function');
  console.log('Searching for alternative pattern...');
  
  // Try a different approach - search for the function definition
  const altPattern = /cleanupGStreamerProcesses\s*\(\)\s*\{[\s\S]*?\n  \}/;
  const altContent = content.replace(altPattern, fixedCleanup);
  
  if (altContent !== content) {
    fs.writeFileSync(serviceFile, altContent);
    console.log('✅ Fixed GStreamer cleanup mechanism (alternative pattern)');
  } else {
    console.error('❌ Could not apply the fix automatically');
    console.log('Manual intervention may be required');
  }
} else {
  // Write the fixed content
  fs.writeFileSync(serviceFile, newContent);
  console.log('✅ Fixed GStreamer cleanup mechanism');
}

// Also add a global cleanup function for orphaned processes
const globalCleanup = `

// Global cleanup for orphaned GStreamer processes
async function cleanupOrphanedGStreamerProcesses() {
  const { exec } = require('child_process');
  
  console.log('🧹 Cleaning up orphaned GStreamer processes...');
  
  if (process.platform === 'win32') {
    // Windows cleanup
    exec('taskkill /F /IM gst-launch-1.0.exe 2>nul', (err, stdout) => {
      if (!err && stdout) console.log('   Killed orphaned GStreamer processes on Windows');
    });
  } else {
    // Linux/Mac cleanup - be more selective to only kill viewbot-related processes
    exec("ps aux | grep 'gst-launch-1.0.*filesrc.*onestreamer' | grep -v grep | awk '{print $2}'", (err, stdout) => {
      if (!err && stdout) {
        const pids = stdout.trim().split('\n').filter(pid => pid);
        if (pids.length > 0) {
          console.log(\`   Found \${pids.length} orphaned GStreamer processes: \${pids.join(', ')}\`);
          pids.forEach(pid => {
            exec(\`kill -9 \${pid} 2>/dev/null\`, (killErr) => {
              if (!killErr) {
                console.log(\`   ✅ Killed orphaned process PID: \${pid}\`);
              }
            });
          });
        }
      }
    });
  }
}

// Run cleanup periodically to catch orphans
setInterval(() => {
  cleanupOrphanedGStreamerProcesses();
}, 60000); // Every 60 seconds

// Run cleanup on startup
cleanupOrphanedGStreamerProcesses();
`;

console.log('📝 Adding global orphan cleanup function...');

// Check if the global cleanup already exists
if (!content.includes('cleanupOrphanedGStreamerProcesses')) {
  // Add the global cleanup at the end of the file
  const finalContent = newContent + globalCleanup + '\n';
  fs.writeFileSync(serviceFile, finalContent);
  console.log('✅ Added global orphan cleanup function');
}

console.log('🎉 GStreamer cleanup fix complete!');
console.log('');
console.log('The fix includes:');
console.log('1. Process references are kept until SIGKILL completes');
console.log('2. System-level kill command as additional fallback');
console.log('3. Global periodic cleanup for orphaned processes');
console.log('4. Startup cleanup to remove any existing orphans');
console.log('');
console.log('Please restart the server for changes to take effect.');