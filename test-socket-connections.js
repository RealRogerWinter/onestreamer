const puppeteer = require('puppeteer');
const path = require('path');

async function testSocketConnections() {
  console.log('🔍 Testing socket connections...\n');
  
  const browser = await puppeteer.launch({
    headless: false,
    devtools: true,
    args: ['--disable-web-security']
  });
  
  const page = await browser.newPage();
  
  // Enable console logging
  page.on('console', msg => {
    if (msg.text().includes('socket') || msg.text().includes('Socket') || 
        msg.text().includes('connect') || msg.text().includes('CLIENT')) {
      console.log(`[Browser Console]: ${msg.text()}`);
    }
  });
  
  // Track WebSocket connections
  const wsConnections = new Set();
  const socketIOConnections = new Map();
  
  // Intercept network requests
  await page.setRequestInterception(true);
  
  page.on('request', request => {
    const url = request.url();
    
    // Track Socket.IO polling/websocket connections
    if (url.includes('socket.io')) {
      const urlObj = new URL(url);
      const baseUrl = `${urlObj.protocol}//${urlObj.host}`;
      
      if (!socketIOConnections.has(baseUrl)) {
        socketIOConnections.set(baseUrl, {
          count: 0,
          types: new Set(),
          firstSeen: new Date().toISOString()
        });
      }
      
      const connection = socketIOConnections.get(baseUrl);
      connection.count++;
      
      // Identify connection type
      if (url.includes('transport=websocket')) {
        connection.types.add('websocket');
      } else if (url.includes('transport=polling')) {
        connection.types.add('polling');
      }
      
      console.log(`📡 Socket.IO Request to ${baseUrl}: ${connection.types.has('websocket') ? 'WebSocket' : 'Polling'} (Total requests: ${connection.count})`);
    }
    
    request.continue();
  });
  
  // Track WebSocket connections
  page.on('response', response => {
    if (response.status() === 101) { // WebSocket upgrade
      const url = response.url();
      if (!wsConnections.has(url)) {
        wsConnections.add(url);
        console.log(`🔌 WebSocket Connection Established: ${url}`);
      }
    }
  });
  
  // Navigate to the application
  console.log('📱 Navigating to application...\n');
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle2' });
  
  // Wait for connections to establish
  await page.waitForTimeout(5000);
  
  // Analyze connections via browser console
  const socketInfo = await page.evaluate(() => {
    const connections = [];
    
    // Check for Socket.IO connections
    if (window.io && window.io.sockets) {
      for (const [id, socket] of window.io.sockets) {
        connections.push({
          id: socket.id,
          connected: socket.connected,
          url: socket.io.uri,
          transport: socket.io.engine?.transport?.name
        });
      }
    }
    
    // Check for any global socket references
    const checkObject = (obj, path = '') => {
      const sockets = [];
      try {
        for (const key in obj) {
          if (key.includes('socket') || key.includes('Socket')) {
            const value = obj[key];
            if (value && typeof value === 'object' && (value.connected !== undefined || value.id)) {
              sockets.push({
                path: `${path}.${key}`,
                id: value.id,
                connected: value.connected,
                url: value.io?.uri || value._url || 'unknown'
              });
            }
          }
        }
      } catch (e) {}
      return sockets;
    };
    
    // Check React components for sockets
    const reactRoot = document.getElementById('root');
    if (reactRoot && reactRoot._reactRootContainer) {
      const fiber = reactRoot._reactRootContainer._internalRoot?.current;
      if (fiber) {
        // Traverse React fiber tree to find socket references
        let node = fiber;
        while (node) {
          if (node.memoizedProps && node.memoizedProps.socket) {
            connections.push({
              component: node.type?.name || 'Unknown',
              socketId: node.memoizedProps.socket?.id,
              connected: node.memoizedProps.socket?.connected
            });
          }
          node = node.child || node.sibling || node.return;
        }
      }
    }
    
    return {
      connections,
      globalSockets: checkObject(window, 'window')
    };
  });
  
  // Print analysis
  console.log('\n📊 CONNECTION ANALYSIS:');
  console.log('=' .repeat(50));
  
  console.log('\n🌐 Socket.IO Endpoints Detected:');
  for (const [url, info] of socketIOConnections) {
    console.log(`  - ${url}`);
    console.log(`    Transport Types: ${Array.from(info.types).join(', ')}`);
    console.log(`    Total Requests: ${info.count}`);
    console.log(`    First Seen: ${info.firstSeen}`);
  }
  
  console.log('\n🔌 WebSocket Connections:');
  if (wsConnections.size > 0) {
    wsConnections.forEach(url => {
      console.log(`  - ${url}`);
    });
  } else {
    console.log('  No direct WebSocket connections detected');
  }
  
  console.log('\n🔍 Browser Socket Info:');
  console.log('Socket connections found:', socketInfo.connections.length);
  console.log('Global socket references:', socketInfo.globalSockets.length);
  
  if (socketInfo.connections.length > 0) {
    socketInfo.connections.forEach(conn => {
      console.log(`  - ${JSON.stringify(conn, null, 2)}`);
    });
  }
  
  // Summary
  console.log('\n📈 SUMMARY:');
  console.log(`Total Socket.IO endpoints: ${socketIOConnections.size}`);
  console.log(`Total WebSocket connections: ${wsConnections.size}`);
  
  const endpoints = Array.from(socketIOConnections.keys());
  if (endpoints.length > 2) {
    console.log('\n⚠️  WARNING: More than 2 socket endpoints detected!');
    console.log('Expected: 2 connections (1 for chat, 1 for other services)');
    console.log(`Actual: ${endpoints.length} connections`);
  }
  
  // Keep browser open for manual inspection
  console.log('\n✅ Test complete. Browser will remain open for inspection.');
  console.log('Press Ctrl+C to exit.');
}

testSocketConnections().catch(console.error);