class SessionService {
  constructor() {
    // Store sessions by IP address
    this.sessions = new Map();
    // Store socket IDs to IP mapping
    this.socketToIp = new Map();
    // Store IP to socket IDs mapping (multiple sockets per IP)
    this.ipToSockets = new Map();
    // Track unique viewers by IP
    this.uniqueViewers = new Set();
    // Chat usernames assigned to IPs
    this.ipToUsername = new Map();
    // Store IP to user ID mapping for authenticated users
    this.ipToUserId = new Map();
    // Store socket ID to user ID mapping for individual sockets (needed when multiple users share same IP)
    this.socketToUserId = new Map();
  }

  /**
   * Get IP address from socket/request
   */
  getIpAddress(socket) {
    // Try different methods to get IP
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

  /**
   * Register a new socket connection
   */
  registerSocket(socket) {
    const ip = this.getIpAddress(socket);
    
    // Map socket to IP
    this.socketToIp.set(socket.id, ip);
    
    // Add socket to IP's socket list
    if (!this.ipToSockets.has(ip)) {
      this.ipToSockets.set(ip, new Set());
    }
    this.ipToSockets.get(ip).add(socket.id);
    
    // Create or get session for this IP
    if (!this.sessions.has(ip)) {
      this.sessions.set(ip, {
        ip: ip,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        socketCount: 0,
        isStreaming: false,
        chatUsername: null,
        chatColor: null,
        userId: this.ipToUserId.get(ip) || null,
        stats: {
          streamTime: 0,
          viewTime: 0,
          streamCount: 0,
          chatMessageCount: 0,
          lastStreamAt: null
        }
      });
    }
    
    const session = this.sessions.get(ip);
    session.lastSeen = new Date().toISOString();
    session.socketCount = this.ipToSockets.get(ip).size;
    
    // Add to unique viewers
    this.uniqueViewers.add(ip);
    
    console.log(`📊 SESSION: Registered socket ${socket.id} for IP ${ip} (${session.socketCount} sockets)`);
    
    return session;
  }

  /**
   * Unregister a socket connection
   */
  unregisterSocket(socketId) {
    const ip = this.socketToIp.get(socketId);
    if (!ip) return null;
    
    // Remove socket from IP's socket list
    const sockets = this.ipToSockets.get(ip);
    if (sockets) {
      sockets.delete(socketId);
      
      // If no more sockets for this IP, remove from viewers
      if (sockets.size === 0) {
        this.ipToSockets.delete(ip);
        this.uniqueViewers.delete(ip);
        
        // Update session
        const session = this.sessions.get(ip);
        if (session) {
          session.socketCount = 0;
          session.isStreaming = false;
          console.log(`📊 SESSION: IP ${ip} has no more connections, removed from viewers`);
        }
      } else {
        // Update socket count in session
        const session = this.sessions.get(ip);
        if (session) {
          session.socketCount = sockets.size;
          console.log(`📊 SESSION: IP ${ip} still has ${session.socketCount} sockets`);
        }
      }
    }
    
    // Remove socket to IP mapping
    this.socketToIp.delete(socketId);
    
    // Remove socket to user ID mapping
    this.socketToUserId.delete(socketId);
    
    return ip;
  }

  /**
   * Get session by socket ID
   */
  getSessionBySocketId(socketId) {
    const ip = this.socketToIp.get(socketId);
    if (!ip) return null;
    
    const session = this.sessions.get(ip);
    if (!session) return null;
    
    // Create a copy of the session with the correct user ID for this specific socket
    const socketUserId = this.socketToUserId.get(socketId);
    if (socketUserId !== undefined) {
      // Return session with socket-specific user ID (handles multiple users on same IP)
      return {
        ...session,
        userId: socketUserId
      };
    }
    
    // Fallback to IP-based user ID
    return session;
  }

  /**
   * Get session by IP
   */
  getSessionByIp(ip) {
    return this.sessions.get(ip);
  }

  /**
   * Set chat username for an IP
   */
  setChatUsername(ip, username, color) {
    const session = this.sessions.get(ip);
    if (session) {
      session.chatUsername = username;
      session.chatColor = color;
      this.ipToUsername.set(ip, { username, color });
      console.log(`📊 SESSION: Set chat username for IP ${ip}: ${username} (${color})`);
    }
    return session;
  }

  /**
   * Get chat username for an IP
   */
  getChatUsername(ip) {
    return this.ipToUsername.get(ip);
  }

  /**
   * Set streaming status for an IP
   */
  setStreamingStatus(ip, isStreaming) {
    const session = this.sessions.get(ip);
    if (session) {
      session.isStreaming = isStreaming;
      console.log(`📊 SESSION: IP ${ip} streaming status: ${isStreaming}`);
    }
    return session;
  }

  /**
   * Get unique viewer count
   */
  getUniqueViewerCount() {
    return this.uniqueViewers.size;
  }

  /**
   * Get all active sessions
   */
  getActiveSessions() {
    const active = [];
    for (const [ip, session] of this.sessions.entries()) {
      if (session.socketCount > 0) {
        active.push({
          ip: ip,
          ...session
        });
      }
    }
    return active;
  }

  /**
   * Get all sessions formatted for admin panel
   */
  getAllSessions() {
    const sessions = [];
    for (const [ip, session] of this.sessions.entries()) {
      // Get all socket IDs for this IP
      const socketIds = this.getSocketsForIp(ip);
      
      // Create session entries for each socket
      socketIds.forEach(socketId => {
        // Get user ID for this specific socket (or fall back to IP-based user ID)
        const socketUserId = this.socketToUserId.get(socketId);
        const userId = socketUserId || session.userId || null;
        
        sessions.push({
          socketId: socketId,
          ipAddress: ip,
          userAgent: session.chatUsername || 'N/A',
          connectedAt: new Date(session.firstSeen).getTime(),
          lastSeen: new Date(session.lastSeen).getTime(),
          isActive: session.socketCount > 0,
          connectionCount: session.socketCount,
          totalConnections: session.socketCount,
          userId: userId,
          chatUsername: session.chatUsername,
          chatColor: session.chatColor,
          stats: session.stats || {}
        });
      });
    }
    return sessions;
  }

  /**
   * Check if IP is currently viewing
   */
  isViewing(ip) {
    return this.uniqueViewers.has(ip);
  }

  /**
   * Get all socket IDs for an IP
   */
  getSocketsForIp(ip) {
    const sockets = this.ipToSockets.get(ip);
    return sockets ? Array.from(sockets) : [];
  }

  /**
   * Clear all sessions (for server shutdown)
   */
  clearAllSessions() {
    console.log('📊 SESSION: Clearing all sessions...');
    this.sessions.clear();
    this.socketToIp.clear();
    this.ipToSockets.clear();
    this.ipToUsername.clear();
    this.uniqueViewers.clear();
    this.ipToUserId.clear();
    this.socketToUserId.clear();
    console.log('✅ SESSION: All sessions cleared');
  }

  /**
   * Clean up old sessions (optional maintenance)
   */
  cleanupOldSessions(maxAgeHours = 24) {
    const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
    let cleaned = 0;
    
    for (const [ip, session] of this.sessions.entries()) {
      if (session.socketCount === 0 && new Date(session.lastSeen) < cutoff) {
        this.sessions.delete(ip);
        this.ipToUsername.delete(ip);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      console.log(`📊 SESSION: Cleaned up ${cleaned} old sessions`);
    }
    
    return cleaned;
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      totalSessions: this.sessions.size,
      uniqueViewers: this.uniqueViewers.size,
      totalSockets: this.socketToIp.size,
      activeSessions: this.getActiveSessions().length,
      ipToSockets: Array.from(this.ipToSockets.entries()).map(([ip, sockets]) => ({
        ip,
        socketCount: sockets.size
      }))
    };
  }

  /**
   * Link a user ID to an IP address session
   */
  linkUserToSession(ip, userId) {
    if (userId === null) {
      this.ipToUserId.delete(ip);
    } else {
      this.ipToUserId.set(ip, userId);
    }
    const session = this.sessions.get(ip);
    if (session) {
      session.userId = userId;
      if (userId === null) {
        console.log(`📊 SESSION: Cleared user ID for IP ${ip} (now anonymous)`);
      } else {
        console.log(`📊 SESSION: Linked user ${userId} to IP ${ip}`);
      }
    }
    return session;
  }

  /**
   * Link a user ID to a specific socket ID (for handling multiple users on same IP)
   */
  linkUserToSocket(socketId, userId) {
    if (userId === null || userId === undefined) {
      this.socketToUserId.delete(socketId);
      console.log(`📊 SESSION: Cleared user ID for socket ${socketId} (now anonymous)`);
    } else {
      this.socketToUserId.set(socketId, userId);
      console.log(`📊 SESSION: Linked user ${userId} to socket ${socketId}`);
    }
  }

  /**
   * Get user ID for a specific socket ID (preferred over IP-based lookup when dealing with multiple users on same IP)
   */
  getUserIdBySocketId(socketId) {
    return this.socketToUserId.get(socketId);
  }

  /**
   * Get all socket IDs for a given IP address
   */
  getSocketsByIp(ip) {
    const sockets = this.ipToSockets.get(ip);
    return sockets ? Array.from(sockets) : [];
  }

  /**
   * Update session stats
   */
  updateSessionStats(ip, statsUpdate) {
    const session = this.sessions.get(ip);
    if (session && session.stats) {
      Object.assign(session.stats, statsUpdate);
      console.log(`📊 SESSION: Updated stats for IP ${ip}:`, statsUpdate);
    }
    return session;
  }

  /**
   * Increment chat message count for an IP
   */
  incrementChatMessageCount(ip) {
    const session = this.sessions.get(ip);
    if (session && session.stats) {
      session.stats.chatMessageCount++;
    }
    return session;
  }

  /**
   * Get user ID for an IP
   */
  getUserIdForIp(ip) {
    return this.ipToUserId.get(ip);
  }

  /**
   * Get all socket IDs for a specific user ID
   */
  getSocketsByUserId(userId) {
    const socketIds = [];
    
    console.log(`🔍 SESSION: Looking for sockets for user ${userId}`);
    console.log(`🔍 SESSION: Current IP to User mappings:`, Object.fromEntries(this.ipToUserId));
    console.log(`🔍 SESSION: Current Socket to User mappings:`, Object.fromEntries(this.socketToUserId));
    
    // First, find sockets directly mapped to this user ID (preferred method)
    for (const [socketId, mappedUserId] of this.socketToUserId.entries()) {
      if (mappedUserId === userId) {
        socketIds.push(socketId);
        console.log(`🔍 SESSION: Found socket ${socketId} directly mapped to user ${userId}`);
      }
    }
    
    // Also check IP-based mappings for backward compatibility (in case some sockets aren't individually mapped)
    for (const [ip, mappedUserId] of this.ipToUserId.entries()) {
      if (mappedUserId === userId) {
        // Get all sockets for this IP
        const ipSockets = this.getSocketsByIp(ip);
        for (const socketId of ipSockets) {
          // Only add if not already added through direct socket mapping
          if (!socketIds.includes(socketId)) {
            // Double check: if this socket has its own user mapping and it's different, skip it
            const socketSpecificUserId = this.socketToUserId.get(socketId);
            if (socketSpecificUserId === undefined || socketSpecificUserId === userId) {
              socketIds.push(socketId);
              console.log(`🔍 SESSION: Found socket ${socketId} via IP ${ip} mapping for user ${userId}`);
            }
          }
        }
      }
    }
    
    console.log(`🔍 SESSION: Total sockets found for user ${userId}: [${socketIds.join(', ')}]`);
    return socketIds;
  }
}

module.exports = SessionService;