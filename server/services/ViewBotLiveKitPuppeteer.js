/**
 * ViewBotLiveKitPuppeteer.js - ViewBot implementation using Puppeteer for LiveKit
 * 
 * Uses a headless browser to stream video files to LiveKit using the client SDK
 */

const puppeteer = require('puppeteer');
const { AccessToken } = require('livekit-server-sdk');
const path = require('path');
const fs = require('fs').promises;

class ViewBotLiveKitPuppeteer {
  constructor(livekitService) {
    this.livekitService = livekitService;
    this.bots = new Map();
    this.videoFolder = '/root/onestreamer/server/uploads';
    
    console.log('🤖 LIVEKIT PUPPETEER VIEWBOT: Service initialized');
  }
  
  /**
   * Create and start a ViewBot
   */
  async createAndStartViewBot(config) {
    const botId = config.botId || `viewbot-${Date.now()}`;
    
    if (this.bots.has(botId)) {
      return {
        success: false,
        message: 'ViewBot already exists'
      };
    }
    
    try {
      console.log(`🤖 LIVEKIT PUPPETEER VIEWBOT: Creating ViewBot: ${botId}`);
      
      // Create access token
      const apiKey = process.env.LIVEKIT_API_KEY;
      const apiSecret = process.env.LIVEKIT_API_SECRET;
      
      const token = new AccessToken(apiKey, apiSecret, {
        identity: botId,
        name: `ViewBot ${botId}`,
        ttl: '24h',
      });
      
      token.addGrant({
        roomJoin: true,
        room: config.roomName || 'main',
        canPublish: true,
        canSubscribe: false,
      });
      
      const jwt = await token.toJwt();
      
      // Launch browser
      console.log(`🚀 LIVEKIT PUPPETEER VIEWBOT ${botId}: Launching browser...`);
      
      const browser = await puppeteer.launch({
        headless: true,
        executablePath: '/usr/bin/google-chrome-stable',
        args: [
          '--headless',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-first-run',
          '--disable-blink-features=AutomationControlled',
          // WebRTC flags
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream',
          '--enable-usermedia-screen-capturing',
          '--auto-accept-camera-and-microphone-capture',
          '--allow-insecure-localhost',
          '--ignore-certificate-errors',
          // Performance flags
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
        ],
        ignoreHTTPSErrors: true
      });
      
      const page = await browser.newPage();
      
      // Enable console logging
      page.on('console', msg => {
        console.log(`📟 VIEWBOT ${botId} [Browser]:`, msg.text());
      });
      
      page.on('pageerror', error => {
        console.error(`❌ VIEWBOT ${botId} [Browser Error]:`, error.message);
      });
      
      // Grant permissions for media
      const context = browser.defaultBrowserContext();
      await context.overridePermissions('https://onestreamer.live', [
        'camera',
        'microphone'
      ]);
      
      // Build URL with parameters
      const videoFile = config.videoFile || '/root/onestreamer/server/uploads/test_10sec.mp4';
      const videoUrl = `/uploads/${path.basename(videoFile)}`;
      const serverUrl = process.env.LIVEKIT_URL || 'wss://onestreamer.live:7880';
      
      const pageUrl = `https://onestreamer.live/livekit-viewbot.html?` +
        `token=${encodeURIComponent(jwt)}&` +
        `video=${encodeURIComponent(videoUrl)}&` +
        `server=${encodeURIComponent(serverUrl)}`;
      
      console.log(`📺 LIVEKIT PUPPETEER VIEWBOT ${botId}: Navigating to streaming page...`);
      
      // Navigate to the page
      await page.goto(pageUrl, { 
        waitUntil: 'networkidle0',
        timeout: 30000 
      });
      
      // Wait for streaming to start
      console.log(`⏳ LIVEKIT PUPPETEER VIEWBOT ${botId}: Waiting for stream to start...`);
      
      const streamingStarted = await page.waitForFunction(
        () => window.viewbotStatus === 'streaming' || window.viewbotStatus === 'error',
        { timeout: 30000 }
      );
      
      // Check status
      const status = await page.evaluate(() => window.viewbotStatus);
      
      if (status === 'error') {
        const error = await page.evaluate(() => window.viewbotError);
        throw new Error(`Streaming failed: ${error}`);
      }
      
      // Store bot info
      const bot = {
        id: botId,
        browser: browser,
        page: page,
        videoFile: videoFile,
        isStreaming: true
      };
      
      this.bots.set(botId, bot);
      
      console.log(`✅ LIVEKIT PUPPETEER VIEWBOT ${botId}: Streaming started successfully!`);
      
      return {
        success: true,
        botId: botId,
        message: 'ViewBot streaming started'
      };
      
    } catch (error) {
      console.error(`❌ LIVEKIT PUPPETEER VIEWBOT: Failed to create ViewBot:`, error);
      return {
        success: false,
        message: error.message
      };
    }
  }
  
  /**
   * Stop a ViewBot
   */
  async stopViewBot(botId) {
    const bot = this.bots.get(botId);
    
    if (!bot) {
      return {
        success: false,
        message: 'ViewBot not found'
      };
    }
    
    try {
      console.log(`⏹️ LIVEKIT PUPPETEER VIEWBOT: Stopping ${botId}`);
      
      // Stop streaming via page function
      if (bot.page) {
        await bot.page.evaluate(() => {
          if (window.stopViewBotStream) {
            window.stopViewBotStream();
          }
        });
        
        // Wait a bit for cleanup
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      // Close browser
      if (bot.browser) {
        await bot.browser.close();
      }
      
      bot.isStreaming = false;
      this.bots.delete(botId);
      
      console.log(`✅ LIVEKIT PUPPETEER VIEWBOT ${botId}: Stopped`);
      
      return {
        success: true,
        message: 'ViewBot stopped'
      };
      
    } catch (error) {
      console.error(`❌ LIVEKIT PUPPETEER VIEWBOT: Failed to stop ViewBot:`, error);
      return {
        success: false,
        message: error.message
      };
    }
  }
  
  /**
   * Get ViewBot status
   */
  async getStatus(botId) {
    const bot = this.bots.get(botId);
    
    if (!bot) {
      return {
        exists: false
      };
    }
    
    try {
      const pageStatus = await bot.page.evaluate(() => ({
        status: window.viewbotStatus,
        error: window.viewbotError
      }));
      
      return {
        exists: true,
        id: bot.id,
        isStreaming: bot.isStreaming,
        videoFile: bot.videoFile,
        browserStatus: pageStatus
      };
    } catch (error) {
      return {
        exists: true,
        id: bot.id,
        isStreaming: bot.isStreaming,
        videoFile: bot.videoFile,
        error: error.message
      };
    }
  }
  
  /**
   * Clean up all ViewBots
   */
  async cleanup() {
    console.log('🧹 Cleaning up all LiveKit Puppeteer ViewBots');
    
    for (const botId of this.bots.keys()) {
      await this.stopViewBot(botId);
    }
    
    console.log('✅ All ViewBots cleaned up');
  }
}

module.exports = ViewBotLiveKitPuppeteer;