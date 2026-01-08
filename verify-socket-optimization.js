/**
 * Verification script for socket connection optimization
 * This script verifies that the application is using exactly 2 socket connections:
 * 1. Main socket for all app services
 * 2. Chat socket for chat service
 */

const puppeteer = require('puppeteer');

async function verifySocketOptimization() {
  console.log('🔍 Socket Connection Optimization Verification\n');
  console.log('=' .repeat(50));
  
  const browser = await puppeteer.launch({
    headless: false,
    devtools: true,
    args: ['--disable-web-security', '--no-sandbox']
  });
  
  const page = await browser.newPage();
  
  // Track socket connections
  const socketConnections = new Map();
  const connectionEvents = [];
  
  // Enable console logging
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('SocketContext') || text.includes('socket') || text.includes('Socket')) {
      console.log(`[Browser]: ${text}`);
      
      // Track connection events
      if (text.includes('connected with ID:')) {
        const match = text.match(/ID: ([\w-]+)/);
        if (match) {
          connectionEvents.push({
            time: new Date().toISOString(),
            event: 'connect',
            id: match[1],
            message: text
          });
        }
      }
    }
  });
  
  // Intercept network requests to track Socket.IO connections
  await page.setRequestInterception(true);
  
  page.on('request', request => {
    const url = request.url();
    
    if (url.includes('socket.io')) {
      const urlObj = new URL(url);
      const baseUrl = `${urlObj.protocol}//${urlObj.host}`;
      const port = urlObj.port || (urlObj.protocol === 'https:' ? '443' : '80');
      
      if (!socketConnections.has(baseUrl)) {
        socketConnections.set(baseUrl, {
          url: baseUrl,
          port: port,
          requestCount: 0,
          transportTypes: new Set(),
          firstSeen: new Date().toISOString(),
          purpose: identifySocketPurpose(port, baseUrl)
        });
      }
      
      const connection = socketConnections.get(baseUrl);
      connection.requestCount++;
      
      if (url.includes('transport=websocket')) {
        connection.transportTypes.add('websocket');
      } else if (url.includes('transport=polling')) {
        connection.transportTypes.add('polling');
      }
    }
    
    request.continue();
  });
  
  // Navigate to the application
  console.log('\n📱 Loading application...\n');
  await page.goto('http://localhost:3000', { 
    waitUntil: 'networkidle2',
    timeout: 30000 
  });
  
  // Wait for connections to establish
  console.log('⏳ Waiting for socket connections to establish...\n');
  await page.waitForTimeout(5000);
  
  // Execute browser-side verification
  const browserSocketInfo = await page.evaluate(() => {
    const sockets = [];
    
    // Check window for any socket references
    const checkForSockets = (obj, path = '') => {
      const found = [];
      try {
        for (const key in obj) {
          if (key.toLowerCase().includes('socket') && obj[key]) {
            const value = obj[key];
            if (value && typeof value === 'object') {
              if (value.id || value.connected !== undefined) {
                found.push({
                  path: `${path}.${key}`,
                  id: value.id,
                  connected: value.connected,
                  url: value.io?.uri || 'unknown'
                });
              }
            }
          }
        }
      } catch (e) {}
      return found;
    };
    
    // Check React DevTools if available
    const reactRoot = document.getElementById('root');
    let contextSockets = null;
    
    if (reactRoot && reactRoot._reactRootContainer) {
      // Try to find SocketContext values
      try {
        const fiber = reactRoot._reactRootContainer._internalRoot?.current;
        let node = fiber;
        while (node) {
          if (node.memoizedProps) {
            // Look for SocketContext provider
            if (node.memoizedProps.value && 
                (node.memoizedProps.value.mainSocket || node.memoizedProps.value.chatSocket)) {
              contextSockets = {
                mainSocket: node.memoizedProps.value.mainSocket ? {
                  id: node.memoizedProps.value.mainSocket.id,
                  connected: node.memoizedProps.value.mainSocket.connected
                } : null,
                chatSocket: node.memoizedProps.value.chatSocket ? {
                  id: node.memoizedProps.value.chatSocket.id,
                  connected: node.memoizedProps.value.chatSocket.connected
                } : null
              };
              break;
            }
          }
          node = node.child || node.sibling;
        }
      } catch (e) {}
    }
    
    return {
      windowSockets: checkForSockets(window, 'window'),
      contextSockets: contextSockets
    };
  });
  
  // Analyze results
  console.log('\n📊 ANALYSIS RESULTS:');
  console.log('=' .repeat(50));
  
  console.log('\n🌐 Socket.IO Endpoints Detected:');
  const endpoints = Array.from(socketConnections.values());
  endpoints.forEach(conn => {
    console.log(`\n  📍 ${conn.url}`);
    console.log(`     Purpose: ${conn.purpose}`);
    console.log(`     Port: ${conn.port}`);
    console.log(`     Transports: ${Array.from(conn.transportTypes).join(', ')}`);
    console.log(`     Requests: ${conn.requestCount}`);
  });
  
  console.log('\n🔌 SocketContext Status:');
  if (browserSocketInfo.contextSockets) {
    console.log('  ✅ SocketContext is active');
    if (browserSocketInfo.contextSockets.mainSocket) {
      console.log(`  📡 Main Socket: ${browserSocketInfo.contextSockets.mainSocket.connected ? 'Connected' : 'Disconnected'} (ID: ${browserSocketInfo.contextSockets.mainSocket.id || 'N/A'})`);
    }
    if (browserSocketInfo.contextSockets.chatSocket) {
      console.log(`  💬 Chat Socket: ${browserSocketInfo.contextSockets.chatSocket.connected ? 'Connected' : 'Disconnected'} (ID: ${browserSocketInfo.contextSockets.chatSocket.id || 'N/A'})`);
    }
  } else {
    console.log('  ⚠️  SocketContext not found or not accessible');
  }
  
  // Verification summary
  console.log('\n✅ VERIFICATION SUMMARY:');
  console.log('=' .repeat(50));
  
  const uniqueEndpoints = socketConnections.size;
  const expectedEndpoints = 2; // Main server + Chat server
  
  if (uniqueEndpoints === expectedEndpoints) {
    console.log(`✅ SUCCESS: Exactly ${expectedEndpoints} socket endpoints detected (as expected)`);
    console.log('   - Main server socket (port 8080): All app services');
    console.log('   - Chat server socket (port 8081): Chat service only');
  } else if (uniqueEndpoints < expectedEndpoints) {
    console.log(`⚠️  WARNING: Only ${uniqueEndpoints} socket endpoint(s) detected (expected ${expectedEndpoints})`);
    console.log('   Some services may not be connected');
  } else {
    console.log(`❌ ISSUE: ${uniqueEndpoints} socket endpoints detected (expected ${expectedEndpoints})`);
    console.log('   There may be duplicate connections that need to be consolidated');
  }
  
  // Check for duplicate connections
  const ports = endpoints.map(e => e.port);
  const uniquePorts = new Set(ports);
  if (ports.length !== uniquePorts.size) {
    console.log('\n⚠️  WARNING: Multiple connections to the same port detected');
  }
  
  console.log('\n📝 Connection Events Log:');
  connectionEvents.slice(0, 10).forEach(event => {
    console.log(`  ${event.time}: ${event.event} - ${event.id}`);
  });
  
  console.log('\n✅ Verification complete. Browser will remain open for inspection.');
  console.log('Press Ctrl+C to exit.');
}

function identifySocketPurpose(port, url) {
  if (port === '8081' || url.includes(':8081')) {
    return 'Chat Service';
  } else if (port === '8080' || url.includes(':8080')) {
    return 'Main Server (Streaming, Inventory, etc.)';
  } else if (port === '3000') {
    return 'Development Server (should not have direct socket)';
  } else {
    return 'Unknown';
  }
}

// Run verification
verifySocketOptimization().catch(console.error);