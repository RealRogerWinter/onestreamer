const io = require('socket.io-client');

const socket = io('https://onestreamer.live:8443', {
  transports: ['websocket'],
  secure: true,
  rejectUnauthorized: false
});

socket.on('connect', () => {
  console.log('✅ Connected to server');
});

socket.on('stream-ending', (data) => {
  console.log('📢 STREAM-ENDING EVENT:', data);
});

socket.on('stream-ended', (data) => {
  console.log('📢 STREAM-ENDED EVENT:', data);
});

socket.on('stream-ready', (data) => {
  console.log('🔄 STREAM-READY EVENT (triggers client switch):', data);
  console.log('  - Streamer ID:', data.streamerId);
  console.log('  - Bot ID:', data.botId);
  console.log('  - Video producer:', data.videoProducerId);
  console.log('  - Audio producer:', data.audioProducerId);
  console.log('  - Is ViewBot:', data.isViewBot);
});

socket.on('stream-started', (data) => {
  console.log('🎬 STREAM-STARTED EVENT:', data);
});

socket.on('disconnect', () => {
  console.log('❌ Disconnected from server');
});

console.log('🔊 Listening for rotation events...');