/**
 * ViewBot State Manager - Middleware for managing ViewBot streaming states
 * Implements a finite state machine to ensure consistent state management
 * and proper rotation system operation.
 */

class ViewBotStateManager {
  constructor() {
    // State definitions for ViewBot streaming
    this.STATES = {
      IDLE: 'idle',
      CONNECTING: 'connecting',
      REQUESTING: 'requesting',
      APPROVED: 'approved',
      STREAMING: 'streaming',
      ERROR: 'error',
      STOPPED: 'stopped'
    };

    // Valid state transitions - allow direct IDLE->APPROVED for emergency starts
    // Also allow STREAMING->APPROVED for rotation scenarios
    this.TRANSITIONS = {
      [this.STATES.IDLE]: [this.STATES.CONNECTING, this.STATES.APPROVED, this.STATES.REQUESTING],
      [this.STATES.CONNECTING]: [this.STATES.REQUESTING, this.STATES.ERROR, this.STATES.IDLE, this.STATES.APPROVED],
      [this.STATES.REQUESTING]: [this.STATES.APPROVED, this.STATES.ERROR, this.STATES.IDLE],
      [this.STATES.APPROVED]: [this.STATES.STREAMING, this.STATES.ERROR, this.STATES.IDLE],
      [this.STATES.STREAMING]: [this.STATES.STOPPED, this.STATES.ERROR, this.STATES.IDLE, this.STATES.APPROVED],
      [this.STATES.ERROR]: [this.STATES.IDLE],
      [this.STATES.STOPPED]: [this.STATES.IDLE]
    };

    // Track bot states
    this.botStates = new Map();
    
    // Track state change history for debugging
    this.stateHistory = new Map();
    
    // State change callbacks
    this.stateChangeCallbacks = new Map();
    
    // Simplified streaming mode for testing rotation
    this.simplifiedMode = true;
    
    console.log('📊 ViewBotStateManager: Initialized with simplified mode for rotation testing');
  }

  /**
   * Register a bot with the state manager
   */
  registerBot(botId) {
    if (!this.botStates.has(botId)) {
      this.botStates.set(botId, {
        currentState: this.STATES.IDLE,
        previousState: null,
        stateData: {},
        timestamp: Date.now(),
        streamingStartTime: null,
        errorCount: 0
      });
      
      this.stateHistory.set(botId, []);
      
      console.log(`📊 StateManager: Registered bot ${botId} in IDLE state`);
    }
  }

  /**
   * Get current state of a bot
   */
  getState(botId) {
    const botState = this.botStates.get(botId);
    return botState ? botState.currentState : null;
  }

  /**
   * Check if bot is in streaming state
   */
  isStreaming(botId) {
    const state = this.getState(botId);
    return state === this.STATES.STREAMING;
  }

  /**
   * Transition bot to a new state
   */
  transition(botId, newState, data = {}) {
    const botState = this.botStates.get(botId);
    
    if (!botState) {
      console.error(`❌ StateManager: Bot ${botId} not registered`);
      return false;
    }

    const currentState = botState.currentState;
    
    // Check if transition is valid
    const validTransitions = this.TRANSITIONS[currentState] || [];
    if (!validTransitions.includes(newState) && currentState !== newState) {
      console.error(`❌ StateManager: Invalid transition for ${botId}: ${currentState} -> ${newState}`);
      return false;
    }

    // Update state
    botState.previousState = currentState;
    botState.currentState = newState;
    botState.stateData = data;
    botState.timestamp = Date.now();

    // Track streaming start time
    if (newState === this.STATES.STREAMING) {
      botState.streamingStartTime = Date.now();
      botState.errorCount = 0; // Reset error count on successful streaming
    } else if (newState === this.STATES.STOPPED || newState === this.STATES.ERROR) {
      botState.streamingStartTime = null;
    }

    // Track error count
    if (newState === this.STATES.ERROR) {
      botState.errorCount++;
    }

    // Add to history
    const history = this.stateHistory.get(botId) || [];
    history.push({
      from: currentState,
      to: newState,
      timestamp: Date.now(),
      data
    });
    
    // Keep only last 50 transitions for memory efficiency
    if (history.length > 50) {
      history.shift();
    }
    
    this.stateHistory.set(botId, history);

    console.log(`📊 StateManager: Bot ${botId} transitioned: ${currentState} -> ${newState}`);

    // Trigger callbacks
    this.triggerCallbacks(botId, currentState, newState, data);

    return true;
  }

  /**
   * Register a callback for state changes
   */
  onStateChange(botId, callback) {
    if (!this.stateChangeCallbacks.has(botId)) {
      this.stateChangeCallbacks.set(botId, []);
    }
    this.stateChangeCallbacks.get(botId).push(callback);
  }

