const AccountService = require('./AccountService');

class TimeTrackingService {
    constructor(io = null) {
        this.accountService = new AccountService();
        this.io = io; // Socket.IO instance for real-time updates
        // Track active sessions: userId -> { startTime, type, socketId }
        this.activeSessions = new Map();
        // Track viewing sessions: socketId -> { userId, startTime }
        this.viewingSessions = new Map();
        // Real-time update intervals
        this.updateIntervals = new Map();
    }

    // Set Socket.IO instance after initialization
    setSocketIO(io) {
        this.io = io;
    }

    // Start tracking time for a user when they begin streaming
    startStreamingSession(userId, socketId) {
        console.log(`📊 TIME: Starting streaming session for user ${userId} (socket: ${socketId})`);
        
        // End any existing streaming session for this user
        this.endStreamingSession(userId);
        
        // Start new streaming session
        this.activeSessions.set(userId, {
            startTime: Date.now(),
            type: 'streaming',
            socketId: socketId
        });

        // Start real-time updates for this user
        this.startRealTimeUpdates(userId, 'streaming');
    }


    // Start tracking time for a user when they begin viewing
    startViewingSession(userId, socketId, hasActiveStream = false) {
        console.log(`📊 TIME: Starting viewing session for user ${userId} (socket: ${socketId}), active stream: ${hasActiveStream}`);
        
        // End any existing viewing session for this socket
        this.endViewingSessionBySocket(socketId);
        
        // Only start viewing session if there's an active stream
        if (hasActiveStream) {
            // Start new viewing session
            this.viewingSessions.set(socketId, {
                userId: userId,
                startTime: Date.now()
            });

            // Start real-time updates for this user
            this.startRealTimeUpdates(userId, 'viewing');
            console.log(`✅ TIME: View time tracking started for user ${userId} (socket: ${socketId})`);
        } else {
            console.log(`📊 TIME: No active stream, not starting viewing session for user ${userId}`);
        }
    }


    // End viewing session by socket ID (when user disconnects)
    async endViewingSessionBySocket(socketId) {
        const session = this.viewingSessions.get(socketId);
        if (!session) {
            return 0;
        }

        return await this.endViewingSession(session.userId, socketId);
    }

    // Get current active sessions for debugging
    getActiveSessions() {
        return {
            streaming: Object.fromEntries(this.activeSessions),
            viewing: Object.fromEntries(this.viewingSessions)
        };
    }

    // Cleanup method for when a user disconnects
    async handleUserDisconnect(userId, socketId) {
        console.log(`📊 TIME: Handling disconnect for user ${userId} (socket: ${socketId})`);
        
        // End streaming session if active
        const streamingDuration = await this.endStreamingSession(userId);
        
        // End viewing session if active
        const viewingDuration = await this.endViewingSessionBySocket(socketId);
        
        return {
            streamingDuration,
            viewingDuration
        };
    }

    // Get user's current points (for API responses)
    async getUserPoints(userId) {
        try {
            const stats = await this.accountService.getUserStats(userId);
            if (!stats) {
                return 0;
            }

            // Return the points balance directly
            return stats.points_balance || 0;
        } catch (error) {
            console.error(`❌ TIME: Failed to get points for user ${userId}:`, error);
            return 0;
        }
    }

    // Periodic cleanup of stale sessions (run every 5 minutes)
    startPeriodicCleanup() {
        this.cleanupIntervalId = setInterval(() => {
            this.cleanupStaleSessions();
        }, 5 * 60 * 1000); // 5 minutes
    }

    // Stop periodic cleanup (for server shutdown)
    stopPeriodicCleanup() {
        if (this.cleanupIntervalId) {
            clearInterval(this.cleanupIntervalId);
            this.cleanupIntervalId = null;
        }
        // Also stop all real-time updates
        for (const [userId, intervalId] of this.realTimeUpdateIntervals.entries()) {
            clearInterval(intervalId);
        }
        this.realTimeUpdateIntervals.clear();
        console.log('⏱️ TIME: Stopped all periodic tasks');
    }

