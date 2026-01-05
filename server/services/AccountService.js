const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { db, runAsync, getAsync, allAsync } = require('../database/database');

class AccountService {
    constructor() {
        this.saltRounds = 10;
        this.db = db; // Add database reference for raw queries
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
            `SELECT id, email, username, created_at, updated_at, last_login, is_verified, is_admin, is_moderator, is_banned, oauth_provider, username_changed, avatar_url, description 
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
            `SELECT id, email, username, password, created_at, updated_at, last_login, is_verified, is_admin, is_moderator, is_banned, oauth_provider, username_changed, avatar_url, description FROM users WHERE username = ?`,
            [username]
        );
    }

    async getUserByOAuth(provider, oauthId) {
        return await getAsync(
            `SELECT * FROM users WHERE oauth_provider = ? AND oauth_id = ?`,
            [provider, oauthId]
        );
    }

    async verifyPassword(emailOrUsername, password) {
        console.log('🔍 Verifying password for:', emailOrUsername);
        // Try to find user by email first
        let user = await this.getUserByEmail(emailOrUsername);
        
        // If not found by email, try username
        if (!user) {
            console.log('🔍 Not found by email, trying username...');
            user = await this.getUserByUsername(emailOrUsername);
        }
        
        if (!user || !user.password) {
            console.log('❌ User not found or no password set');
            return null;
        }
        console.log('🔍 Found user:', user.email, 'verifying password...');
        const isValid = await bcrypt.compare(password, user.password);
        console.log('🔍 Password valid:', isValid);
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

    async linkOAuthToUser(userId, oauthProvider, oauthId) {
        await runAsync(
            `UPDATE users SET oauth_provider = ?, oauth_id = ? WHERE id = ?`,
            [oauthProvider, oauthId, userId]
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

        return { success: true, userId: user.id };
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

    async regenerateVerificationToken(userId) {
        const newVerificationToken = crypto.randomBytes(32).toString('hex');
        
        await runAsync(
            `UPDATE users SET verification_token = ? WHERE id = ?`,
            [newVerificationToken, userId]
        );
        
        return newVerificationToken;
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

    async changeUsername(userId, newUsername) {
        // Check if user exists and get their current info
        const user = await this.getUserById(userId);
        if (!user) {
            throw new Error('User not found');
        }

        // Check if they've already changed their username
        if (user.username_changed === 1 || user.username_changed === true) {
            throw new Error('Username can only be changed once');
        }

        // Check if user signed up via OAuth (they get one username change)
        if (!user.oauth_provider) {
            throw new Error('Username change is only available for OAuth users');
        }

        // Validate username format
        if (!newUsername || newUsername.length < 3 || newUsername.length > 20) {
            throw new Error('Username must be between 3 and 20 characters');
        }

        if (!/^[a-zA-Z0-9_]+$/.test(newUsername)) {
            throw new Error('Username can only contain letters, numbers, and underscores');
        }

        // Check if new username is already taken
        const existingUser = await this.getUserByUsername(newUsername);
        if (existingUser && existingUser.id !== userId) {
            throw new Error('Username already taken');
        }

        // Update username and mark as changed
        await runAsync(
            `UPDATE users 
             SET username = ?, username_changed = 1, updated_at = CURRENT_TIMESTAMP 
             WHERE id = ?`,
            [newUsername, userId]
        );

        return {
            success: true,
            username: newUsername
        };
    }

    async canChangeUsername(userId) {
        const user = await this.getUserById(userId);
        if (!user) {
            return false;
        }
        
        // User can change username if:
        // 1. They signed up via OAuth
        // 2. They haven't changed it yet
        return user.oauth_provider && (user.username_changed === 0 || user.username_changed === false || user.username_changed === null);
    }

    // Account deletion methods
    async requestDeletion(userId, deletionToken, tokenExpires) {
        return new Promise((resolve, reject) => {
            const now = new Date().toISOString();
            const scheduledFor = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(); // 15 days from now
            
            const query = `
                UPDATE users 
                SET deletion_requested_at = ?,
                    deletion_token = ?,
                    deletion_token_expires = ?,
                    deletion_scheduled_for = ?,
                    account_status = 'pending_deletion'
                WHERE id = ?
            `;
            
            this.db.run(query, [now, deletionToken, tokenExpires.toISOString(), scheduledFor, userId], async (err) => {
                if (err) {
                    reject(err);
                } else {
                    // Log the deletion request
                    await this.logDeletionAction(userId, 'deletion_requested');
                    resolve(true);
                }
            });
        });
    }

    async confirmDeletion(token) {
        return new Promise((resolve, reject) => {
            // First, find the user with this token
            const query = `
                SELECT * FROM users 
                WHERE deletion_token = ? 
                AND deletion_token_expires > datetime('now')
                AND account_status = 'pending_deletion'
            `;
            
            this.db.get(query, [token], (err, user) => {
                if (err) {
                    resolve({ success: false, error: 'Database error' });
                } else if (!user) {
                    resolve({ success: false, error: 'Invalid or expired deletion token' });
                } else {
                    // Update the confirmation timestamp
                    const updateQuery = `
                        UPDATE users 
                        SET deletion_confirmed_at = datetime('now')
                        WHERE id = ?
                    `;
                    
                    this.db.run(updateQuery, [user.id], async (updateErr) => {
                        if (updateErr) {
                            resolve({ success: false, error: 'Failed to confirm deletion' });
                        } else {
                            // Log the confirmation
                            await this.logDeletionAction(user.id, 'deletion_confirmed');
                            resolve({ success: true, userId: user.id });
                        }
                    });
                }
            });
        });
    }

    async restoreAccount(userId) {
        return new Promise((resolve, reject) => {
            const query = `
                UPDATE users 
                SET deletion_requested_at = NULL,
                    deletion_confirmed_at = NULL,
                    deletion_scheduled_for = NULL,
                    deletion_token = NULL,
                    deletion_token_expires = NULL,
                    account_status = 'active'
                WHERE id = ? AND account_status = 'pending_deletion'
            `;
            
            const self = this; // Store reference to AccountService instance
            this.db.run(query, [userId], async function(err) {
                if (err) {
                    reject(err);
                } else if (this.changes === 0) {
                    resolve(false); // No rows updated
                } else {
                    // Log the restoration
                    await self.logDeletionAction(userId, 'account_restored');
                    resolve(true);
                }
            });
        });
    }

    async logDeletionAction(userId, action, ipAddress = null, userAgent = null) {
        return new Promise((resolve, reject) => {
            // First get user info for logging
            this.getUserById(userId).then(user => {
                if (!user) {
                    resolve(false);
                    return;
                }
                
                const query = `
                    INSERT INTO account_deletion_logs 
                    (user_id, username, email, action, ip_address, user_agent, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
                `;
                
                this.db.run(query, [userId, user.username, user.email, action, ipAddress, userAgent], (err) => {
                    if (err) {
                        console.error('Failed to log deletion action:', err);
                        resolve(false);
                    } else {
                        resolve(true);
                    }
                });
            });
        });
    }

    async getAccountsPendingDeletion() {
        return new Promise((resolve, reject) => {
            const query = `
                SELECT * FROM users 
                WHERE account_status = 'pending_deletion' 
                AND deletion_confirmed_at IS NOT NULL
                AND deletion_scheduled_for <= datetime('now')
            `;
            
            this.db.all(query, [], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows || []);
                }
            });
        });
    }

    async permanentlyDeleteAccount(userId) {
        return new Promise(async (resolve, reject) => {
            try {
                // Log the permanent deletion
                await this.logDeletionAction(userId, 'data_purged');
                
                // Delete user data from all related tables
                const tables = [
                    'user_sessions',
                    'user_stats',
                    'ip_to_user_transfers',
                    'user_inventory',
                    'item_usage_history',
                    'user_points_log',
                    'account_deletion_logs'
                ];
                
                for (const table of tables) {
                    await new Promise((res, rej) => {
                        this.db.run(`DELETE FROM ${table} WHERE user_id = ?`, [userId], (err) => {
                            if (err) rej(err);
                            else res(true);
                        });
                    });
                }
                
                // Finally, mark the user as deleted (keep record for audit)
                const updateQuery = `
                    UPDATE users 
                    SET account_status = 'deleted',
                        email = 'deleted_' || id || '@deleted.com',
                        username = 'deleted_user_' || id,
                        password = NULL,
                        oauth_id = NULL,
                        verification_token = NULL,
                        reset_token = NULL,
                        deletion_token = NULL
                    WHERE id = ?
                `;
                
                this.db.run(updateQuery, [userId], (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(true);
                    }
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    async verifyUserPassword(userId, password) {
        try {
            console.log('Verifying password for user:', userId);
            const user = await getAsync(
                `SELECT password FROM users WHERE id = ?`,
                [userId]
            );
            
            if (!user || !user.password) {
                console.log('User not found or no password set for user:', userId);
                return false;
            }
            
            const isValid = await bcrypt.compare(password, user.password);
            console.log('Password comparison result for user', userId, ':', isValid);
            return isValid;
        } catch (error) {
            console.error('Error verifying user password:', error);
            return false;
        }
    }

    async changePassword(userId, newPassword) {
        try {
            console.log('Changing password for user:', userId);
            const hashedPassword = await bcrypt.hash(newPassword, this.saltRounds);
            console.log('Password hashed successfully');
            
            const result = await runAsync(
                `UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [hashedPassword, userId]
            );
            console.log('Database update result:', result);
            
            return true;
        } catch (error) {
            console.error('Error changing password:', error);
            throw new Error('Failed to change password');
        }
    }

    async updateProfile(userId, profileData) {
        try {
            const { bio, website, location, displayName, avatar_url, description } = profileData;
            
            // Build update query dynamically based on provided fields
            const updateFields = [];
            const values = [];
            
            if (bio !== undefined) {
                updateFields.push('bio = ?');
                values.push(bio);
            }
            
            if (website !== undefined) {
                updateFields.push('website = ?');
                values.push(website);
            }
            
            if (location !== undefined) {
                updateFields.push('location = ?');
                values.push(location);
            }
            
            if (displayName !== undefined) {
                updateFields.push('display_name = ?');
                values.push(displayName);
            }
            
            if (avatar_url !== undefined) {
                updateFields.push('avatar_url = ?');
                values.push(avatar_url);
            }
            
            if (description !== undefined) {
                updateFields.push('description = ?');
                values.push(description);
            }
            
            if (updateFields.length === 0) {
                // No fields to update
                return await this.getUserProfile(userId);
            }
            
            // Add updated_at field
            updateFields.push('updated_at = CURRENT_TIMESTAMP');
            
            // Add userId for WHERE clause
            values.push(userId);
            
            const updateQuery = `UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`;
            
            await runAsync(updateQuery, values);
            
            // Return the updated profile
            return await this.getUserProfile(userId);
        } catch (error) {
            console.error('Error updating user profile:', error);
            throw new Error('Failed to update user profile');
        }
    }

    async getUserProfile(userId) {
        try {
            const user = await getAsync(
                `SELECT id, email, username, bio, website, location, display_name, 
                        created_at, updated_at, is_verified, is_admin, is_moderator 
                 FROM users WHERE id = ?`,
                [userId]
            );
            
            if (!user) {
                throw new Error('User not found');
            }
            
            return {
                id: user.id,
                email: user.email,
                username: user.username,
                bio: user.bio,
                website: user.website,
                location: user.location,
                displayName: user.display_name || user.username,
                createdAt: user.created_at,
                updatedAt: user.updated_at,
                isVerified: user.is_verified,
                isAdmin: user.is_admin,
                isModerator: user.is_moderator
            };
        } catch (error) {
            console.error('Error getting user profile:', error);
            throw error;
        }
    }
}

module.exports = AccountService;