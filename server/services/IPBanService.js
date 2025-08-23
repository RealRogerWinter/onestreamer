const { db, runAsync, getAsync, allAsync } = require('../database/database');

class IPBanService {
  constructor() {
    this.bannedIPs = new Set();
    this.loadBannedIPs();
  }

  async loadBannedIPs() {
    try {
      const query = `
        SELECT ip_address 
        FROM ip_bans 
        WHERE permanent = 1 
           OR expires_at > datetime('now')
      `;
      const bans = await allAsync(query);
      this.bannedIPs.clear();
      bans.forEach(ban => this.bannedIPs.add(ban.ip_address));
      console.log(`🚫 Loaded ${this.bannedIPs.size} banned IPs`);
    } catch (error) {
      console.error('❌ Failed to load banned IPs:', error);
    }
  }

  async isIPBanned(ip) {
    // Quick check from memory cache
    if (this.bannedIPs.has(ip)) {
      return true;
    }

    // Double-check database for recent bans or expired bans
    try {
      const query = `
        SELECT COUNT(*) as count 
        FROM ip_bans 
        WHERE ip_address = ? 
          AND (permanent = 1 OR expires_at > datetime('now'))
      `;
      const result = await getAsync(query, [ip]);
      const isBanned = result.count > 0;
      
      if (isBanned && !this.bannedIPs.has(ip)) {
        this.bannedIPs.add(ip);
      } else if (!isBanned && this.bannedIPs.has(ip)) {
        this.bannedIPs.delete(ip);
      }
      
      return isBanned;
    } catch (error) {
      console.error('❌ Failed to check IP ban:', error);
      return false;
    }
  }

  async banIP(ip, bannedByUserId, bannedByUsername, reason = 'Stream moderation', permanent = true, expiresAt = null) {
    try {
      const query = `
        INSERT OR REPLACE INTO ip_bans 
        (ip_address, banned_by_user_id, banned_by_username, reason, permanent, expires_at) 
        VALUES (?, ?, ?, ?, ?, ?)
      `;
      
      await runAsync(query, [ip, bannedByUserId, bannedByUsername, reason, permanent ? 1 : 0, expiresAt]);
      
      // Update cache
      this.bannedIPs.add(ip);
      
      console.log(`🚫 IP banned: ${ip} by ${bannedByUsername} - Reason: ${reason}`);
      return { success: true, ip, reason };
    } catch (error) {
      console.error('❌ Failed to ban IP:', error);
      return { success: false, error: error.message };
    }
  }

  async unbanIP(ip) {
    try {
      const query = `DELETE FROM ip_bans WHERE ip_address = ?`;
      await runAsync(query, [ip]);
      
      // Update cache
      this.bannedIPs.delete(ip);
      
      console.log(`✅ IP unbanned: ${ip}`);
      return { success: true, ip };
    } catch (error) {
      console.error('❌ Failed to unban IP:', error);
      return { success: false, error: error.message };
    }
  }

  async getBannedIPs() {
    try {
      const query = `
        SELECT 
          ip_address,
          banned_by_username,
          banned_at,
          reason,
          permanent,
          expires_at
        FROM ip_bans
        WHERE (permanent = 1 OR expires_at > datetime('now'))
        AND ip_address NOT IN ('127.0.0.1', '::1', 'localhost')
        ORDER BY banned_at DESC
      `;
      const bans = await allAsync(query);
      return bans;
    } catch (error) {
      console.error('❌ Failed to get banned IPs:', error);
      return [];
    }
  }

  async cleanupExpiredBans() {
    try {
      const query = `
        DELETE FROM ip_bans 
        WHERE permanent = 0 AND expires_at <= datetime('now')
      `;
      const result = await runAsync(query);
      
      // Reload cache
      await this.loadBannedIPs();
      
      console.log(`🧹 Cleaned up expired IP bans`);
      return { success: true };
    } catch (error) {
      console.error('❌ Failed to cleanup expired bans:', error);
      return { success: false, error: error.message };
    }
  }

  getIPFromSocket(socket) {
    // Try multiple methods to get the real IP
    let ip = socket.handshake.address;
    
    // Check for proxied IPs
    if (socket.handshake.headers['x-forwarded-for']) {
      ip = socket.handshake.headers['x-forwarded-for'].split(',')[0].trim();
    } else if (socket.handshake.headers['x-real-ip']) {
      ip = socket.handshake.headers['x-real-ip'];
    }
    
    // Clean up IPv6 localhost to IPv4
    if (ip === '::1' || ip === '::ffff:127.0.0.1') {
      ip = '127.0.0.1';
    }
    
    // Remove IPv6 prefix if present
    if (ip.startsWith('::ffff:')) {
      ip = ip.substring(7);
    }
    
    return ip;
  }
}

// Create singleton instance
const ipBanService = new IPBanService();

// Schedule periodic cleanup of expired bans
setInterval(() => {
  ipBanService.cleanupExpiredBans();
}, 60 * 60 * 1000); // Every hour

module.exports = ipBanService;