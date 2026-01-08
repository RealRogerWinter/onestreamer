const { execSync } = require('child_process');

/**
 * Centralized Process Manager for ViewBot GStreamer processes
 * This ensures proper cleanup and prevents orphaned processes
 */
class ProcessManager {
  constructor() {
    // Map of botId -> { video: pid, audio: pid }
    this.activeProcesses = new Map();
    
    // Single streaming bot tracking
    this.currentStreamingBot = null;
    
    // Lock to prevent concurrent operations
    this.operationLock = false;
    
    console.log('🔧 ProcessManager: Initialized centralized process management');
  }

  /**
   * Register a process for a bot
   */
  registerProcess(botId, type, pid) {
    if (!this.activeProcesses.has(botId)) {
      this.activeProcesses.set(botId, {});
    }
    
    const processes = this.activeProcesses.get(botId);
    processes[type] = pid;
    
    console.log(`📝 ProcessManager: Registered ${type} process ${pid} for bot ${botId}`);
  }

  /**
   * Kill ALL processes for a specific bot
   */
  async killBotProcesses(botId) {
    const processes = this.activeProcesses.get(botId);
    if (!processes) {
      console.log(`⚠️ ProcessManager: No processes registered for bot ${botId}`);
      return;
    }

    console.log(`🔫 ProcessManager: Killing all processes for bot ${botId}`);
    
    for (const [type, pid] of Object.entries(processes)) {
      if (pid) {
        try {
          // Use process group kill on Linux
          console.log(`   Killing ${type} process group -${pid}`);
          execSync(`kill -9 -${pid}`, { stdio: 'ignore' });
        } catch (error) {
          // Process might already be dead
          console.log(`   Process ${pid} already terminated`);
        }
      }
    }
    
    // Remove from tracking
    this.activeProcesses.delete(botId);
  }

  /**
   * Kill ALL GStreamer processes system-wide (nuclear option)
   */
  async killAllGStreamerProcesses() {
    console.log('☢️ ProcessManager: NUCLEAR CLEANUP - Killing ALL GStreamer processes');
    
    try {
      // Kill all gst-launch processes
      execSync("pkill -9 -f gst-launch", { stdio: 'ignore' });
    } catch (error) {
      // No processes to kill
    }
    
    // Clear all tracking
    this.activeProcesses.clear();
    this.currentStreamingBot = null;
  }

  /**
   * Ensure only one bot can stream at a time
   */
  async prepareForStreaming(botId) {
    // Wait if another operation is in progress
    while (this.operationLock) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    this.operationLock = true;
    
    try {
      console.log(`🎬 ProcessManager: Preparing for bot ${botId} to stream`);
      
      // If another bot is streaming, kill it first
      if (this.currentStreamingBot && this.currentStreamingBot !== botId) {
        console.log(`⚠️ ProcessManager: Bot ${this.currentStreamingBot} is currently streaming, killing it first`);
        await this.killBotProcesses(this.currentStreamingBot);
      }
      
      // Kill any existing processes for this bot (in case of duplicates)
      await this.killBotProcesses(botId);
      
      // Nuclear option: Kill ALL GStreamer processes to ensure clean state
      await this.killAllGStreamerProcesses();
      
      // Set as current streaming bot
      this.currentStreamingBot = botId;
      
      console.log(`✅ ProcessManager: Bot ${botId} is now clear to stream`);
    } finally {
      this.operationLock = false;
    }
  }

  /**
   * Clean up after a bot stops streaming
   */
  async onBotStopped(botId) {
    console.log(`🛑 ProcessManager: Bot ${botId} stopped streaming`);
    
    // Kill any remaining processes
    await this.killBotProcesses(botId);
    
    // Clear current if it matches
    if (this.currentStreamingBot === botId) {
      this.currentStreamingBot = null;
    }
  }

  /**
   * Get current process count for monitoring
   */
  getProcessCount() {
    let count = 0;
    for (const processes of this.activeProcesses.values()) {
      count += Object.keys(processes).length;
    }
    return count;
  }

  /**
   * Get detailed process info
   */
  getProcessInfo() {
    const info = {
      currentStreamingBot: this.currentStreamingBot,
      totalProcesses: this.getProcessCount(),
      bots: {}
    };
    
    for (const [botId, processes] of this.activeProcesses.entries()) {
      info.bots[botId] = processes;
    }
    
    return info;
  }
}

// Export singleton instance
module.exports = new ProcessManager();