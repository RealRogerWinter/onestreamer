const ItemService = require('./server/services/ItemService');
const InventoryService = require('./server/services/InventoryService');
const BuffDebuffService = require('./server/services/BuffDebuffService');
const TimeTrackingService = require('./server/services/TimeTrackingService');
const StreamService = require('./server/services/StreamService');
const SessionService = require('./server/services/SessionService');

async function testStreamingBuffDuration() {
    console.log('🧪 Testing streaming-based buff duration system...\n');
    
    try {
        // Initialize services in correct dependency order
        const streamService = new StreamService();
        const sessionService = new SessionService();
        const timeTrackingService = new TimeTrackingService();
        const itemService = new ItemService();
        const inventoryService = new InventoryService(itemService);
        
        // Wait for database initialization
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const buffDebuffService = new BuffDebuffService(null, streamService, timeTrackingService, sessionService);
        
        // Set buff service on inventory service
        inventoryService.setBuffDebuffService(buffDebuffService);
        
        console.log('✅ Services initialized\n');
        
        // Wait for buff service to initialize
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const userId = 3; // User onestreamer
        const socketId = 'test-socket-123';
        
        console.log('📊 Phase 1: User NOT streaming');
        
        // Use a speed boost item to create a buff
        console.log('⚡ Using speed boost item...');
        const useResult = await inventoryService.useItem(userId, 1);
        
        if (useResult.buffApplied) {
            console.log(`✅ Buff applied: ID ${useResult.buffApplied.id}, Duration: ${useResult.buffApplied.duration}s`);
            
            // Wait 5 seconds and check if buff duration decreased (it shouldn't for non-streaming user)
            console.log('\n⏳ Waiting 5 seconds (user NOT streaming)...');
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            const buffsAfterWaiting = await buffDebuffService.getActiveBuffsForUser(userId);
            const speedBoostBuff = buffsAfterWaiting.find(buff => buff.itemName === 'speed_boost');
            
            if (speedBoostBuff) {
                console.log(`📊 Buff duration after 5s (not streaming): ${speedBoostBuff.remainingSeconds}s`);
                
                if (speedBoostBuff.remainingSeconds >= useResult.buffApplied.duration - 2) {
                    console.log('✅ PASS: Buff duration preserved for non-streaming user');
                } else {
                    console.log('❌ FAIL: Buff duration decreased for non-streaming user');
                }
            }
            
            console.log('\n📊 Phase 2: User starts streaming');
            
            // Simulate user starting to stream
            sessionService.sessions.set('127.0.0.1', {
                userId: userId,
                isStreaming: true,
                socketCount: 1
            });
            
            // Add socketId to user mapping
            sessionService.userToIp.set(userId, '127.0.0.1');
            sessionService.socketToIp.set(socketId, '127.0.0.1');
            
            // Set user as current streamer
            streamService.setStreamer(socketId);
            
            // Start streaming session
            await timeTrackingService.startStreamingSession(userId);
            
            console.log(`🎥 User ${userId} is now streaming as ${socketId}`);
            console.log(`📡 Current streamer: ${streamService.getCurrentStreamer()}`);
            
            // Check active sessions
            const activeSessions = timeTrackingService.getActiveSessions();
            console.log(`📊 Active streaming sessions:`, activeSessions.streaming);
            
            // Wait 5 seconds and check if buff duration decreased (it should now)
            console.log('\n⏳ Waiting 5 seconds (user IS streaming)...');
            const beforeStreamingSeconds = speedBoostBuff.remainingSeconds;
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            const buffsAfterStreaming = await buffDebuffService.getActiveBuffsForUser(userId);
            const streamingSpeedBoostBuff = buffsAfterStreaming.find(buff => buff.itemName === 'speed_boost');
            
            if (streamingSpeedBoostBuff) {
                console.log(`📊 Buff duration after 5s (streaming): ${streamingSpeedBoostBuff.remainingSeconds}s`);
                console.log(`📊 Duration change: ${beforeStreamingSeconds - streamingSpeedBoostBuff.remainingSeconds} seconds`);
                
                if (streamingSpeedBoostBuff.remainingSeconds < beforeStreamingSeconds) {
                    console.log('✅ PASS: Buff duration decreased for streaming user');
                    
                    const expectedDecrease = 5; // 5 seconds
                    const actualDecrease = beforeStreamingSeconds - streamingSpeedBoostBuff.remainingSeconds;
                    
                    if (Math.abs(actualDecrease - expectedDecrease) <= 1) {
                        console.log('✅ PASS: Buff duration decreased by expected amount');
                    } else {
                        console.log(`⚠️  WARNING: Expected ~${expectedDecrease}s decrease, got ${actualDecrease}s`);
                    }
                } else {
                    console.log('❌ FAIL: Buff duration did not decrease for streaming user');
                }
            } else {
                console.log('❌ Buff disappeared');
            }
            
            // Clean up
            streamService.clearStreamer();
            await timeTrackingService.endStreamingSession(userId);
            
        } else {
            console.log('❌ Failed to apply buff');
        }
        
        console.log('\n🎉 Test completed!');
        
        // Shutdown services
        buffDebuffService.shutdown();
        
    } catch (error) {
        console.error('❌ Test error:', error.message);
        console.error('Stack:', error.stack);
    }
}

testStreamingBuffDuration();