    cleanupStaleSessions() {
        const now = Date.now();
        const maxSessionAge = 60 * 60 * 1000; // 1 hour

        // Clean up streaming sessions older than 1 hour
        for (const [userId, session] of this.activeSessions.entries()) {
            if (now - session.startTime > maxSessionAge) {
                console.log(`🧹 TIME: Cleaning up stale streaming session for user ${userId}`);
                this.endStreamingSession(userId);
            }
        }

        // Clean up viewing sessions older than 1 hour
        for (const [socketId, session] of this.viewingSessions.entries()) {
            if (now - session.startTime > maxSessionAge) {
                console.log(`🧹 TIME: Cleaning up stale viewing session for socket ${socketId}`);
                this.endViewingSessionBySocket(socketId);
            }
        }
    }

    // Restart time tracking sessions after a user logs in
    async restartSessionsAfterLogin(userId, ipAddress) {
        console.log(`📊 TIME: Restarting sessions after login for user ${userId} at IP ${ipAddress}`);
        
        if (!this.io) {
            console.log(`📊 TIME: No socket.io instance available for restart`);
            return;
        }

        // Find all active socket connections for this IP by iterating through connected sockets
        const connectedSockets = [];
        for (const [socketId, socket] of this.io.sockets.sockets.entries()) {
            // Get socket IP and check if it matches
            const socketIp = this.getSocketIp(socket);
            if (socketIp === ipAddress) {
                connectedSockets.push({ socketId, socket });
            }
        }

        if (connectedSockets.length === 0) {
            console.log(`📊 TIME: No active sockets found for IP ${ipAddress}`);
            return;
        }

        console.log(`📊 TIME: Found ${connectedSockets.length} active sockets for IP ${ipAddress}`);

        for (const { socketId, socket } of connectedSockets) {
            // Check if socket is in viewers room (watching)
            if (socket.rooms.has('viewers')) {
                // Check if there's an active stream by checking if there are any sockets in 'streamer' room
                const hasActiveStream = this.io.sockets.adapter.rooms.has('streamer') && 
                                       this.io.sockets.adapter.rooms.get('streamer').size > 0;
                
                if (hasActiveStream) {
                    console.log(`📊 TIME: Restarting viewing session for user ${userId} on socket ${socketId}`);
                    this.startViewingSession(userId, socketId, true);
                }
            }

            // Check if socket is streaming (in streamer room or test-streamers room)
            if (socket.rooms.has('streamer') || socket.rooms.has('test-streamers')) {
                console.log(`📊 TIME: Restarting streaming session for user ${userId} on socket ${socketId}`);
                this.startStreamingSession(userId, socketId);
            }

            // Send immediate stats update to the socket after linking user account
            await this.sendImmediateStatsUpdate(userId, socketId);
        }
    }

    // Track chat message for a user
    async trackChatMessage(userId) {
        console.log(`💬 TIME: Tracking chat message for user ${userId}`);
        
        try {
            const CHAT_POINTS = 50; // Points per chat message
            
            // Update chat message count
            await this.accountService.updateUserStats(userId, {
                chatMessageCount: 1
            });
            
            // Add points for chat message
            const newBalance = await this.accountService.addPoints(
                userId,
                CHAT_POINTS,
                'chat',
                'Chat message reward',
                { messageCount: 1 }
            );
            
            console.log(`✅ TIME: Chat message tracked for user ${userId}. Awarded ${CHAT_POINTS} points. New balance: ${newBalance}`);
            
            // Send real-time update to user
            await this.sendRealTimeStatsUpdate(userId, 'chat');
        } catch (error) {
            console.error(`❌ TIME: Failed to track chat message for user ${userId}:`, error);
        }
    }