  /**
   * Trigger callbacks for state change
   */
  triggerCallbacks(botId, fromState, toState, data) {
    const callbacks = this.stateChangeCallbacks.get(botId) || [];
    callbacks.forEach(callback => {
      try {
        callback(fromState, toState, data);
      } catch (error) {
        console.error(`❌ StateManager: Callback error for ${botId}:`, error);
      }
    });
  }

  /**
   * Simplified streaming approval - bypasses media pipeline for testing
   */
  async approveStreaming(botId) {
    if (!this.transition(botId, this.STATES.APPROVED)) {
      return false;
    }

    if (this.simplifiedMode) {
      // In simplified mode, immediately transition to streaming
      // This bypasses media pipeline issues for rotation testing
      setTimeout(() => {
        this.transition(botId, this.STATES.STREAMING, {
          simplified: true,
          mockPipeline: true
        });
        console.log(`✅ StateManager: Bot ${botId} mock streaming active (simplified mode)`);
      }, 100);
      
      return true;
    }

    return true;
  }

  /**
   * Stop streaming for a bot
   */
  stopStreaming(botId) {
    const currentState = this.getState(botId);
    
    if (currentState === this.STATES.STREAMING) {
      const botState = this.botStates.get(botId);
      const streamingDuration = Date.now() - botState.streamingStartTime;
      
      this.transition(botId, this.STATES.STOPPED, {
        duration: streamingDuration
      });
      
      console.log(`⏹️ StateManager: Bot ${botId} stopped after ${Math.round(streamingDuration / 1000)}s`);
      
      // Auto-transition to IDLE after stop
      setTimeout(() => {
        this.transition(botId, this.STATES.IDLE);
      }, 100);
      
      return true;
    }
    
    return false;
  }

  /**
   * Get streaming duration for a bot
   */
  getStreamingDuration(botId) {
    const botState = this.botStates.get(botId);
    
    if (botState && botState.streamingStartTime) {
      return Date.now() - botState.streamingStartTime;
    }
    
    return 0;
  }

  /**
   * Get all streaming bots
   */
  getStreamingBots() {
    const streamingBots = [];
    
    for (const [botId, state] of this.botStates) {
      if (state.currentState === this.STATES.STREAMING) {
        streamingBots.push({
          botId,
          duration: this.getStreamingDuration(botId),
          startTime: state.streamingStartTime
        });
      }
    }
    
    return streamingBots;
  }

  /**
   * Reset a bot to IDLE state
   */
  resetBot(botId) {
    const botState = this.botStates.get(botId);
    
    if (botState) {
      botState.currentState = this.STATES.IDLE;
      botState.previousState = null;
      botState.stateData = {};
      botState.streamingStartTime = null;
      botState.errorCount = 0;
      
      console.log(`🔄 StateManager: Bot ${botId} reset to IDLE`);
    }
  }

  /**
   * Get state statistics
   */
  getStatistics() {
    const stats = {
      total: this.botStates.size,
      byState: {},
      streaming: [],
      errors: []
    };

    for (const state of Object.values(this.STATES)) {
      stats.byState[state] = 0;
    }

    for (const [botId, state] of this.botStates) {
      stats.byState[state.currentState]++;
      
      if (state.currentState === this.STATES.STREAMING) {
        stats.streaming.push({
          botId,
          duration: this.getStreamingDuration(botId)
        });
      }
      
      if (state.errorCount > 0) {
        stats.errors.push({
          botId,
          errorCount: state.errorCount,
          currentState: state.currentState
        });
      }
    }

    return stats;
  }

  /**
   * Toggle simplified mode
   */
  setSimplifiedMode(enabled) {
    this.simplifiedMode = enabled;
    console.log(`📊 StateManager: Simplified mode ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Clean up inactive bots
   */
  cleanup() {
    const now = Date.now();
    const inactiveThreshold = 10 * 60 * 1000; // 10 minutes
    
    for (const [botId, state] of this.botStates) {
      if (state.currentState === this.STATES.IDLE && 
          (now - state.timestamp) > inactiveThreshold) {
        this.botStates.delete(botId);
        this.stateHistory.delete(botId);
        this.stateChangeCallbacks.delete(botId);
        console.log(`🧹 StateManager: Cleaned up inactive bot ${botId}`);
      }
    }
  }

  /**
   * Force a bot into a specific state (for fixing inconsistencies)
   */
  forceState(botId, state) {
    if (!this.bots.has(botId)) {
      this.registerBot(botId);
    }
    
    console.log(`🔧 STATE MANAGER: Force setting bot ${botId} to state: ${state}`);
    this.bots.set(botId, state);
    
    // Update transition history
    if (!this.transitionHistory.has(botId)) {
      this.transitionHistory.set(botId, []);
    }
    
    const history = this.transitionHistory.get(botId);
    history.push({
      from: 'forced',
      to: state,
      timestamp: Date.now(),
      forced: true
    });
    
    // Keep only last 10 transitions
    if (history.length > 10) {
      history.shift();
    }
  }
}

// Export singleton instance
module.exports = new ViewBotStateManager();