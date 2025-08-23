// Test if stream registration works
const streamService = { currentStreamer: null, streamType: null };
const mediasoupService = { currentStreamer: null, producers: new Map() };

// Simulate what SimpleViewBotMediaSoup does
const botId = 'test-bot-1';

// Set in streamService
streamService.currentStreamer = botId;
streamService.streamType = 'viewbot';

// Set in mediasoupService  
mediasoupService.currentStreamer = botId;
mediasoupService.producers.set(botId, new Map([
  ['video', { id: 'video-123' }],
  ['audio', { id: 'audio-456' }]
]));

// Check status
console.log('StreamService streamer:', streamService.currentStreamer);
console.log('MediasoupService streamer:', mediasoupService.currentStreamer);
console.log('Has producers:', mediasoupService.producers.has(botId));

// Simulate getStreamStatus
function getStreamStatus() {
  return {
    hasActiveStream: streamService.currentStreamer !== null,
    streamerId: streamService.currentStreamer,
    streamType: streamService.streamType
  };
}

console.log('Stream status:', getStreamStatus());
