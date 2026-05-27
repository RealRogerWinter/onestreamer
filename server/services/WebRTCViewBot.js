/**
 * WebRTCViewBot.js - WebRTC-capable viewbot using headless Chrome
 * 
 * This viewbot uses Puppeteer to control a headless Chrome browser that:
 * 1. Loads video files in a video element
 * 2. Captures the stream using captureStream() API
 * 3. Connects to MediaSoup as a WebRTC producer (just like a real user)
 * 
 * This enables full mobile compatibility since it uses standard WebRTC
 */

const puppeteer = require('puppeteer');
const path = require('path');
const { spawn } = require('child_process');

const logger = require('../bootstrap/logger').child({ svc: 'WebRTCViewBot' });
class WebRTCViewBot {
  constructor(botId, videoFile, serverUrl = 'https://onestreamer.live') {
    this.botId = botId;
    this.videoFile = videoFile;
    this.serverUrl = serverUrl;
    this.browser = null;
    this.page = null;
    this.isStreaming = false;
    this.socket = null;
    this.xvfbProcess = null;
    
    logger.debug(`🌐 WebRTCViewBot ${botId}: Initialized with video ${videoFile}`);
  }

  /**
   * Launch headless browser and setup page
   */
  async initialize() {
    try {
      logger.debug(`🚀 WebRTCViewBot ${this.botId}: Launching headless browser...`);
      
      // Try to find chromium executable
      const possiblePaths = [
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable'
      ];
      
      let executablePath = null;
      const fs = require('fs');
      for (const path of possiblePaths) {
        if (fs.existsSync(path)) {
          executablePath = path;
          logger.debug(`📌 Found Chrome/Chromium at: ${path}`);
          break;
        }
      }
      
      if (!executablePath) {
        throw new Error('Chrome/Chromium not found. Please install chromium-browser');
      }
      
      // Ensure DISPLAY is set for Xvfb
      if (!process.env.DISPLAY) {
        // Check if Xvfb is running
        const checkXvfb = spawn('pgrep', ['-x', 'Xvfb']);
        const xvfbRunning = await new Promise(resolve => {
          checkXvfb.on('close', code => resolve(code === 0));
        });
        
        if (xvfbRunning) {
          process.env.DISPLAY = ':99';
          logger.debug(`✅ Using existing Xvfb on display :99`);
        }
      }
      
      this.browser = await puppeteer.launch({
        headless: 'new', // Use new headless mode that supports WebRTC better
        executablePath: executablePath, // Use system Chrome
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-first-run',
          '--disable-blink-features=AutomationControlled',
          // WebRTC flags - critical for making it work
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream',
          '--enable-usermedia-screen-capturing',
          '--auto-accept-camera-and-microphone-capture',
          // Allow insecure localhost for development
          '--allow-insecure-localhost',
          '--ignore-certificate-errors',
          // Additional flags for stability
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          // Memory optimization
          '--max_old_space_size=512',
          '--memory-pressure-off'
        ],
        // Set environment for launch
        env: {
          ...process.env,
          DISPLAY: process.env.DISPLAY || ':99'
        }
      });
      
      // Create a new page
      this.page = await this.browser.newPage();
      
      // Enable console logging from the page
      this.page.on('console', msg => {
        logger.debug(`📟 WebRTCViewBot ${this.botId} [Browser]:`, msg.text());
      });
      
      this.page.on('pageerror', error => {
        logger.error(`❌ WebRTCViewBot ${this.botId} [Browser Error]:`, error.message);
      });
      
      // Navigate to the viewbot streaming page
      const streamUrl = `${this.serverUrl}/viewbot-stream.html?botId=${this.botId}`;
      logger.debug(`📺 WebRTCViewBot ${this.botId}: Navigating to ${streamUrl}`);
      await this.page.goto(streamUrl, { waitUntil: 'networkidle2' });
      
      logger.debug(`✅ WebRTCViewBot ${this.botId}: Browser initialized`);
      
    } catch (error) {
      logger.error(`❌ WebRTCViewBot ${this.botId}: Failed to initialize:`, error);
      throw error;
    }
  }

  /**
   * Start streaming the video file
   */
  async startStreaming() {
    if (this.isStreaming) {
      logger.debug(`⚠️ WebRTCViewBot ${this.botId}: Already streaming`);
      return;
    }
    
    try {
      logger.debug(`🎬 WebRTCViewBot ${this.botId}: Starting stream with video ${this.videoFile}`);
      
      // Inject the video file path and start streaming
      const result = await this.page.evaluate(async (videoPath, botId) => {
        // This code runs in the browser context
        if (typeof window.startViewBotStream === 'function') {
          return await window.startViewBotStream(videoPath, botId);
        } else {
          throw new Error('startViewBotStream function not found in page');
        }
      }, this.videoFile, this.botId);
      
      if (result.success) {
        this.isStreaming = true;
        logger.debug(`✅ WebRTCViewBot ${this.botId}: Streaming started successfully`);
      } else {
        throw new Error(result.error || 'Failed to start stream');
      }
      
    } catch (error) {
      logger.error(`❌ WebRTCViewBot ${this.botId}: Failed to start streaming:`, error);
      throw error;
    }
  }

  /**
   * Stop streaming
   */
  async stopStreaming() {
    if (!this.isStreaming) {
      logger.debug(`⚠️ WebRTCViewBot ${this.botId}: Not streaming`);
      return;
    }
    
    try {
      logger.debug(`⏹️ WebRTCViewBot ${this.botId}: Stopping stream...`);
      
      // Stop streaming in the browser
      await this.page.evaluate(async () => {
        if (typeof window.stopViewBotStream === 'function') {
          return await window.stopViewBotStream();
        }
      });
      
      this.isStreaming = false;
      logger.debug(`✅ WebRTCViewBot ${this.botId}: Stream stopped`);
      
    } catch (error) {
      logger.error(`❌ WebRTCViewBot ${this.botId}: Error stopping stream:`, error);
    }
  }

  /**
   * Clean up and close browser
   */
  async cleanup() {
    logger.debug(`🧹 WebRTCViewBot ${this.botId}: Cleaning up...`);
    
    if (this.isStreaming) {
      await this.stopStreaming();
    }
    
    if (this.page) {
      await this.page.close();
      this.page = null;
    }
    
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    
    logger.debug(`✅ WebRTCViewBot ${this.botId}: Cleaned up`);
  }

  /**
   * Get bot status
   */
  getStatus() {
    return {
      botId: this.botId,
      videoFile: this.videoFile,
      isStreaming: this.isStreaming,
      browserRunning: !!this.browser,
      pageLoaded: !!this.page
    };
  }
}

module.exports = WebRTCViewBot;
