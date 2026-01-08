# Puppeteer Process Cleanup Implementation

## Problem
ViewBot service was creating Puppeteer browser instances for test pattern generation but not properly cleaning them up, leading to orphaned Chrome processes consuming significant CPU and memory resources.

## Solution Implemented

### 1. ViewBotClientService Cleanup Enhancements

#### Service-Level Cleanup (`cleanup()` method)
- Added `killOrphanedPuppeteerProcesses()` method to clean up any orphaned browser processes
- Kills Chrome/Chromium processes with Puppeteer-specific flags
- Works on both Windows and Unix-like systems

#### Bot-Level Cleanup (`ViewBotInstance.cleanupMediaGeneration()`)
- Enhanced to properly close Puppeteer pages and browsers
- Closes all pages before closing the browser
- Force kills browser process if normal close fails
- Handles errors gracefully with fallback to SIGKILL

### 2. Server Shutdown Handler Updates

Updated `/root/onestreamer/server/index.js` shutdown handler to:
- Kill Puppeteer Chrome processes during server shutdown
- Added platform-specific commands for Windows and Unix
- Integrated with existing media process cleanup

### 3. Key Changes Made

#### `/root/onestreamer/server/services/ViewBotClientService.js`
```javascript
// Added to cleanup() method
await this.killOrphanedPuppeteerProcesses();

// New method for killing orphaned processes
async killOrphanedPuppeteerProcesses() {
  // Platform-specific cleanup commands
  if (process.platform === 'win32') {
    // Windows: taskkill commands
  } else {
    // Unix: pkill commands
  }
}

// Enhanced ViewBotInstance.cleanupMediaGeneration()
// Now properly closes pages and browsers with error handling
```

#### `/root/onestreamer/server/index.js`
```javascript
// Added to SIGINT/SIGTERM handler
// Kill Puppeteer Chrome/Chromium processes
exec('pkill -f "puppeteer.*chrome"');
exec('pkill -f "chrome.*--no-sandbox.*--disable-setuid-sandbox"');
```

## Testing

Created `test-puppeteer-cleanup.js` to verify:
- Normal browser cleanup (browser.close())
- Force cleanup of orphaned processes
- Both test scenarios pass successfully

## Commands to Monitor/Clean Puppeteer Processes

### Check for Puppeteer processes:
```bash
ps aux | grep -E "puppeteer|chrome.*--no-sandbox" | grep -v grep
```

### Manual cleanup if needed:
```bash
# Unix/Linux
pkill -f "puppeteer.*chrome"
pkill -f "chrome.*--no-sandbox.*--disable-setuid-sandbox"

# Windows
taskkill /F /IM chrome.exe /FI "COMMANDLINE like *puppeteer*"
taskkill /F /IM chromium.exe /FI "COMMANDLINE like *puppeteer*"
```

## Impact
- Prevents CPU and memory leaks from orphaned Chrome processes
- Ensures clean server shutdown
- Improves system resource utilization
- Properly handles both graceful and forced cleanup scenarios

## Verification
After implementing these changes:
- All Puppeteer processes are properly terminated when ViewBots are stopped
- Server shutdown cleanly kills any remaining browser processes
- No orphaned Chrome processes remain after service cleanup