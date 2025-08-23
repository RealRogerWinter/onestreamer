/**
 * ViewBot Monitor Service
 * Monitors and ensures ViewBot streaming states are consistent
 * Fixes state discrepancies and ensures rotation system works properly
 */

const ViewBotManager = require('./ViewBotManager');
const stateManager = require('./ViewBotStateManager');

class ViewBotMonitor {
  constructor() {
    this.checkInterval = null;
    this.stateChecks = new Map();
    this.lastRotationCheck = Date.now();
    this.rotationCheckInterval = 65000; // 65 seconds
    this.isMonitoring = false;
  }

  /**
   * Start monitoring ViewBot states
   */
  start() {
    if (this.isMonitoring) {
      console.log('📊 ViewBot Monitor: Already running');
      return;
    }

    console.log('📊 ViewBot Monitor: Starting monitoring service');
    this.isMonitoring = true;

    // Check states every 5 seconds
    this.checkInterval = setInterval(() => {
      this.checkAllBotStates();
    }, 5000);

    // Initial check
    this.checkAllBotStates();
  }

  /**
   * Stop monitoring
   */
  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.isMonitoring = false;
    console.log('📊 ViewBot Monitor: Stopped');
  }

  /**
   * Check all bot states for consistency
   */
  async checkAllBotStates() {
    try {
      const manager = ViewBotManager.getInstance();
      const allBots = manager.getAllBots();

      let streamingCount = 0;
      let inconsistentStates = [];

      for (const [botId, bot] of allBots) {
        const actualStreaming = bot.streaming || false;
        const actualStarting = bot.isStartingStream || false;
        const stateManagerState = stateManager.getState(botId);
        const stateManagerStreaming = stateManager.isStreaming(botId);

        // Check for state inconsistencies
        if (stateManager.simplifiedMode && stateManagerState) {
          if (stateManagerStreaming !== actualStreaming) {
            inconsistentStates.push({
              botId,
              actualStreaming,
              stateManagerStreaming,
              actualStarting
            });
          }
        }

        if (actualStreaming) {
          streamingCount++;
        }

        // Track state changes
        const prevState = this.stateChecks.get(botId) || {};
        const currentState = {
          streaming: actualStreaming,
          isStartingStream: actualStarting,
          stateManagerState: stateManagerState,
          timestamp: Date.now()
        };

        // Detect stuck states (bot starting for more than 30 seconds)
        if (actualStarting && prevState.isStartingStream) {
          const startingDuration = currentState.timestamp - prevState.timestamp;
          if (startingDuration > 30000) {
            console.log(`⚠️ MONITOR: Bot ${botId} stuck in starting state for ${Math.round(startingDuration/1000)}s`);
            
            // Force fix the stuck state
            if (stateManager.simplifiedMode) {
              console.log(`🔧 MONITOR: Forcing bot ${botId} to streaming state`);
              bot.isStartingStream = false;
              bot.streaming = true;
              stateManager.forceState(botId, 'streaming');
            }
          }
        }

        this.stateChecks.set(botId, currentState);
      }

      // Fix inconsistent states
      for (const inconsistency of inconsistentStates) {
        console.log(`🔧 MONITOR: Fixing state inconsistency for bot ${inconsistency.botId}`);
        console.log(`   Actual: streaming=${inconsistency.actualStreaming}, StateManager: streaming=${inconsistency.stateManagerStreaming}`);
        
        // Sync the states
        if (stateManager.simplifiedMode) {
          const bot = allBots.get(inconsistency.botId);
          if (bot) {
            if (inconsistency.stateManagerStreaming && !inconsistency.actualStreaming) {
              // State manager thinks it's streaming but bot isn't
              bot.streaming = true;
              bot.isStartingStream = false;
            } else if (!inconsistency.stateManagerStreaming && inconsistency.actualStreaming) {
              // Bot is streaming but state manager doesn't know
              stateManager.forceState(inconsistency.botId, 'streaming');
            }
          }
        }
      }

      // Log summary every minute
      const now = Date.now();
      if (now - this.lastRotationCheck > 60000) {
        console.log(`📊 MONITOR: Status Report`);
        console.log(`   Total bots: ${allBots.size}`);
        console.log(`   Streaming: ${streamingCount}`);
        console.log(`   State inconsistencies fixed: ${inconsistentStates.length}`);
        console.log(`   Simplified mode: ${stateManager.simplifiedMode ? 'ENABLED' : 'DISABLED'}`);
        
        // Check if rotation system is working
        const timeSinceLastRotation = now - this.lastRotationCheck;
        if (timeSinceLastRotation > this.rotationCheckInterval * 2) {
          console.log(`⚠️ MONITOR: No rotation checks detected for ${Math.round(timeSinceLastRotation/1000)}s`);
        }
        
        this.lastRotationCheck = now;
      }

    } catch (error) {
      console.error('❌ MONITOR: Error checking bot states:', error.message);
    }
  }

  /**
   * Force enable simplified mode for all bots
   */
  enableSimplifiedMode() {
    console.log('📊 MONITOR: Enabling simplified mode for all bots');
    stateManager.simplifiedMode = true;
    
    // Register all existing bots
    const manager = ViewBotManager.getInstance();
    const allBots = manager.getAllBots();
    
    for (const [botId, bot] of allBots) {
      if (!stateManager.getState(botId)) {
        stateManager.registerBot(botId);
        if (bot.streaming) {
          stateManager.forceState(botId, 'streaming');
        }
      }
    }
  }

  /**
   * Get monitoring statistics
   */
  getStats() {
    const manager = ViewBotManager.getInstance();
    const allBots = manager.getAllBots();
    
    let stats = {
      totalBots: allBots.size,
      streaming: 0,
      starting: 0,
      idle: 0,
      stateManagerBots: stateManager.bots.size,
      simplifiedMode: stateManager.simplifiedMode
    };
    
    for (const [botId, bot] of allBots) {
      if (bot.streaming) stats.streaming++;
      else if (bot.isStartingStream) stats.starting++;
      else stats.idle++;
    }
    
    return stats;
  }
}

// Export singleton instance
module.exports = new ViewBotMonitor();