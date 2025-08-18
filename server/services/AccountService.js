const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { runAsync, getAsync, allAsync } = require('../database/database');

class AccountService {
    constructor() {
        this.saltRounds = 10;
    }

    async createUser(email, username, password, oauthProvider = null, oauthId = null) {
        try {
            let hashedPassword = null;
            if (password) {
                hashedPassword = await bcrypt.hash(password, this.saltRounds);
            }

            const verificationToken = crypto.randomBytes(32).toString('hex');

            const result = await runAsync(
                `INSERT INTO users (email, username, password, oauth_provider, oauth_id, verification_token) 
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [email, username, hashedPassword, oauthProvider, oauthId, verificationToken]
            );

            await this.createUserStats(result.id);

            return {
                id: result.id,
                email,
                username,
                verificationToken
            };
        } catch (error) {
            if (error.message.includes('UNIQUE constraint failed')) {
                if (error.message.includes('email')) {
                    throw new Error('Email already exists');
                } else if (error.message.includes('username')) {
                    throw new Error('Username already exists');
                }
            }
            throw error;
        }
    }

    async createUserStats(userId) {
        await runAsync(
            `INSERT INTO user_stats (user_id) VALUES (?)`,
            [userId]
        );
    }

    async getUserById(id) {
        return await getAsync(
            `SELECT id, email, username, created_at, updated_at, last_login, is_verified, is_admin, is_banned 
             FROM users WHERE id = ?`,
            [id]
        );
    }

    async getUserByEmail(email) {
        return await getAsync(
            `SELECT * FROM users WHERE email = ?`,
            [email]
        );
    }

    async getUserByUsername(username) {
        return await getAsync(
            `SELECT * FROM users WHERE username = ?`,
            [username]
        );
    }

    async getUserByOAuth(provider, oauthId) {
        return await getAsync(
            `SELECT * FROM users WHERE oauth_provider = ? AND oauth_id = ?`,
            [provider, oauthId]
        );
    }

    async verifyPassword(email, password) {
        const user = await this.getUserByEmail(email);
        if (!user || !user.password) {
            return null;
        }

        const isValid = await bcrypt.compare(password, user.password);
        if (!isValid) {
            return null;
        }

        await this.updateLastLogin(user.id);
        
        const { password: _, ...userWithoutPassword } = user;
        return userWithoutPassword;
    }

    async updateLastLogin(userId) {
        await runAsync(
            `UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?`,
            [userId]
        );
    }

    async verifyUser(verificationToken) {
        const user = await getAsync(
            `SELECT id FROM users WHERE verification_token = ?`,
            [verificationToken]
        );

        if (!user) {
            throw new Error('Invalid verification token');
        }

        await runAsync(
            `UPDATE users SET is_verified = 1, verification_token = NULL WHERE id = ?`,
            [user.id]
        );

        return true;
    }

    async createPasswordResetToken(email) {
        const user = await this.getUserByEmail(email);
        if (!user) {
            return null;
        }

        const resetToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 3600000);

        await runAsync(
            `UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?`,
            [resetToken, expiresAt.toISOString(), user.id]
        );

        return resetToken;
    }

    async resetPassword(resetToken, newPassword) {
        const user = await getAsync(
            `SELECT id, reset_token_expires FROM users 
             WHERE reset_token = ? AND reset_token_expires > datetime('now')`,
            [resetToken]
        );

        if (!user) {
            throw new Error('Invalid or expired reset token');
        }

        const hashedPassword = await bcrypt.hash(newPassword, this.saltRounds);

        await runAsync(
            `UPDATE users SET password = ?, reset_token = NULL, reset_token_expires = NULL 
             WHERE id = ?`,
            [hashedPassword, user.id]
        );

        return true;
    }

    async updateUserStats(userId, stats) {
        const updateFields = [];
        const values = [];

        if (stats.streamTime !== undefined) {
            updateFields.push('total_stream_time = total_stream_time + ?');
            values.push(stats.streamTime);
        }

        if (stats.viewTime !== undefined) {
            updateFields.push('total_view_time = total_view_time + ?');
            values.push(stats.viewTime);
        }

        if (stats.streamCount !== undefined) {
            updateFields.push('stream_count = stream_count + ?');
            values.push(stats.streamCount);
        }

        if (stats.chatMessageCount !== undefined) {
            updateFields.push('chat_message_count = chat_message_count + ?');
            values.push(stats.chatMessageCount);
        }

        if (stats.lastStreamAt !== undefined) {
            updateFields.push('last_stream_at = ?');
            values.push(stats.lastStreamAt);
        }

        if (updateFields.length === 0) {
            return;
        }

        updateFields.push('updated_at = CURRENT_TIMESTAMP');
        values.push(userId);

        const sql = `UPDATE user_stats SET ${updateFields.join(', ')} WHERE user_id = ?`;
        await runAsync(sql, values);
        
        // Points are now managed independently through addPoints/subtractPoints
        // No need to recalculate here
    }

    async getUserStats(userId) {
        return await getAsync(
            `SELECT * FROM user_stats WHERE user_id = ?`,
            [userId]
        );
    }

    // ==================== NEW POINTS SYSTEM METHODS ====================
    
    /**
     * Add points to user's balance
     * @param {number} userId - User ID
     * @param {number} amount - Amount to add (must be positive)
     * @param {string} type - Transaction type (streaming, viewing, chat, bonus, etc)
     * @param {string} description - Human-readable description
     * @param {object} metadata - Optional metadata for the transaction
     * @returns {number} New balance
     */
    async addPoints(userId, amount, type, description, metadata = null) {
        if (amount <= 0) {
            throw new Error('Amount must be positive');
        }
        
        // Get current balance
        const stats = await this.getUserStats(userId);
        if (!stats) {
            // Create stats record if doesn't exist
            await runAsync(
                `INSERT INTO user_stats (user_id, points_balance) VALUES (?, ?)`,
                [userId, 0]
            );
        }
        
        const currentBalance = stats?.points_balance || 0;
        const newBalance = currentBalance + amount;
        
        // Update balance
        await runAsync(
            'UPDATE user_stats SET points_balance = ? WHERE user_id = ?',
            [newBalance, userId]
        );
        
        // Record transaction
        await this.recordTransaction(userId, amount, newBalance, type, description, metadata);
        
        console.log(`💰 Added ${amount} points to user ${userId} (${type}). New balance: ${newBalance}`);
        return newBalance;
    }
    
    /**
     * Subtract points from user's balance
     * @param {number} userId - User ID
     * @param {number} amount - Amount to subtract (must be positive)
     * @param {string} type - Transaction type (purchase, penalty, etc)
     * @param {string} description - Human-readable description
     * @param {object} metadata - Optional metadata for the transaction
     * @returns {number} New balance
     */
    async subtractPoints(userId, amount, type, description, metadata = null) {
        if (amount <= 0) {
            throw new Error('Amount must be positive');
        }
        
        // Get current balance
        const stats = await this.getUserStats(userId);
        const currentBalance = stats?.points_balance || 0;
        
        if (currentBalance < amount) {
            throw new Error(`Insufficient points balance. Has: ${currentBalance}, Needs: ${amount}`);
        }
        
        const newBalance = currentBalance - amount;
        
        // Update balance
        await runAsync(
            'UPDATE user_stats SET points_balance = ? WHERE user_id = ?',
            [newBalance, userId]
        );
        
        // Record transaction (negative amount)
        await this.recordTransaction(userId, -amount, newBalance, type, description, metadata);
        
        console.log(`💸 Subtracted ${amount} points from user ${userId} (${type}). New balance: ${newBalance}`);
        return newBalance;
    }
    
    /**
     * Get user's current points balance
     * @param {number} userId - User ID
     * @returns {number} Current balance
     */
    async getPointsBalance(userId) {
        const stats = await this.getUserStats(userId);
        return stats?.points_balance || 0;
    }
    
    /**
     * Record a points transaction
     */
    async recordTransaction(userId, amount, balanceAfter, type, description, metadata = null) {
        await runAsync(
            `INSERT INTO points_transactions 
             (user_id, amount, balance_after, type, description, metadata)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, amount, balanceAfter, type, description, 
             metadata ? JSON.stringify(metadata) : null]
        );
    }
    
