/**
 * Initialize the Simple ViewBot Rotation System
 * This replaces the complex ViewBotClientService rotation
 */

const ViewBotRotationIntegration = require('./ViewBotRotationIntegration');

async function initializeSimpleRotation(streamService) {
  try {
    console.log('🎯 Initializing Simple ViewBot Rotation System...');
    
    // Initialize the rotation system
    const result = await ViewBotRotationIntegration.initialize();
    
    if (!result.success) {
      console.error('❌ Failed to initialize rotation:', result.error);
      return false;
    }
    
    console.log(`✅ Simple rotation initialized with ${result.botCount} bots`);
    
    // Listen for real streamer events from StreamService
    if (streamService) {
      // When a real streamer starts
      streamService.on('streamer-connected', (socketId) => {
        console.log(`👤 Real streamer connected: ${socketId}`);
        ViewBotRotationIntegration.handleRealStreamerActive(true);
      });
      
      // When real streamer stops
      streamService.on('streamer-disconnected', (socketId) => {
        console.log(`👤 Real streamer disconnected: ${socketId}`);
        // Wait a bit to make sure they're really gone
        setTimeout(() => {
          const currentStreamer = streamService.getCurrentStreamer();
          if (!currentStreamer) {
            ViewBotRotationIntegration.handleRealStreamerActive(false);
          }
        }, 3000);
      });
      
      // Check current streamer status
      const currentStreamer = streamService.getCurrentStreamer();
      if (currentStreamer) {
        console.log(`👤 Real streamer already active: ${currentStreamer}`);
        ViewBotRotationIntegration.handleRealStreamerActive(true);
      } else {
        console.log('🤖 No real streamer active, starting viewbot rotation');
        // Start rotation after a delay to let everything initialize
        setTimeout(() => {
          ViewBotRotationIntegration.startRotation();
        }, 5000);
      }
    }
    
    // Add API endpoints for admin control
    global.simpleRotationAPI = {
      getStatus: () => ViewBotRotationIntegration.getStatus(),
      forceRotation: () => ViewBotRotationIntegration.forceRotation(),
      updateSettings: (settings) => ViewBotRotationIntegration.updateSettings(settings),
      stop: () => ViewBotRotationIntegration.stopRotation(),
      start: () => ViewBotRotationIntegration.startRotation()
    };
    
    console.log('✅ Simple ViewBot Rotation System ready');
    return true;
    
  } catch (error) {
    console.error('❌ Error initializing simple rotation:', error);
    return false;
  }
}

// Handle shutdown
process.on('SIGINT', async () => {
  console.log('🛑 Shutting down Simple Rotation...');
  await ViewBotRotationIntegration.shutdown();
});

process.on('SIGTERM', async () => {
  console.log('🛑 Shutting down Simple Rotation...');
  await ViewBotRotationIntegration.shutdown();
});

module.exports = initializeSimpleRotation;