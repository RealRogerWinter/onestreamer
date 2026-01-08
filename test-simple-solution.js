const { io } = require('socket.io-client');

console.log('🧪 SIMPLE SOLUTION TEST: Testing basic new-streamer events...');

async function testSimpleSolution() {
  const streamer = io('http://localhost:8080');
  const viewer1 = io('http://localhost:8080'); 
  const viewer2 = io('http://localhost:8080');
  const viewer3 = io('http://localhost:8080');

  const allClients = [streamer, viewer1, viewer2, viewer3];
  const viewers = [viewer1, viewer2, viewer3];

  // Connect all clients
  console.log('\n🔗 Connecting clients...');
  
  for (const client of allClients) {
    await new Promise(resolve => {
      client.on('connect', () => {
        console.log(`✅ Connected: ${client.id}`);
        client.emit('join-as-viewer'); // All join as viewers initially
        resolve();
      });
    });
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  // Set up event monitoring on viewers
  console.log('\n👂 Setting up event listeners on viewers...');
  viewers.forEach((viewer, i) => {
    viewer.on('new-streamer', (data) => {
      console.log(`📢 Viewer${i+1}: Received new-streamer:`, data);
    });
  });

  // Streamer starts streaming
  console.log('\n🎬 Streamer starts streaming...');
  streamer.emit('request-to-stream', { streamType: 'simple-test' });

  // Wait and see what happens
  await new Promise(resolve => setTimeout(resolve, 3000));

  console.log('\n✅ Simple test complete - check if viewers received new-streamer events');

  // Cleanup
  allClients.forEach(client => client.disconnect());
}

testSimpleSolution().catch(console.error);