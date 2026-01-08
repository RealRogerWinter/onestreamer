// Quick diagnostic to check if updated transcription code is active
const fs = require('fs');
const path = require('path');

console.log('🔍 DIAGNOSTIC: Checking transcription service files...');

// Check if RtpReceiver has the updated code
const rtpReceiverPath = path.join(__dirname, 'server', 'services', 'RtpReceiver.js');
const rtpReceiverCode = fs.readFileSync(rtpReceiverPath, 'utf8');

if (rtpReceiverCode.includes('RTP Receiver: Starting audio accumulator')) {
    console.log('✅ RtpReceiver.js has updated code');
} else {
    console.log('❌ RtpReceiver.js has old code');
}

// Check if TranscriptionService has the updated saveAsWav method
const transcriptionServicePath = path.join(__dirname, 'server', 'services', 'TranscriptionService.js');
const transcriptionServiceCode = fs.readFileSync(transcriptionServicePath, 'utf8');

if (transcriptionServiceCode.includes('convertOpusToWav')) {
    console.log('✅ TranscriptionService.js has updated code');
} else {
    console.log('❌ TranscriptionService.js has old code');
}

// Check if OpusDecoder has the updated code
const opusDecoderPath = path.join(__dirname, 'server', 'services', 'OpusDecoder.js');
const opusDecoderCode = fs.readFileSync(opusDecoderPath, 'utf8');

if (opusDecoderCode.includes('createOpusStreamFromRtp')) {
    console.log('✅ OpusDecoder.js has updated code');
} else {
    console.log('❌ OpusDecoder.js has old code');
}

console.log('\n🔍 DIAGNOSTIC: The server needs to be restarted to use the updated transcription code.');
console.log('The current running server (PID 28744) is likely using the old version.');