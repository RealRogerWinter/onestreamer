
const { spawn } = require('child_process');

class SimpleTestBot {
  constructor(mediasoupService, io) {
    this.mediasoupService = mediasoupService;
    this.io = io;
    this.isRunning = false;
  }
  
  async start() {
    if (this.isRunning) return;
    
    console.log('🤖 TEST BOT: Starting simple test bot');
    this.isRunning = true;
    
    // Emit test stream-ready event every 5 seconds
    this.interval = setInterval(() => {
      if (this.io) {
        console.log('🤖 TEST BOT: Emitting test stream-ready');
        this.io.emit('stream-ready', {
          streamerId: 'test-bot-' + Date.now(),
          isViewBot: true,
          streamType: 'test',
          timestamp: Date.now()
        });
      }
    }, 5000);
  }
  
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.isRunning = false;
    console.log('🤖 TEST BOT: Stopped');
  }
}

module.exports = SimpleTestBot;
