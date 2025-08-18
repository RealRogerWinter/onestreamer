const { io } = require('socket.io-client');

console.log('🏁 FINAL VALIDATION TEST: Complete end-to-end viewer switching validation');

class ComprehensiveTestClient {
  constructor(name, role = 'viewer') {
    this.name = name;
    this.role = role; // 'viewer' or 'streamer'
    this.socket = null;
    this.events = [];
    this.state = {
      hasActiveStream: false,
      streamerId: null,
      isConnected: false,
      phase: 'disconnected'
    };
  }

  async connect() {
    return new Promise((resolve) => {
      this.socket = io('http://localhost:8080');
      
      this.socket.on('connect', () => {
        this.state.isConnected = true;
        this.state.phase = 'connected';
        console.log(`✅ ${this.name}: Connected (${this.socket.id})`);
        
        if (this.role === 'viewer') {
          this.socket.emit('join-as-viewer');
          this.state.phase = 'viewer';
        }
        resolve();
      });

      // Simulate App.tsx event handling
      this.socket.on('takeover-started', (data) => {
        this.events.push({ event: 'takeover-started', data, timestamp: Date.now() });
        this.state.phase = 'takeover-in-progress';
        console.log(`📢 ${this.name} [APP]: Takeover started for ${data.newStreamerId}`);
      });

      this.socket.on('stream-ready', (data) => {
        this.events.push({ event: 'stream-ready', data, timestamp: Date.now() });
        
        // Simulate App.tsx logic
        if (data.streamerId !== this.socket.id) {
          this.state.hasActiveStream = true;
          this.state.streamerId = data.streamerId;
          this.state.phase = 'viewing';
          console.log(`🎬 ${this.name} [APP]: Stream activated - now viewing ${data.streamerId}`);
        }
      });

      this.socket.on('stream-ended', () => {
        this.events.push({ event: 'stream-ended', data: {}, timestamp: Date.now() });
        this.state.hasActiveStream = false;
        this.state.streamerId = null;  
        this.state.phase = 'no-stream';
        console.log(`🔚 ${this.name} [APP]: Stream ended - back to no active stream`);
      });

      this.socket.on('streaming-approved', () => {
        this.events.push({ event: 'streaming-approved', data: {}, timestamp: Date.now() });
        this.state.phase = 'streaming';
        console.log(`🎯 ${this.name} [APP]: Approved to stream`);
      });
    });
  }

  startStreaming(streamType = 'test') {
    if (this.role !== 'streamer') {
      console.log(`❌ ${this.name}: Cannot stream, not a streamer role`);
      return;
    }
    
    console.log(`🎬 ${this.name}: Requesting to stream (${streamType})`);
    this.socket.emit('request-to-stream', { streamType });
  }

  getStateDescription() {
    return `${this.state.phase} (hasActiveStream: ${this.state.hasActiveStream}, streamerId: ${this.state.streamerId})`;
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.state.isConnected = false;
      this.state.phase = 'disconnected';
      console.log(`🔌 ${this.name}: Disconnected`);
    }
  }
}

async function runFinalValidation() {
  console.log('\n🎪 Starting comprehensive end-to-end test...\n');

  // Create diverse test clients
  const streamer = new ComprehensiveTestClient('Streamer', 'streamer');
  const regularViewer = new ComprehensiveTestClient('RegularViewer');
  const noStreamViewer = new ComprehensiveTestClient('NoStreamViewer'); 
  const passiveViewer = new ComprehensiveTestClient('PassiveViewer');
  
  const allClients = [streamer, regularViewer, noStreamViewer, passiveViewer];
  const viewers = [regularViewer, noStreamViewer, passiveViewer];

  // Phase 1: Initial Connection
  console.log('📋 PHASE 1: Initial connection and setup');
  for (const client of allClients) {
    await client.connect();
    await new Promise(resolve => setTimeout(resolve, 200)); // Stagger connections
  }
  
  console.log('\n📊 Initial states:');
  allClients.forEach(client => {
    console.log(`   ${client.name}: ${client.getStateDescription()}`);
  });

  // Phase 2: Streamer goes live
  console.log('\n📋 PHASE 2: Streamer starts streaming');
  streamer.startStreaming('validation-test');
  
  // Wait for takeover-started events
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  console.log('\n📊 States after takeover-started:');
  allClients.forEach(client => {
    console.log(`   ${client.name}: ${client.getStateDescription()}`);
  });

  // Phase 3: Wait for stream-ready
  console.log('\n📋 PHASE 3: Waiting for stream-ready events (6s fallback)');
  await new Promise(resolve => setTimeout(resolve, 7000));
  
  console.log('\n📊 Final states after stream-ready:');
  allClients.forEach(client => {
    console.log(`   ${client.name}: ${client.getStateDescription()}`);
  });

  // Phase 4: Analysis
  console.log('\n📋 PHASE 4: Results analysis');
  
  // Check if all viewers transitioned correctly
  const successfulViewers = viewers.filter(viewer => {
    const hasCorrectState = viewer.state.hasActiveStream === true && 
                           viewer.state.streamerId === streamer.socket.id &&
                           viewer.state.phase === 'viewing';
    
    const hasCorrectEvents = viewer.events.some(e => e.event === 'takeover-started') &&
                            viewer.events.some(e => e.event === 'stream-ready');
    
    return hasCorrectState && hasCorrectEvents;
  });

  console.log(`\n🏆 RESULTS:`);
  console.log(`   Successful viewer transitions: ${successfulViewers.length}/${viewers.length}`);
  console.log(`   Streamer state: ${streamer.getStateDescription()}`);
  
  viewers.forEach(viewer => {
    const success = successfulViewers.includes(viewer);
    console.log(`   ${viewer.name}: ${success ? '✅' : '❌'} ${viewer.getStateDescription()}`);
  });

  const overallSuccess = successfulViewers.length === viewers.length;
  console.log(`\n${overallSuccess ? '🎉 SUCCESS' : '❌ FAILURE'}: ${overallSuccess ? 'All viewers successfully transitioned from "No Active Stream" to viewing mode!' : 'Some viewers failed to transition properly'}`);

  if (overallSuccess) {
    console.log('\n💯 VALIDATION PASSED: The critical switching functionality is now working correctly!');
    console.log('   ✅ Regular viewers automatically connect to new streams');
    console.log('   ✅ "No Active Stream" viewers transition to viewing mode');  
    console.log('   ✅ Takeover events properly trigger state changes');
    console.log('   ✅ Fallback mechanism ensures reliability');
  } else {
    console.log('\n❌ VALIDATION FAILED: Issues remain in the switching system');
  }

  // Cleanup
  console.log('\n🧹 Cleaning up test clients...');
  allClients.forEach(client => client.disconnect());
}

runFinalValidation().catch(console.error);