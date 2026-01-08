/**
 * Test script to simulate real user behavior and track socket connections
 */

const puppeteer = require('puppeteer');

async function testRealUserFlow() {
  console.log('🧪 Starting Real User Flow Test\n');
  console.log('=' .repeat(60));
  
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: false,
      devtools: true,
      args: ['--disable-web-security', '--no-sandbox', '--disable-dev-shm-usage']
    });
    
    const page = await browser.newPage();
    
    // Track all socket connections
    const socketConnections = new Map();
    const connectionLog = [];
    
    // Enable request interception
    await page.setRequestInterception(true);
    
    // Monitor network requests
    page.on('request', request => {
      const url = request.url();
      
      // Track Socket.IO connections
      if (url.includes('socket.io')) {
        const urlObj = new URL(url);
        const baseUrl = `${urlObj.protocol}//${urlObj.host}`;
        const sid = url.match(/sid=([^&]+)/)?.[1];
        
        if (!socketConnections.has(baseUrl)) {
          socketConnections.set(baseUrl, new Set());
        }
        
        if (sid) {
          socketConnections.get(baseUrl).add(sid);
        }
        
        connectionLog.push({
          time: new Date().toISOString(),
          url: baseUrl,
          type: url.includes('transport=websocket') ? 'websocket' : 'polling',
          sid: sid || 'initial'
        });
      }
      
      request.continue();
    });
    
    // Monitor console logs
    page.on('console', msg => {
      const text = msg.text();
      if (text.includes('Socket') || text.includes('socket') || text.includes('connected')) {
        console.log(`📝 [Console]: ${text}`);
      }
    });
    
    // Monitor WebSocket connections
    page.on('response', response => {
      if (response.status() === 101) { // WebSocket upgrade
        console.log(`🔌 WebSocket Upgrade: ${response.url()}`);
      }
    });
    
    console.log('\n📱 Step 1: Loading application...\n');
    await page.goto('http://localhost:3000', { 
      waitUntil: 'networkidle2',
      timeout: 30000 
    });
    
    console.log('⏳ Waiting for initial page load...\n');
    await page.waitForTimeout(3000);
    
    // Take snapshot of connections after initial load
    console.log('\n📊 Connections after initial load:');
    logConnections(socketConnections);
    
    // Check for React DevTools
    const hasReactDevTools = await page.evaluate(() => {
      return !!(window.__REACT_DEVTOOLS_GLOBAL_HOOK__);
    });
    console.log(`\n🔧 React DevTools: ${hasReactDevTools ? 'Present' : 'Not found'}`);
    
    // Check for multiple React roots
    const reactRoots = await page.evaluate(() => {
      const roots = document.querySelectorAll('[data-reactroot], #root');
      return roots.length;
    });
    console.log(`🌳 React root elements found: ${reactRoots}`);
    
    // Simulate user interactions
    console.log('\n👤 Step 2: Simulating user login...\n');
    
    // Click login button if present
    const loginButton = await page.$('button.login-button');
    if (loginButton) {
      await loginButton.click();
      await page.waitForTimeout(2000);
      
      // Fill in login form (adjust selectors as needed)
      const usernameInput = await page.$('input[type="text"], input[name="username"], input[placeholder*="username"]');
      const passwordInput = await page.$('input[type="password"]');
      
      if (usernameInput && passwordInput) {
        await usernameInput.type('onestreamer');
        await passwordInput.type('onestreamer');
        
        // Submit form
        const submitButton = await page.$('button[type="submit"], button:has-text("Login")');
        if (submitButton) {
          await submitButton.click();
          await page.waitForTimeout(3000);
        }
      }
    }
    
    console.log('\n📊 Connections after login:');
    logConnections(socketConnections);
    
    // Try to open inventory
    console.log('\n🎒 Step 3: Opening inventory (pressing B key)...\n');
    await page.keyboard.press('b');
    await page.waitForTimeout(2000);
    
    console.log('\n📊 Connections after opening inventory:');
    logConnections(socketConnections);
    
    // Check admin panel
    console.log('\n🔧 Step 4: Checking admin panel (Ctrl+Shift+A)...\n');
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.keyboard.press('A');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    await page.waitForTimeout(2000);
    
    console.log('\n📊 Connections after admin panel:');
    logConnections(socketConnections);
    
    // Analyze socket instances in the browser
    console.log('\n🔍 Step 5: Analyzing socket instances in browser...\n');
    
    const socketAnalysis = await page.evaluate(() => {
      const analysis = {
        globalSockets: [],
        reactContextSockets: [],
        windowSockets: [],
        ioManagers: []
      };
      
      // Check for global io manager
      if (window.io && window.io.managers) {
        for (const [url, manager] of Object.entries(window.io.managers)) {
          analysis.ioManagers.push({
            url,
            nsps: Object.keys(manager.nsps || {}),
            engine: manager.engine ? {
              id: manager.engine.id,
              readyState: manager.engine.readyState,
              transport: manager.engine.transport?.name
            } : null
          });
        }
      }
      
      // Check window object for socket references
      for (const key in window) {
        if (key.toLowerCase().includes('socket') && window[key]) {
          if (typeof window[key] === 'object' && window[key].id) {
            analysis.windowSockets.push({
              key,
              id: window[key].id,
              connected: window[key].connected
            });
          }
        }
      }
      
      // Try to find React context values
      const root = document.getElementById('root');
      if (root && root._reactRootContainer) {
        try {
          let fiber = root._reactRootContainer._internalRoot?.current;
          while (fiber) {
            if (fiber.memoizedProps?.value?.mainSocket || fiber.memoizedProps?.value?.chatSocket) {
              const ctx = fiber.memoizedProps.value;
              analysis.reactContextSockets.push({
                mainSocket: ctx.mainSocket ? { id: ctx.mainSocket.id, connected: ctx.mainSocket.connected } : null,
                chatSocket: ctx.chatSocket ? { id: ctx.chatSocket.id, connected: ctx.chatSocket.connected } : null
              });
              break;
            }
            fiber = fiber.child || fiber.sibling || fiber.return;
          }
        } catch (e) {
          console.error('Error inspecting React fiber:', e);
        }
      }
      
      return analysis;
    });
    
    console.log('Socket Analysis:');
    console.log(JSON.stringify(socketAnalysis, null, 2));
    
    // Final connection summary
    console.log('\n' + '=' .repeat(60));
    console.log('📈 FINAL SUMMARY:\n');
    
    let totalConnections = 0;
    for (const [url, sids] of socketConnections) {
      console.log(`📍 ${url}: ${sids.size} unique socket IDs`);
      sids.forEach(sid => {
        console.log(`   - ${sid.substring(0, 20)}...`);
      });
      totalConnections += sids.size;
    }
    
    console.log(`\n⚠️  Total unique connections: ${totalConnections}`);
    console.log(`Expected: 2 (1 main + 1 chat)`);
    
    if (totalConnections > 2) {
      console.log('\n❌ ISSUE: Too many connections detected!');
      console.log('\n📜 Connection Timeline:');
      connectionLog.slice(0, 20).forEach(log => {
        console.log(`  ${log.time}: ${log.type} to ${log.url} (${log.sid})`);
      });
    } else if (totalConnections === 2) {
      console.log('\n✅ SUCCESS: Correct number of connections!');
    }
    
    console.log('\n🔍 Keeping browser open for manual inspection...');
    console.log('Check the Network tab and Console for more details.');
    console.log('Press Ctrl+C to exit.');
    
    // Keep browser open
    await new Promise(() => {});
    
  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

function logConnections(socketConnections) {
  for (const [url, sids] of socketConnections) {
    console.log(`  ${url}: ${sids.size} connections`);
  }
}

// Run test
testRealUserFlow().catch(console.error);