    /**
     * Get transaction history for a user
     * @param {number} userId - User ID
     * @param {number} limit - Number of transactions to return
     * @returns {Array} Transaction history
     */
    async getTransactionHistory(userId, limit = 50) {
        return await allAsync(
            `SELECT * FROM points_transactions 
             WHERE user_id = ? 
             ORDER BY created_at DESC 
             LIMIT ?`,
            [userId, limit]
        );
    }

    async transferIPSessionToUser(userId, ipAddress, sessionData) {
        await runAsync(
            `INSERT INTO ip_to_user_transfers (user_id, ip_address, session_data) 
             VALUES (?, ?, ?)`,
            [userId, ipAddress, JSON.stringify(sessionData)]
        );

        if (sessionData.stats) {
            await this.updateUserStats(userId, sessionData.stats);
        }
    }

    async createSession(userId, ipAddress, expiresIn = 86400000) {
        const expiresAt = new Date(Date.now() + expiresIn);
        
        const result = await runAsync(
            `INSERT INTO user_sessions (user_id, ip_address, expires_at) 
             VALUES (?, ?, ?)`,
            [userId, ipAddress, expiresAt.toISOString()]
        );

        return result.id;
    }

    async getSessionByUserId(userId) {
        return await getAsync(
            `SELECT * FROM user_sessions 
             WHERE user_id = ? AND expires_at > datetime('now') 
             ORDER BY created_at DESC LIMIT 1`,
            [userId]
        );
    }

