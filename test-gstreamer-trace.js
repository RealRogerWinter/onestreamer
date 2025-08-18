/**
 * Trace GStreamer usage in ViewBot
 * This script monitors if GStreamer is actually being invoked
 */

const { spawn } = require('child_process');
const fs = require('fs');

// Monitor for GStreamer processes
console.log('🔍 Monitoring for GStreamer processes...\n');

// Check current GStreamer processes
function checkGStreamerProcesses() {
  const checkProcess = spawn('powershell', ['-Command', 
    'Get-Process | Where-Object {$_.ProcessName -like "*gst*" -or $_.ProcessName -like "*gstreamer*"} | Select-Object Id, ProcessName, StartTime'
  ]);
  
  let output = '';
  checkProcess.stdout.on('data', (data) => {
    output += data.toString();
  });
  
  checkProcess.on('close', () => {
    if (output.trim()) {
      console.log('✅ GStreamer processes found:');
      console.log(output);
    } else {
      console.log('❌ No GStreamer processes running');
    }
  });
}

// Monitor server log for GStreamer mentions
function monitorServerLog() {
  const logPath = 'C:\\onestreamer\\server\\server.log';
  
  if (!fs.existsSync(logPath)) {
    console.log('❌ Server log not found');
    return;
  }
  
  console.log('📝 Monitoring server log for GStreamer activity...\n');
  
  // Get initial file size
  let lastSize = fs.statSync(logPath).size;
  
  // Watch for changes
  fs.watchFile(logPath, { interval: 1000 }, (curr, prev) => {
    if (curr.size > lastSize) {
      // Read new content
      const stream = fs.createReadStream(logPath, {
        start: lastSize,
        end: curr.size
      });
      
      stream.on('data', (chunk) => {
        const lines = chunk.toString().split('\n');
        lines.forEach(line => {
          if (line.toLowerCase().includes('gstreamer') || 
              line.includes('gst-launch') ||
              line.includes('useGStreamer') ||
              line.includes('GStreamer')) {
            console.log(`📍 GStreamer mention: ${line.substring(0, 200)}`);
          }
          if (line.includes('ViewBot') && line.includes('video') && line.includes('streaming')) {
            console.log(`🎬 ViewBot activity: ${line.substring(0, 200)}`);
          }
        });
      });
      
      lastSize = curr.size;
    }
  });
}

// Check ViewBotClientService configuration
async function checkServiceConfig() {
  console.log('🔧 Checking ViewBotClientService configuration...\n');
  
  try {
    const response = await fetch('http://localhost:8080/admin/viewbot-client/streaming-method', {
      headers: {
        'x-admin-key': 'your-secret-admin-key-123'
      }
    });
    
    if (response.ok) {
      const data = await response.json();
      console.log('Current streaming method:', data.method);
      console.log('Supported methods:', data.supported);
      
      if (data.method === 'gstreamer') {
        console.log('✅ GStreamer is configured as the streaming method');
      } else {
        console.log(`⚠️ Current method is ${data.method}, not GStreamer`);
      }
    } else {
      console.log('❌ Could not fetch streaming method configuration');
    }
  } catch (error) {
    console.log('❌ Error checking configuration:', error.message);
  }
}

// Start monitoring
console.log('Starting GStreamer trace...\n');
console.log('1. Check current GStreamer processes');
checkGStreamerProcesses();

console.log('\n2. Check service configuration');
checkServiceConfig();

console.log('\n3. Monitor server log (press Ctrl+C to stop)');
monitorServerLog();

// Check processes periodically
setInterval(() => {
  console.log('\n--- Process Check ---');
  checkGStreamerProcesses();
}, 10000);

// Handle exit
process.on('SIGINT', () => {
  console.log('\n\nStopping monitor...');
  process.exit(0);
});