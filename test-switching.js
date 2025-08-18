const { io } = require('socket.io-client');

console.log('🧪 SWITCHING TEST: Starting multi-viewer switching simulation...');

class TestClient {
  constructor(name, isStreamer = false) {
    this.name = name;
    this.isStreamer = isStreamer;
    this.socket = null;
  }

  connect() {
    return new Promise((resolve) => {
      this.socket = io('http://localhost:8080');
      
      this.socket.on('connect', () => {
        console.log(`✅ ${this.name}: Connected (${this.socket.id})`);
        resolve();
      });

      // Listen for takeover events
      this.socket.on('takeover-started', (data) => {
        console.log(`📢 ${this.name}: Received takeover-started from ${data.newStreamerId}`);
      });

      this.socket.on('stream-ready', (data) => {
        console.log(`🎬 ${this.name}: Received stream-ready from ${data.streamerId}`);
        
        // Regular viewers should now try to consume
        if (!this.isStreamer) {
          this.attemptConsumption();
        }
      });

      this.socket.on('stream-takeover', (data) => {
        console.log(`🔄 ${this.name}: Got stream-takeover notification, new streamer: ${data.newStreamerId}`);
      });

      this.socket.on('streaming-approved', () => {
        console.log(`🎯 ${this.name}: Streaming approved!`);
      });

      this.socket.on('takeover-denied', (data) => {
        console.log(`❌ ${this.name}: Takeover denied - ${data.reason}, cooldown: ${data.cooldownRemaining}s`);
      });
    });
  }

  attemptConsumption() {
    console.log(`📺 ${this.name}: Attempting to consume video...`);
    
    this.socket.emit('mediasoup:consume', {
      rtpCapabilities: {
        codecs: [],
        headerExtensions: [],
        fecMechanisms: []
      },
      kind: 'video'
    }, (response) => {
      if (response.success) {
        console.log(`✅ ${this.name}: Successfully created video consumer: ${response.consumer.id}`);
      } else {
        console.log(`❌ ${this.name}: Failed to consume video: ${response.error}`);
      }
    });
  }

  requestToStream(streamType = 'webcam') {
    console.log(`🎬 ${this.name}: Requesting to stream (${streamType})...`);
    this.socket.emit('request-to-stream', { streamType });
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      console.log(`🔌 ${this.name}: Disconnected`);
    }
  }
}

async function runSwitchingTest() {
  const streamer1 = new TestClient('Streamer1', true);
  const streamer2 = new TestClient('Streamer2', true);
  const viewer1 = new TestClient('Viewer1', false);
  const viewer2 = new TestClient('Viewer2', false);
  const viewer3 = new TestClient('Viewer3', false);

  // Connect all clients
  console.log('\n🔗 Phase 1: Connecting all clients...');
  await streamer1.connect();
  await streamer2.connect();
  await viewer1.connect();
  await viewer2.connect();
  await viewer3.connect();

  // Wait for connections to settle
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Streamer1 starts streaming
  console.log('\n🎬 Phase 2: Streamer1 starts streaming...');
  streamer1.requestToStream('webcam');
  
  // Wait for stream to establish
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Viewers attempt to consume
  console.log('\n📺 Phase 3: Regular viewers attempt consumption from Streamer1...');
  viewer1.attemptConsumption();
  viewer2.attemptConsumption();
  viewer3.attemptConsumption();

  // Wait for consumption attempts
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Streamer2 takes over
  console.log('\n🔄 Phase 4: Streamer2 attempts takeover...');
  streamer2.requestToStream('screen');

  // Wait for takeover to process
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Check if regular viewers can consume from new streamer
  console.log('\n📺 Phase 5: Regular viewers attempt consumption from Streamer2...');
  viewer1.attemptConsumption();
  viewer2.attemptConsumption();
  viewer3.attemptConsumption();

  // Wait for final consumption attempts
  await new Promise(resolve => setTimeout(resolve, 3000));

  console.log('\n🧪 TEST COMPLETE: Check logs above for switching behavior');
  
  // Cleanup
  streamer1.disconnect();
  streamer2.disconnect();
  viewer1.disconnect();
  viewer2.disconnect();
  viewer3.disconnect();
}

runSwitchingTest().catch(console.error);