    // Send real-time stats update specifically for chat messages
    async sendRealTimeStatsUpdate(userId, updateType = 'general') {
        if (!this.io) {
            return;
        }

        try {
            // Get user's current stats from database
            const userStats = await this.accountService.getUserStats(userId);
            
            if (userStats) {
                // Use the points_balance from database
                const currentPoints = userStats.points_balance || 0;

                // Find all sockets for this user
                const socketsToUpdate = [];
                
                // Check main server sockets (viewing/streaming)
                if (this.io.sockets) {
                    for (const [socketId, socket] of this.io.sockets.sockets.entries()) {
                        const socketIp = this.getSocketIp(socket);
                        // You might need to implement a way to map IP to userId or store userId in socket data
                        // For now, we'll emit to all sockets that might belong to this user
                        socketsToUpdate.push(socketId);
                    }
                }

                const updateData = {
                    userId,  // Include userId so client can filter
                    totalStreamTime: userStats.total_stream_time || 0,
                    totalViewTime: userStats.total_view_time || 0,
                    chatMessageCount: userStats.chat_message_count || 0,
                    points: currentPoints,
                    updateType: updateType,
                    pointSource: 'chatting', // Source of the points being awarded
                    timestamp: Date.now()
                };

                console.log(`📊 TIME: Broadcasting real-time stats update for user ${userId} (${updateType}):`, updateData);
                
                // Broadcast to all sockets - the client-side will filter by userId
                this.io.emit('time-stats-update', updateData);
            }
        } catch (error) {
            console.error(`❌ TIME: Error sending real-time stats update for user ${userId}:`, error);
        }
    }

    // Send immediate stats update to a specific socket after user authentication
    async sendImmediateStatsUpdate(userId, socketId) {
        try {
            const userStats = await this.accountService.getUserStats(userId);
            if (userStats) {
                // Use the points_balance from database
                const currentPoints = userStats.points_balance || 0;

                const updateData = {
                    userId,  // Include userId so client can filter
                    totalStreamTime: userStats.total_stream_time || 0,
                    totalViewTime: userStats.total_view_time || 0,
                    chatMessageCount: userStats.chat_message_count || 0,
                    points: currentPoints,
                    currentSessionTime: 0,
                    sessionType: 'initial',
                    timestamp: Date.now()
                };

                console.log(`📊 TIME: Broadcasting immediate stats update after login for user ${userId}:`, updateData);
                // Broadcast to all sockets - client will filter by userId
                this.io.emit('time-stats-update', updateData);
            }
        } catch (error) {
            console.error(`❌ TIME: Error sending immediate stats update for user ${userId}:`, error);
        }
    }

    // Helper method to get socket IP address
    getSocketIp(socket) {
        let ip = socket.handshake.headers['x-forwarded-for'] || 
                 socket.handshake.headers['x-real-ip'] ||
                 socket.handshake.address ||
                 socket.conn.remoteAddress ||
                 socket.request.connection.remoteAddress ||
                 '127.0.0.1';
        
        // Handle IPv6 localhost
        if (ip === '::1' || ip === '::ffff:127.0.0.1') {
            ip = '127.0.0.1';
        }
        
        // Extract IPv4 from IPv6 format if needed
        if (ip.includes('::ffff:')) {
            ip = ip.replace('::ffff:', '');
        }
        
        // If multiple IPs (from proxy chain), take the first one
        if (ip.includes(',')) {
            ip = ip.split(',')[0].trim();
        }
        
        return ip;
    }

    // Start real-time updates for a user
    startRealTimeUpdates(userId, sessionType) {
        // Clear any existing interval for this user
        this.stopRealTimeUpdates(userId);

        // Create new interval to update every 25 seconds
        const intervalId = setInterval(async () => {
            try {
                await this.sendRealTimeUpdate(userId, sessionType);
            } catch (error) {
                console.error(`❌ TIME: Failed to send real-time update for user ${userId}:`, error);
            }
        }, 25000); // Update every 25 seconds

        this.updateIntervals.set(userId, intervalId);
        console.log(`📊 TIME: Started real-time updates for user ${userId} (${sessionType})`);
    }

    // Stop real-time updates for a user
    stopRealTimeUpdates(userId) {
        const intervalId = this.updateIntervals.get(userId);
        if (intervalId) {
            clearInterval(intervalId);
            this.updateIntervals.delete(userId);
            console.log(`📊 TIME: Stopped real-time updates for user ${userId}`);
        }
    }

