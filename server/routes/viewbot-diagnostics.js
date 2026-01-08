const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { authenticateToken, authenticateAdmin } = require('../middleware/auth');

// Middleware for all diagnostic routes
router.use(authenticateToken);
router.use(authenticateAdmin);

/**
 * Comprehensive ViewBot system diagnostics
 */
router.get('/viewbot/diagnostics', async (req, res) => {
  try {
    const diagnostics = {
      timestamp: new Date().toISOString(),
      system: {
        platform: process.platform,
        nodeVersion: process.version,
        arch: process.arch
      },
      ffmpeg: await checkFFmpegStatus(),
      ports: await checkPortAvailability(),
      mediasoup: checkMediasoupStatus(),
      filesystem: checkFilesystemAccess(),
      network: await checkNetworkConnectivity()
    };
    
    res.json(diagnostics);
  } catch (error) {
    console.error('Failed to run diagnostics:', error);
    res.status(500).json({ error: 'Failed to run diagnostics', details: error.message });
  }
});

/**
 * Test ViewBot creation with detailed logging
 */
router.post('/viewbot/test-creation', async (req, res) => {
  try {
    const testConfig = {
      contentType: 'testPattern',
      testPattern: 'color-bars',
      width: 1280,
      height: 720,
      frameRate: 30,
      videoBitrate: '1000k',
      audioBitrate: '128k',
      autoStart: false,
      streamDuration: 0
    };
    
    const steps = [];
    
    // Step 1: Check FFmpeg
    steps.push({ step: 'ffmpeg_check', status: 'running' });
    const ffmpegCheck = await checkFFmpegStatus();
    if (!ffmpegCheck.available) {
      steps[steps.length - 1].status = 'failed';
      steps[steps.length - 1].error = ffmpegCheck.error;
      return res.json({ success: false, steps, error: 'FFmpeg not available' });
    }
    steps[steps.length - 1].status = 'passed';
    
    // Step 2: Check ViewBotClientService
    steps.push({ step: 'service_check', status: 'running' });
    if (!global.viewBotClientService) {
      steps[steps.length - 1].status = 'failed';
      steps[steps.length - 1].error = 'ViewBotClientService not initialized';
      return res.json({ success: false, steps, error: 'Service not available' });
    }
    steps[steps.length - 1].status = 'passed';
    
    // Step 3: Test bot creation
    steps.push({ step: 'bot_creation', status: 'running' });
    try {
      const result = await global.viewBotClientService.createBot(testConfig);
      
      if (result.success) {
        steps[steps.length - 1].status = 'passed';
        steps[steps.length - 1].botId = result.botId;
        
        // Step 4: Test bot initialization
        steps.push({ step: 'bot_initialization', status: 'running' });
        const bot = global.viewBotClientService.activeBots.get(result.botId);
        
        if (bot && bot.isConnected) {
          steps[steps.length - 1].status = 'passed';
        } else {
          steps[steps.length - 1].status = 'failed';
          steps[steps.length - 1].error = bot ? bot.lastError : 'Bot not found';
        }
        
        // Cleanup test bot
        setTimeout(async () => {
          try {
            await global.viewBotClientService.destroyBot(result.botId);
            console.log(`🧹 Cleaned up test bot ${result.botId}`);
          } catch (error) {
            console.error('Failed to cleanup test bot:', error);
          }
        }, 5000);
        
      } else {
        steps[steps.length - 1].status = 'failed';
        steps[steps.length - 1].error = result.message;
      }
    } catch (error) {
      steps[steps.length - 1].status = 'failed';
      steps[steps.length - 1].error = error.message;
    }
    
    res.json({ success: true, steps });
  } catch (error) {
    console.error('Test creation failed:', error);
    res.status(500).json({ error: 'Test creation failed', details: error.message });
  }
});

/**
 * Check FFmpeg installation and availability
 */
