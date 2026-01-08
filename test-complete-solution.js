const { io } = require('socket.io-client');

console.log('🧪 COMPLETE SOLUTION TEST: Testing new App.tsx event handlers...');

class TestViewer {
  constructor(name) {
    this.name = name;
    this.socket = null;
    this.events = [];
  }

  async connect() {
    return new Promise((resolve) => {
      this.socket = io('http://localhost:8080');
      
      this.socket.on('connect', () => {
        console.log(`✅ ${this.name}: Connected (${this.socket.id})`);
        
        // Join as viewer to simulate real browser behavior
        this.socket.emit('join-as-viewer');
        resolve();
      });

      // Monitor all relevant events
      ['takeover-started', 'stream-ready', 'new-streamer', 'stream-takeover', 'global-cooldown'].forEach(event => {
        this.socket.on(event, (data) => {
          this.events.push({ event, data, timestamp: Date.now() });
          console.log(`📡 ${this.name}: Received ${event}:`, data);
        });
      });
    });
  }

  getEventSummary() {
    return this.events.map(e => `${e.event}@${new Date(e.timestamp).toISOString().slice(11,23)}`).join(' → ');
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      console.log(`🔌 ${this.name}: Disconnected`);
    }
  }
}

async function testCompleteSolution() {
  // Create test clients
  const streamer = new TestViewer('Streamer');  
  const viewer1 = new TestViewer('RegularViewer1');
  const viewer2 = new TestViewer('NoStreamViewer2'); 
  const viewer3 = new TestViewer('PassiveViewer3');

  // Connect all clients
  console.log('\n🔗 Phase 1: Connecting clients...');
  await streamer.connect();
  await viewer1.connect();
  await viewer2.connect(); 
  await viewer3.connect();
  
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Streamer starts streaming
  console.log('\n🎬 Phase 2: Streamer starts streaming (no MediaSoup producers)...');
  streamer.socket.emit('request-to-stream', { streamType: 'test-stream' });
  
  // Wait for complete event cycle
  console.log('\n⏳ Phase 3: Waiting for complete event cycle (8 seconds)...');
  await new Promise(resolve => setTimeout(resolve, 8000));

  // Analyze results
  console.log('\n📊 Phase 4: Event Analysis');
  console.log(`Streamer events:     ${streamer.getEventSummary()}`);
  console.log(`Viewer1 events:      ${viewer1.getEventSummary()}`);
  console.log(`Viewer2 events:      ${viewer2.getEventSummary()}`); 
  console.log(`Viewer3 events:      ${viewer3.getEventSummary()}`);
  
  // Check if all viewers received the key events
  const allViewers = [viewer1, viewer2, viewer3];
  const successfulViewers = allViewers.filter(viewer => {
    const hasStarted = viewer.events.some(e => e.event === 'takeover-started');
    const hasReady = viewer.events.some(e => e.event === 'stream-ready'); 
    return hasStarted && hasReady;
  });
  
  console.log(`\n${successfulViewers.length === 3 ? '✅' : '❌'} RESULT: ${successfulViewers.length}/3 viewers received complete event sequence`);
  
  if (successfulViewers.length === 3) {
    console.log('🎉 SUCCESS: All viewers should now transition from "No Active Stream" to viewing mode!');
  } else {
    console.log('❌ FAILURE: Some viewers missing events, will stay stuck');
  }

  // Cleanup
  streamer.disconnect();
  viewer1.disconnect();  
  viewer2.disconnect();
  viewer3.disconnect();
}

testCompleteSolution().catch(console.error);