const { io } = require('socket.io-client');

async function debugStateCheck() {
  const fetch = (await import('node-fetch')).default;
  
  console.log('🔍 Starting state debugging...');
  
  const client = io('http://localhost:8080');
  
  await new Promise(resolve => {
    client.on('connect', resolve);
  });
  
  console.log(`✅ Connected: ${client.id}`);
  
  // Check initial state
  console.log('\n📊 Initial server state:');
  let response = await fetch('http://localhost:8080/debug/server-state');
  let state = await response.json();
  console.log(JSON.stringify(state, null, 2));
  
  // Request to stream
  console.log('\n🎬 Requesting to stream...');
  client.emit('request-to-stream', { streamType: 'test' });
  
  await new Promise(resolve => {
    client.on('streaming-approved', resolve);
  });
  
  // Check state after streaming approved
  console.log('\n📊 Server state after streaming approved:');
  response = await fetch('http://localhost:8080/debug/server-state');
  state = await response.json();
  console.log(JSON.stringify(state, null, 2));
  
  // Wait 7 seconds and check state again
  console.log('\n⏳ Waiting 7 seconds for fallback...');
  await new Promise(resolve => setTimeout(resolve, 7000));
  
  console.log('\n📊 Server state after 7 seconds (should show fallback trigger):');
  response = await fetch('http://localhost:8080/debug/server-state');
  state = await response.json();
  console.log(JSON.stringify(state, null, 2));
  
  client.disconnect();
  console.log('\n🔍 Debug complete');
}

debugStateCheck().catch(console.error);