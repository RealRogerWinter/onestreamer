const { io } = require('socket.io-client');

console.log('🌟 GRACEFUL FALLBACK TEST: Testing improved fallback handling for streams with no media...');

class GracefulTestClient {
  constructor(name) {
    this.name = name;
    this.socket = null;
    this.state = { phase: 'disconnected', hasActiveStream: false };
  }

  async connect() {
    return new Promise((resolve) => {
      this.socket = io('http://localhost:8080');
      
      this.socket.on('connect', () => {
        console.log(`✅ ${this.name}: Connected (${this.socket.id})`);
        this.socket.emit('join-as-viewer');
        this.state.phase = 'viewer';
        resolve();
      });

      // Track state changes like the real App would
      this.socket.on('takeover-started', (data) => {
        this.state.phase = 'takeover-in-progress';
        console.log(`📢 ${this.name}: Takeover started - entering switching mode`);
      });

      this.socket.on('stream-ready', (data) => {
        console.log(`🎬 ${this.name}: Stream ready received:`, {
          fallback: data.fallback,
          hasVideo: data.hasVideo,
          hasAudio: data.hasAudio,
          producerVerified: data.producerVerified
        });

        if (data.streamerId !== this.socket.id) {
          this.state.hasActiveStream = true;
          this.state.phase = 'viewing';
          
          // Simulate WebRTCViewer logic for fallback streams
          if (data.fallback && !data.hasVideo && !data.hasAudio) {
            console.log(`📺 ${this.name}: Fallback stream with no media - showing placeholder (NOT attempting MediaSoup connection)`);
            this.state.phase = 'fallback-no-media';
          } else {
            console.log(`📺 ${this.name}: Normal stream - would attempt MediaSoup connection`);
          }
        }
      });
    });
  }

  getStateDescription() {
    return `${this.state.phase} (hasActiveStream: ${this.state.hasActiveStream})`;
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      console.log(`🔌 ${this.name}: Disconnected`);
    }
  }
}

async function testGracefulFallback() {
  const streamer = new GracefulTestClient('Streamer');
  const viewer1 = new GracefulTestClient('Viewer1');
  const viewer2 = new GracefulTestClient('Viewer2');
  
  const allClients = [streamer, viewer1, viewer2];
  const viewers = [viewer1, viewer2];

  console.log('\n🔗 Phase 1: Connecting clients...');
  for (const client of allClients) {
    await client.connect();
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  console.log('\n📊 Initial states:');
  allClients.forEach(client => {
    console.log(`   ${client.name}: ${client.getStateDescription()}`);
  });

  console.log('\n🎬 Phase 2: Streamer starts non-WebRTC stream (no MediaSoup producers)...');
  streamer.socket.emit('request-to-stream', { streamType: 'graceful-test' });

  // Wait for complete cycle
  await new Promise(resolve => setTimeout(resolve, 8000));

  console.log('\n📊 Final states:');
  allClients.forEach(client => {
    console.log(`   ${client.name}: ${client.getStateDescription()}`);
  });

  // Check results
  const successfulViewers = viewers.filter(viewer => 
    viewer.state.hasActiveStream && 
    viewer.state.phase === 'fallback-no-media'
  );

  console.log(`\n🎯 Results: ${successfulViewers.length}/${viewers.length} viewers handled fallback gracefully`);
  
  if (successfulViewers.length === viewers.length) {
    console.log('✅ SUCCESS: All viewers entered fallback-no-media state without attempting MediaSoup connection');
    console.log('   - No "Failed to consume video/audio" errors should occur');
    console.log('   - Viewers show placeholder message instead of connection attempts');
  } else {
    console.log('❌ FAILURE: Some viewers did not handle fallback correctly');
  }

  // Cleanup
  allClients.forEach(client => client.disconnect());
}

testGracefulFallback().catch(console.error);