async function checkFFmpegStatus() {
  const possiblePaths = [
    'ffmpeg',
    'C:\\ffmpeg\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files (x86)\\ffmpeg\\bin\\ffmpeg.exe'
  ];
  
  const results = {
    available: false,
    workingPath: null,
    version: null,
    testedPaths: []
  };
  
  for (const ffmpegPath of possiblePaths) {
    try {
      const result = await new Promise((resolve) => {
        const ffmpeg = spawn(ffmpegPath, ['-version'], { timeout: 5000 });
        let output = '';
        
        ffmpeg.stdout.on('data', (data) => {
          output += data.toString();
        });
        
        ffmpeg.on('error', (error) => {
          resolve({ available: false, error: error.message, path: ffmpegPath });
        });
        
        ffmpeg.on('close', (code) => {
          const version = output.match(/ffmpeg version ([\\w\\.-]+)/)?.[1];
          resolve({
            available: code === 0,
            version,
            error: code !== 0 ? `Exit code ${code}` : null,
            path: ffmpegPath
          });
        });
        
        setTimeout(() => {
          ffmpeg.kill();
          resolve({ available: false, error: 'Timeout', path: ffmpegPath });
        }, 5000);
      });
      
      results.testedPaths.push(result);
      
      if (result.available) {
        results.available = true;
        results.workingPath = ffmpegPath;
        results.version = result.version;
        break;
      }
    } catch (error) {
      results.testedPaths.push({ 
        available: false, 
        error: error.message, 
        path: ffmpegPath 
      });
    }
  }
  
  return results;
}

/**
 * Check port availability for RTP streaming
 */
async function checkPortAvailability() {
  const net = require('net');
  const testPorts = [40000, 40001, 40002, 40003, 40004, 40005];
  const results = {
    available: [],
    unavailable: []
  };
  
  for (const port of testPorts) {
    try {
      const available = await new Promise((resolve) => {
        const server = net.createServer();
        
        server.listen(port, () => {
          server.close(() => resolve(true));
        });
        
        server.on('error', () => resolve(false));
        
        setTimeout(() => {
          server.close();
          resolve(false);
        }, 1000);
      });
      
      if (available) {
        results.available.push(port);
      } else {
        results.unavailable.push(port);
      }
    } catch (error) {
      results.unavailable.push(port);
    }
  }
  
  return results;
}

/**
 * Check MediaSoup service status
 */
function checkMediasoupStatus() {
  const status = {
    initialized: !!global.mediasoupService,
    workers: 0,
    routers: 0,
    transports: 0
  };
  
  if (global.mediasoupService) {
    try {
      status.workers = global.mediasoupService.workers?.length || 0;
      status.routers = global.mediasoupService.routers?.size || 0;
      status.transports = global.mediasoupService.transports?.size || 0;
    } catch (error) {
      status.error = error.message;
    }
  }
  
  return status;
}

/**
 * Check filesystem access for video files
 */
function checkFilesystemAccess() {
  const status = {
    tempDir: null,
    videoTestFiles: []
  };
  
  try {
    const os = require('os');
    const tempDir = os.tmpdir();
    status.tempDir = {
      path: tempDir,
      accessible: fs.existsSync(tempDir),
      writable: false
    };
    
    // Test write access
    try {
      const testFile = path.join(tempDir, 'viewbot-test-' + Date.now());
      fs.writeFileSync(testFile, 'test');
      fs.unlinkSync(testFile);
      status.tempDir.writable = true;
    } catch (error) {
      status.tempDir.writeError = error.message;
    }
    
    // Check for common video file locations
    const testPaths = [
      'C:\\Windows\\System32\\drivers\\etc', // Just to test file system access
      'C:\\temp',
      'C:\\tmp'
    ];
    
    for (const testPath of testPaths) {
      try {
        if (fs.existsSync(testPath)) {
          status.videoTestFiles.push({
            path: testPath,
            accessible: true
          });
        }
      } catch (error) {
        status.videoTestFiles.push({
          path: testPath,
          accessible: false,
          error: error.message
        });
      }
    }
  } catch (error) {
    status.error = error.message;
  }
  
  return status;
}

/**
 * Check network connectivity
 */
async function checkNetworkConnectivity() {
  const status = {
    localhost: false,
    serverPort: false
  };
  
  try {
    // Test localhost connection
    const net = require('net');
    
    status.localhost = await new Promise((resolve) => {
      const socket = new net.Socket();
      
      socket.setTimeout(2000);
      
      socket.connect(80, '127.0.0.1', () => {
        socket.destroy();
        resolve(true);
      });
      
      socket.on('error', () => resolve(false));
      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });
    });
    
    // Test server port
    const serverPort = process.env.PORT || 8080;
    status.serverPort = await new Promise((resolve) => {
      const socket = new net.Socket();
      
      socket.setTimeout(2000);
      
      socket.connect(serverPort, '127.0.0.1', () => {
        socket.destroy();
        resolve(true);
      });
      
      socket.on('error', () => resolve(false));
      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });
    });
    
  } catch (error) {
    status.error = error.message;
  }
  
  return status;
}

module.exports = router;