    // Send real-time update to the user
    async sendRealTimeUpdate(userId, sessionType) {
        if (!this.io) {
            return; // No socket.io instance available
        }

        try {
            // Define point awards per 25-second interval
            const POINTS_PER_UPDATE = {
                streaming: 500,  // 500 points per 25 seconds streaming
                viewing: 200     // 200 points per 25 seconds viewing
            };
            
            const pointsToAdd = POINTS_PER_UPDATE[sessionType] || 0;
            let newBalance = 0;
            
            // Update time stats
            const INCREMENT_SECONDS = 25;
            if (sessionType === 'streaming') {
                await this.accountService.updateUserStats(userId, {
                    streamTime: INCREMENT_SECONDS
                });
            } else if (sessionType === 'viewing') {
                await this.accountService.updateUserStats(userId, {
                    viewTime: INCREMENT_SECONDS
                });
            }
            
            // Add points to balance
            if (pointsToAdd > 0) {
                newBalance = await this.accountService.addPoints(
                    userId,
                    pointsToAdd,
                    sessionType,
                    `${sessionType === 'streaming' ? 'Streaming' : 'Viewing'} reward (25 seconds)`,
                    { duration: INCREMENT_SECONDS }
                );
                console.log(`🎯 Awarded ${pointsToAdd} points to user ${userId} for ${sessionType}. New balance: ${newBalance}`);
            }
            
            // Get updated stats from database
            const userStats = await this.accountService.getUserStats(userId);
            
            if (userStats) {
                // Use the points_balance from database
                const currentPoints = userStats.points_balance || 0;

                // Find the user's socket and emit update
                const socketId = sessionType === 'streaming' 
                    ? this.activeSessions.get(userId)?.socketId 
                    : this.findViewingSocketByUserId(userId);

                const updateData = {
                    userId,  // Include userId so client can filter
                    totalStreamTime: userStats.total_stream_time || 0,
                    totalViewTime: userStats.total_view_time || 0,
                    chatMessageCount: userStats.chat_message_count || 0,
                    points: currentPoints,  // This is the TOTAL points from database
                    sessionType,
                    pointSource: sessionType === 'streaming' ? 'streaming' : 'viewing',
                    timestamp: Date.now()
                };
                
                // Broadcast to ALL sockets - clients will filter by userId
                console.log(`📊 TIME: Broadcasting real-time update for user ${userId}:`, updateData);
                this.io.emit('time-stats-update', updateData);
            }
        } catch (error) {
            console.error(`❌ TIME: Error sending real-time update for user ${userId}:`, error);
        }
    }

    // Helper method to find viewing socket by user ID
    findViewingSocketByUserId(userId) {
        for (const [socketId, session] of this.viewingSessions.entries()) {
            if (session.userId === userId) {
                return socketId;
            }
        }
        return null;
    }

    // Update methods to stop real-time updates when sessions end
    async endStreamingSession(userId) {
        const session = this.activeSessions.get(userId);
        if (!session || session.type !== 'streaming') {
            return 0; // No active streaming session
        }

        // Stop real-time updates
        this.stopRealTimeUpdates(userId);

        const duration = Math.floor((Date.now() - session.startTime) / 1000); // Convert to seconds
        console.log(`📊 TIME: Ending streaming session for user ${userId}, duration: ${duration}s`);

        // Update user stats with streaming time
        try {
            await this.accountService.updateUserStats(userId, {
                streamTime: duration,
                streamCount: 1,
                lastStreamAt: new Date().toISOString()
            });
            console.log(`✅ TIME: Updated streaming stats for user ${userId}: +${duration}s`);
        } catch (error) {
            console.error(`❌ TIME: Failed to update streaming stats for user ${userId}:`, error);
        }

        // Remove the active session
        this.activeSessions.delete(userId);
        return duration;
    }

    async endViewingSession(userId, socketId) {
        const session = this.viewingSessions.get(socketId);
        if (!session || session.userId !== userId) {
            return 0; // No matching viewing session
        }

        // Stop real-time updates
        this.stopRealTimeUpdates(userId);

        const duration = Math.floor((Date.now() - session.startTime) / 1000); // Convert to seconds
        console.log(`📊 TIME: Ending viewing session for user ${userId} (socket: ${socketId}), duration: ${duration}s`);

        // Update user stats with viewing time
        if (duration > 5) { // Only count sessions longer than 5 seconds
            try {
                await this.accountService.updateUserStats(userId, {
                    viewTime: duration
                });
                console.log(`✅ TIME: Updated viewing stats for user ${userId}: +${duration}s`);
            } catch (error) {
                console.error(`❌ TIME: Failed to update viewing stats for user ${userId}:`, error);
            }
        }

        // Remove the viewing session
        this.viewingSessions.delete(socketId);
        return duration;
    }
}

module.exports = TimeTrackingService;