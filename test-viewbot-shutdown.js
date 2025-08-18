/**
 * Test script to verify ViewBot cleanup on server shutdown
 * This script will:
 * 1. Start a ViewBot with GStreamer
 * 2. Verify it's running
 * 3. Simulate server shutdown
 * 4. Check that all processes are cleaned up
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

async function getGStreamerProcesses() {
  try {
    const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq gst-launch-1.0.exe" /FO CSV');
    const lines = stdout.split('\n').filter(line => line.includes('gst-launch-1.0.exe'));
    return lines.length;
  } catch (error) {
    return 0;
  }
}

async function runTest() {
  console.log('🧪 ViewBot Shutdown Test');
  console.log('========================\n');
  
  // Check initial GStreamer processes
  const initialCount = await getGStreamerProcesses();
  console.log(`📊 Initial GStreamer processes: ${initialCount}`);
  
  // Start the server
  console.log('\n📡 Starting server...');
  const serverProcess = require('child_process').spawn('node', ['server/index.js'], {
    stdio: 'pipe',
    detached: false
  });
  
  let serverReady = false;
  serverProcess.stdout.on('data', (data) => {
    const output = data.toString();
    if (output.includes('Server listening on port')) {
      serverReady = true;
    }
    if (output.includes('ViewBot') || output.includes('GStreamer')) {
      console.log(`   ${output.trim()}`);
    }
  });
  
  // Wait for server to start
  await new Promise(resolve => {
    const checkInterval = setInterval(() => {
      if (serverReady) {
        clearInterval(checkInterval);
        resolve();
      }
    }, 100);
  });
  
  console.log('✅ Server started\n');
  
  // Create a ViewBot
  console.log('🤖 Creating ViewBot...');
  try {
    const response = await fetch('http://localhost:3000/api/viewbot-client/bots/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer REDACTED-ADMIN-KEY'
      },
      body: JSON.stringify({
        name: 'Test Bot',
        contentType: 'video-file',
        videoFile: 'C:/onestreamer/uploads/test.mp4',
        useGStreamer: true
      })
    });
    
    const result = await response.json();
    if (result.success) {
      console.log(`✅ ViewBot created: ${result.botId}`);
      
      // Start streaming
      console.log('🎬 Starting ViewBot stream...');
      const startResponse = await fetch(`http://localhost:3000/api/viewbot-client/bots/${result.botId}/start`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer REDACTED-ADMIN-KEY'
        }
      });
      
      const startResult = await startResponse.json();
      if (startResult.success) {
        console.log('✅ ViewBot streaming started');
      }
    }
  } catch (error) {
    console.log('⚠️  Could not create ViewBot (may need admin auth)');
  }
  
  // Wait for processes to start
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  // Check GStreamer processes after ViewBot start
  const runningCount = await getGStreamerProcesses();
  console.log(`\n📊 GStreamer processes after ViewBot start: ${runningCount}`);
  
  // Send shutdown signal
  console.log('\n🛑 Sending shutdown signal to server...');
  serverProcess.kill('SIGINT');
  
  // Wait for shutdown
  await new Promise((resolve) => {
    serverProcess.on('exit', () => {
      console.log('✅ Server process exited');
      resolve();
    });
    
    // Timeout after 10 seconds
    setTimeout(() => {
      console.log('⚠️  Timeout waiting for server exit, forcing kill');
      serverProcess.kill('SIGKILL');
      resolve();
    }, 10000);
  });
  
  // Wait a bit more for processes to fully terminate
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Check final GStreamer processes
  const finalCount = await getGStreamerProcesses();
  console.log(`\n📊 Final GStreamer processes: ${finalCount}`);
  
  // Verify cleanup
  console.log('\n📋 Test Results:');
  console.log('================');
  if (finalCount === initialCount) {
    console.log('✅ PASS: All GStreamer processes cleaned up properly');
  } else {
    console.log(`❌ FAIL: ${finalCount - initialCount} GStreamer processes still running`);
    console.log('   This indicates the shutdown cleanup is not working correctly');
  }
  
  // Cleanup any remaining processes
  if (finalCount > initialCount) {
    console.log('\n🧹 Cleaning up remaining processes...');
    await execAsync('taskkill /F /IM gst-launch-1.0.exe 2>nul');
  }
}

// Run the test
runTest().catch(error => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});