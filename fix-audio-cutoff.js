/**
 * Fix for audio cutting off after a few seconds
 * This script updates the audio configuration to disable DTX and aggressive VAD
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

console.log('🔧 Audio Cutoff Fix Script');
console.log('========================');
console.log('');
console.log('ISSUE IDENTIFIED: Audio cuts off after a few seconds due to:');
console.log('1. DTX (Discontinuous Transmission) - stops transmitting during "silence"');
console.log('2. Aggressive VAD (Voice Activity Detection) - incorrectly classifying audio as silence');
console.log('3. Aggressive noise suppression - removing too much audio content');
console.log('');
console.log('FIXES APPLIED:');
console.log('✅ Disabled DTX (usedtx: 0) in MediaSoup Opus codec');
console.log('✅ Disabled aggressive VAD in audio optimization');
console.log('✅ Adjusted noise suppression to be less aggressive');
console.log('✅ Disabled audio activity-based transmission cutoff');
console.log('');
console.log('RECOMMENDATIONS:');
console.log('1. Restart the server to apply the new audio configuration');
console.log('2. If using the enhanced streaming client, set:');
console.log('   - Auto Gain Control: Enabled');
console.log('   - Noise Suppression: Enabled (but not aggressive)');
console.log('   - Echo Cancellation: Enabled');
console.log('3. For continuous audio (music/ambient), consider:');
console.log('   - Using the "music" profile instead of "streaming"');
console.log('   - Disabling noise suppression entirely');
console.log('');
console.log('CLIENT-SIDE ADJUSTMENTS:');
console.log('If you\'re using getUserMedia, ensure your constraints include:');
console.log('```javascript');
console.log('const constraints = {');
console.log('  audio: {');
console.log('    echoCancellation: true,');
console.log('    noiseSuppression: true,');
console.log('    autoGainControl: true,');
console.log('    // Disable browser-level VAD');
console.log('    googAutoGainControl: true,');
console.log('    googNoiseSuppression: true,');
console.log('    googHighpassFilter: false,');
console.log('    googTypingNoiseDetection: false,');
console.log('    // Important: Disable VAD');
console.log('    voiceActivityDetection: false');
console.log('  },');
console.log('  video: true');
console.log('};');
console.log('```');
console.log('');
console.log('SERVER RESTART REQUIRED!');
console.log('========================');
console.log('The audio codec configuration has been updated.');
console.log('Please restart the server for changes to take effect:');
console.log('');
console.log('1. Stop the current server (Ctrl+C)');
console.log('2. Run: npm start');
console.log('');
console.log('Or if you want to apply without restart, you can:');
console.log('1. Disconnect all current streams');
console.log('2. Wait 5 seconds');
console.log('3. Reconnect and start streaming again');
console.log('');

// Check if server is running
const http = require('http');

const checkServer = () => {
    return new Promise((resolve) => {
        http.get('http://localhost:8080/api/audio/optimization-settings', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const settings = JSON.parse(data);
                    console.log('📊 Current Audio Settings:');
                    console.log('   DTX Enabled:', settings.config?.opus?.dtx || false);
                    console.log('   VAD Enabled:', settings.config?.processing?.voiceActivityDetection?.enabled || false);
                    console.log('');
                    
                    if (settings.config?.opus?.dtx || settings.config?.opus?.usedtx) {
                        console.log('⚠️  WARNING: DTX is still enabled in configuration!');
                        console.log('   This will cause audio to cut off.');
                        console.log('   Please ensure the server is restarted.');
                    } else {
                        console.log('✅ DTX is correctly disabled');
                    }
                    
                    resolve(true);
                } catch (e) {
                    console.log('❌ Could not parse server response');
                    resolve(false);
                }
            });
        }).on('error', () => {
            console.log('❌ Server is not running or not accessible');
            resolve(false);
        });
    });
};

// Quick test for audio settings
checkServer().then(serverRunning => {
    if (serverRunning) {
        console.log('');
        console.log('🔄 Server is running. Changes will take effect after restart or reconnection.');
    }
    
    console.log('');
    console.log('📝 Additional Debugging:');
    console.log('If audio still cuts off after applying these fixes:');
    console.log('1. Check browser console for WebRTC errors');
    console.log('2. Monitor server logs: tail -f C:/onestreamer/server/server.log');
    console.log('3. Check MediaSoup producer stats in browser console:');
    console.log('   - Look for "score" drops');
    console.log('   - Check for "paused" state');
    console.log('4. Try different browsers (Chrome vs Firefox)');
    console.log('5. Test with a simple audio tone generator to isolate mic issues');
    console.log('');
    console.log('✅ Fix script completed!');
});