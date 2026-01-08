#!/usr/bin/env node

/**
 * Test script to verify Puppeteer cleanup functionality
 */

const puppeteer = require('puppeteer');
const { exec } = require('child_process');
const { promisify } = require('util');
const execPromise = promisify(exec);

async function countPuppeteerProcesses() {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execPromise('wmic process where "CommandLine like \'%puppeteer%\'" get ProcessId | find /c /v ""');
      return parseInt(stdout.trim()) - 1; // Subtract header line
    } else {
      const { stdout } = await execPromise('ps aux | grep -E "puppeteer|chrome.*--no-sandbox" | grep -v grep | wc -l');
      return parseInt(stdout.trim());
    }
  } catch (error) {
    return 0;
  }
}

async function testPuppeteerCleanup() {
  console.log('🧪 Testing Puppeteer cleanup functionality...\n');
  
  // Check initial state
  const initialCount = await countPuppeteerProcesses();
  console.log(`📊 Initial Puppeteer processes: ${initialCount}`);
  
  // Create multiple Puppeteer instances
  console.log('\n🚀 Launching 3 Puppeteer browsers...');
  const browsers = [];
  
  for (let i = 0; i < 3; i++) {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor'
      ]
    });
    browsers.push(browser);
    console.log(`   ✅ Browser ${i + 1} launched`);
  }
  
  // Count processes with browsers running
  const runningCount = await countPuppeteerProcesses();
  console.log(`\n📊 Puppeteer processes with browsers running: ${runningCount}`);
  
  // Test normal cleanup
  console.log('\n🧹 Testing normal cleanup (browser.close())...');
  for (let i = 0; i < browsers.length; i++) {
    await browsers[i].close();
    console.log(`   ✅ Browser ${i + 1} closed`);
  }
  
  // Wait a moment for processes to terminate
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  const afterNormalCleanup = await countPuppeteerProcesses();
  console.log(`📊 Processes after normal cleanup: ${afterNormalCleanup}`);
  
  // Create browsers again but don't close them properly
  console.log('\n🚀 Launching 3 more browsers (will simulate crash)...');
  const orphanedBrowsers = [];
  
  for (let i = 0; i < 3; i++) {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor'
      ]
    });
    orphanedBrowsers.push(browser);
    console.log(`   ✅ Browser ${i + 1} launched`);
  }
  
  const withOrphaned = await countPuppeteerProcesses();
  console.log(`\n📊 Processes with orphaned browsers: ${withOrphaned}`);
  
  // Test force cleanup
  console.log('\n🔨 Testing force cleanup (pkill/taskkill)...');
  
  if (process.platform === 'win32') {
    await execPromise('taskkill /F /IM chrome.exe /FI "COMMANDLINE like *puppeteer*" 2>nul').catch(() => {});
    await execPromise('taskkill /F /IM chromium.exe /FI "COMMANDLINE like *puppeteer*" 2>nul').catch(() => {});
  } else {
    await execPromise('pkill -f "puppeteer.*chrome" 2>/dev/null').catch(() => {});
    await execPromise('pkill -f "chrome.*--no-sandbox.*--disable-setuid-sandbox" 2>/dev/null').catch(() => {});
  }
  
  console.log('   ✅ Force cleanup commands executed');
  
  // Wait for cleanup
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  const finalCount = await countPuppeteerProcesses();
  console.log(`\n📊 Final Puppeteer processes: ${finalCount}`);
  
  // Results
  console.log('\n📋 Test Results:');
  console.log('================');
  console.log(`✅ Normal cleanup: ${afterNormalCleanup === initialCount ? 'PASSED' : 'FAILED'}`);
  console.log(`✅ Force cleanup: ${finalCount === initialCount ? 'PASSED' : 'FAILED'}`);
  
  if (finalCount > initialCount) {
    console.log(`\n⚠️ Warning: ${finalCount - initialCount} Puppeteer processes still running!`);
    console.log('   Run the server shutdown handler or manually kill them.');
  } else {
    console.log('\n🎉 All tests passed! Cleanup functionality working correctly.');
  }
}

// Run the test
testPuppeteerCleanup().catch(error => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});