    async deleteSession(sessionId) {
        await runAsync(
            `DELETE FROM user_sessions WHERE id = ?`,
            [sessionId]
        );
    }

    async cleanupExpiredSessions() {
        await runAsync(
            `DELETE FROM user_sessions WHERE expires_at < datetime('now')`
        );
    }

    async promoteToAdmin(userId) {
        await runAsync(
            `UPDATE users SET is_admin = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [userId]
        );
    }

    async demoteFromAdmin(userId) {
        await runAsync(
            `UPDATE users SET is_admin = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [userId]
        );
    }

    async banUser(userId) {
        await runAsync(
            `UPDATE users SET is_banned = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [userId]
        );
    }

    async unbanUser(userId) {
        await runAsync(
            `UPDATE users SET is_banned = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [userId]
        );
    }

    async deleteUser(userId) {
        // First delete user stats
        await runAsync(`DELETE FROM user_stats WHERE user_id = ?`, [userId]);
        
        // Then delete user sessions
        await runAsync(`DELETE FROM user_sessions WHERE user_id = ?`, [userId]);
        
        // Finally delete the user
        await runAsync(`DELETE FROM users WHERE id = ?`, [userId]);
    }

    async searchUsers(searchTerm, limit = 50) {
        const searchPattern = `%${searchTerm}%`;
        return await allAsync(
            `SELECT id, email, username, created_at, last_login, is_verified, is_admin, is_banned
             FROM users 
             WHERE email LIKE ? OR username LIKE ?
             ORDER BY created_at DESC
             LIMIT ?`,
            [searchPattern, searchPattern, limit]
        );
    }

    async getAllUsers(limit = 100) {
        return await allAsync(
            `SELECT id, email, username, created_at, last_login, is_verified, is_admin, is_banned
             FROM users 
             ORDER BY created_at DESC
             LIMIT ?`,
            [limit]
        );
    }
}

module.exports = AccountService;