const { io } = require('socket.io-client');

console.log('🧪 COMPLETE SWITCHING TEST: Testing full viewer switching flow...');

class ViewerTestClient {
  constructor(name) {
    this.name = name;
    this.socket = null;
    this.switchState = 'idle';
  }

  async connect() {
    return new Promise((resolve) => {
      this.socket = io('http://localhost:8080');
      
      this.socket.on('connect', () => {
        console.log(`✅ ${this.name}: Connected (${this.socket.id})`);
        resolve();
      });

      this.socket.on('takeover-started', (data) => {
        console.log(`📢 ${this.name}: Takeover started from ${data.newStreamerId}`);
        this.switchState = 'waiting-for-stream-ready';
        console.log(`🔄 ${this.name}: State = ${this.switchState}`);
      });

      this.socket.on('stream-ready', (data) => {
        console.log(`🎬 ${this.name}: Stream ready from ${data.streamerId} (fallback: ${data.fallback})`);
        this.switchState = 'attempting-connection';
        console.log(`🔄 ${this.name}: State = ${this.switchState}`);
        
        // Simulate attempting MediaSoup consumption
        this.attemptConsumption(data);
      });
    });
  }

  attemptConsumption(streamData) {
    console.log(`📺 ${this.name}: Attempting to consume from ${streamData.streamerId}...`);
    
    // Simulate the WebRTCViewer consumption attempt
    this.socket.emit('mediasoup:consume', {
      rtpCapabilities: { codecs: [], headerExtensions: [] },
      kind: 'video'
    }, (response) => {
      if (response.success) {
        console.log(`✅ ${this.name}: Consumer created successfully!`);
        this.switchState = 'connected';
      } else {
        console.log(`❌ ${this.name}: Consumer creation failed: ${response.error}`);
        if (streamData.fallback && !streamData.hasVideo && !streamData.hasAudio) {
          console.log(`⚠️ ${this.name}: Expected failure for fallback stream with no producers`);
          this.switchState = 'fallback-handled';
        } else {
          this.switchState = 'failed';
        }
      }
      console.log(`🔄 ${this.name}: Final state = ${this.switchState}`);
    });
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      console.log(`🔌 ${this.name}: Disconnected`);
    }
  }
}

async function testCompleteSwitching() {
  const streamer = io('http://localhost:8080');
  const viewer1 = new ViewerTestClient('Viewer1');
  const viewer2 = new ViewerTestClient('Viewer2');
  const viewer3 = new ViewerTestClient('Viewer3');
  
  // Connect all clients
  console.log('\n🔗 Phase 1: Connecting all clients...');
  
  await new Promise(resolve => {
    streamer.on('connect', () => {
      console.log(`✅ Streamer: Connected (${streamer.id})`);
      resolve();
    });
  });
  
  await viewer1.connect();
  await viewer2.connect();
  await viewer3.connect();

  // Wait for connections to settle
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Streamer starts streaming (but doesn't create MediaSoup producers)
  console.log('\n🎬 Phase 2: Streamer starts streaming without WebRTC...');
  streamer.emit('request-to-stream', { streamType: 'non-webrtc' });
  
  streamer.on('streaming-approved', () => {
    console.log('🎯 Streamer: Approved - simulating non-WebRTC stream (no MediaSoup producers)');
  });

  // Wait for full switching cycle (takeover-started → 6s delay → stream-ready → consumer attempts)
  console.log('\n⏳ Phase 3: Waiting for complete switching cycle (8 seconds)...');
  await new Promise(resolve => setTimeout(resolve, 8000));

  console.log('\n📊 Phase 4: Final Results:');
  console.log(`   Viewer1 state: ${viewer1.switchState}`);
  console.log(`   Viewer2 state: ${viewer2.switchState}`);
  console.log(`   Viewer3 state: ${viewer3.switchState}`);
  
  const success = [viewer1, viewer2, viewer3].every(v => 
    v.switchState === 'fallback-handled' || v.switchState === 'connected'
  );
  
  console.log(`\n${success ? '✅' : '❌'} SWITCHING TEST: ${success ? 'PASSED' : 'FAILED'}`);
  if (success) {
    console.log('🎉 All viewers handled the switching flow correctly!');
  } else {
    console.log('❌ Some viewers got stuck in switching process');
  }

  // Cleanup
  streamer.disconnect();
  viewer1.disconnect();
  viewer2.disconnect();
  viewer3.disconnect();
}

testCompleteSwitching().catch(console.error);