const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { db, runAsync, getAsync, allAsync } = require('../database/database');
const UserRepository = require('../database/repository/UserRepository');
const AccountStatsRepository = require('../database/repository/AccountStatsRepository');
const UserSessionRepository = require('../database/repository/UserSessionRepository');

const logger = require('../bootstrap/logger').child({ svc: 'AccountService' });
class AccountService {
    /**
     * @param {object} [deps]
     * @param {UserRepository} [deps.userRepository] - inject a custom repo
     *   (useful for tests). Defaults to a fresh `UserRepository()` so the
     *   `new AccountService()` callsites scattered throughout the codebase
     *   continue to work unchanged.
     * @param {AccountStatsRepository} [deps.accountStatsRepository]
     * @param {UserSessionRepository} [deps.userSessionRepository]
     */
    constructor({ userRepository, accountStatsRepository, userSessionRepository } = {}) {
        this.saltRounds = 10;
        this.db = db; // Add database reference for raw queries
        this.userRepository = userRepository || new UserRepository({ getAsync, runAsync, allAsync });
        // PR 10.3 (Phase 10): user-economy + session/lifecycle SQL
        // collapses to two sibling repos. Both accept the same
        // dep-injection shape as UserRepository so the test surface
        // stays uniform.
        this.accountStatsRepository = accountStatsRepository
            || new AccountStatsRepository({ getAsync, runAsync, allAsync });
        this.userSessionRepository = userSessionRepository
            || new UserSessionRepository({ getAsync, runAsync, allAsync });
    }

    async createUser(email, username, password, oauthProvider = null, oauthId = null) {
        try {
            let hashedPassword = null;
            if (password) {
                hashedPassword = await bcrypt.hash(password, this.saltRounds);
            }

            const verificationToken = crypto.randomBytes(32).toString('hex');

            const result = await this.userRepository.create({
                email,
                username,
                password: hashedPassword,
                oauthProvider,
                oauthId,
                verificationToken
            });

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
        await this.accountStatsRepository.insertEmptyStats(userId);
    }

    async getUserById(id) {
        return await this.userRepository.getSafeById(id);
    }

    async getUserByEmail(email) {
        return await this.userRepository.getByEmail(email);
    }

    async getUserByUsername(username) {
        return await this.userRepository.getByUsername(username);
    }

    async getUserByOAuth(provider, oauthId) {
        return await this.userRepository.getByOAuth(provider, oauthId);
    }

    async verifyPassword(emailOrUsername, password) {
        logger.debug('🔍 Verifying password for:', emailOrUsername);
        // Try to find user by email first
        let user = await this.getUserByEmail(emailOrUsername);
        
        // If not found by email, try username
        if (!user) {
            logger.debug('🔍 Not found by email, trying username...');
            user = await this.getUserByUsername(emailOrUsername);
        }
        
        if (!user || !user.password) {
            logger.debug('❌ User not found or no password set');
            return null;
        }
        logger.debug('🔍 Found user:', user.email, 'verifying password...');
        const isValid = await bcrypt.compare(password, user.password);
        logger.debug('🔍 Password valid:', isValid);
        if (!isValid) {
            return null;
        }

        await this.updateLastLogin(user.id);
        
        const { password: _, ...userWithoutPassword } = user;
        return userWithoutPassword;
    }

    async updateLastLogin(userId) {
        await this.userRepository.updateLastLogin(userId);
    }

    async linkOAuthToUser(userId, oauthProvider, oauthId) {
        await this.userRepository.linkOAuth(userId, oauthProvider, oauthId);
    }

    async verifyUser(verificationToken) {
        const user = await this.userRepository.findByVerificationToken(verificationToken);

        if (!user) {
            throw new Error('Invalid verification token');
        }

        await this.userRepository.markVerified(user.id);

        return { success: true, userId: user.id };
    }

    async createPasswordResetToken(email) {
        const user = await this.getUserByEmail(email);
        if (!user) {
            return null;
        }

        const resetToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 3600000);

        await this.userRepository.setResetToken(user.id, resetToken, expiresAt.toISOString());

        return resetToken;
    }

    async resetPassword(resetToken, newPassword) {
        const user = await this.userRepository.findByResetToken(resetToken);

        if (!user) {
            throw new Error('Invalid or expired reset token');
        }

        const hashedPassword = await bcrypt.hash(newPassword, this.saltRounds);

        await this.userRepository.setPasswordAndClearResetToken(user.id, hashedPassword);

        return true;
    }

    async regenerateVerificationToken(userId) {
        const newVerificationToken = crypto.randomBytes(32).toString('hex');

        await this.userRepository.setVerificationToken(userId, newVerificationToken);

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

        // updateStats appends `updated_at = CURRENT_TIMESTAMP` and the
        // WHERE-by-user_id; the whitelist-and-relative-vs-absolute
        // decisions stay here in the service per the comment in
        // AccountStatsRepository.
        await this.accountStatsRepository.updateStats(userId, updateFields, values);

        // Points are now managed independently through addPoints/subtractPoints
        // No need to recalculate here
    }

    async getUserStats(userId) {
        return await this.accountStatsRepository.getStatsByUserId(userId);
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

        // Atomic relative-arithmetic UPDATE. RETURNING gives us the post-write
        // balance without a follow-up SELECT, so concurrent callers can't
        // race on stale reads (ADR-0013a). PR 10.3 routes through the
        // repo — the SQL is byte-equivalent to the legacy inline form.
        const updated = await this.accountStatsRepository.atomicAddPoints({ userId, amount });

        let newBalance;
        if (updated) {
            newBalance = updated.points_balance;
        } else {
            // No stats row yet — INSERT with the amount as the initial balance.
            await this.accountStatsRepository.insertStatsWithBalance({ userId, balance: amount });
            newBalance = amount;
        }

        await this.recordTransaction(userId, amount, newBalance, type, description, metadata);

        logger.debug(`💰 Added ${amount} points to user ${userId} (${type}). New balance: ${newBalance}`);
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

        // Atomic guarded UPDATE: only debit if the row exists AND has enough
        // balance. RETURNING gives us the post-debit balance for the
        // transaction record; no follow-up SELECT, no race window. PR 10.3
        // routes through the repo — the SQL is byte-equivalent to the
        // legacy inline form.
        const updated = await this.accountStatsRepository.atomicSubtractPoints({ userId, amount });

        if (!updated) {
            // Either no stats row or insufficient balance — disambiguate
            // for the error message. The SELECT can race with concurrent
            // mutations but it's only feeding the error string.
            const stats = await this.accountStatsRepository.getPointsBalanceByUserId(userId);
            const currentBalance = stats?.points_balance || 0;
            throw new Error(`Insufficient points balance. Has: ${currentBalance}, Needs: ${amount}`);
        }

        const newBalance = updated.points_balance;

        await this.recordTransaction(userId, -amount, newBalance, type, description, metadata);

        logger.debug(`💸 Subtracted ${amount} points from user ${userId} (${type}). New balance: ${newBalance}`);
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
        await this.accountStatsRepository.insertTransaction({
            userId,
            amount,
            balanceAfter,
            type,
            description,
            metadataJson: metadata ? JSON.stringify(metadata) : null,
        });
    }
    
    /**
     * Get transaction history for a user
     * @param {number} userId - User ID
     * @param {number} limit - Number of transactions to return
     * @returns {Array} Transaction history
     */
    async getTransactionHistory(userId, limit = 50) {
        return await this.accountStatsRepository.listTransactionsByUserId(userId, limit);
    }

    async transferIPSessionToUser(userId, ipAddress, sessionData) {
        await this.userSessionRepository.insertIpTransfer({
            userId,
            ipAddress,
            sessionDataJson: JSON.stringify(sessionData),
        });

        if (sessionData.stats) {
            await this.updateUserStats(userId, sessionData.stats);
        }
    }

    async createSession(userId, ipAddress, expiresIn = 86400000) {
        const expiresAt = new Date(Date.now() + expiresIn);
        const result = await this.userSessionRepository.insertSession({
            userId,
            ipAddress,
            expiresAtIso: expiresAt.toISOString(),
        });
        return result.id;
    }

    async getSessionByUserId(userId) {
        return await this.userSessionRepository.getActiveSessionByUserId(userId);
    }

    async deleteSession(sessionId) {
        await this.userSessionRepository.deleteSessionById(sessionId);
    }

    async cleanupExpiredSessions() {
        await this.userSessionRepository.deleteExpiredSessions();
    }

    async promoteToAdmin(userId) {
        await this.userRepository.update(userId, { is_admin: 1 });
    }

    async demoteFromAdmin(userId) {
        await this.userRepository.update(userId, { is_admin: 0 });
    }

    async banUser(userId) {
        await this.userRepository.update(userId, { is_banned: 1 });
    }

    async unbanUser(userId) {
        await this.userRepository.update(userId, { is_banned: 0 });
    }

    async deleteUser(userId) {
        // First delete user stats
        await this.accountStatsRepository.deleteStatsByUserId(userId);

        // Then delete user sessions
        await this.userSessionRepository.deleteSessionsByUserId(userId);

        // Finally delete the user
        await this.userRepository.deleteById(userId);
    }

    async searchUsers(searchTerm, limit = 50) {
        const searchPattern = `%${searchTerm}%`;
        return await this.userRepository.searchByEmailOrUsername(searchPattern, limit);
    }

    async getAllUsers(limit = 100) {
        return await this.userRepository.listPublic(limit);
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

        // Update username and mark as changed (auto-stamps updated_at).
        await this.userRepository.update(userId, {
            username: newUsername,
            username_changed: 1
        });

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
        const requestedAtIso = new Date().toISOString();
        const scheduledForIso = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(); // 15 days from now

        await this.userRepository.requestDeletion(userId, {
            requestedAtIso,
            token: deletionToken,
            tokenExpiresIso: tokenExpires.toISOString(),
            scheduledForIso
        });

        // Log the deletion request
        await this.logDeletionAction(userId, 'deletion_requested');
        return true;
    }

    async confirmDeletion(token) {
        let user;
        try {
            user = await this.userRepository.findByDeletionToken(token);
        } catch (err) {
            return { success: false, error: 'Database error' };
        }

        if (!user) {
            return { success: false, error: 'Invalid or expired deletion token' };
        }

        try {
            await this.userRepository.confirmDeletion(user.id);
        } catch (err) {
            return { success: false, error: 'Failed to confirm deletion' };
        }

        // Log the confirmation
        await this.logDeletionAction(user.id, 'deletion_confirmed');
        return { success: true, userId: user.id };
    }

    async restoreAccount(userId) {
        const result = await this.userRepository.restoreFromDeletion(userId);
        if (result.changes === 0) {
            return false; // No rows updated
        }
        // Log the restoration
        await this.logDeletionAction(userId, 'account_restored');
        return true;
    }

    async logDeletionAction(userId, action, ipAddress = null, userAgent = null) {
        // PR 10.3 (Phase 10): moved off raw `db.run` callback shape onto
        // the repo's runAsync-backed insertDeletionLog. The legacy code
        // SWALLOWED audit-log INSERT failures (logged + resolved false
        // instead of rejecting); the swallow shape is preserved here at
        // the service level via try/catch.
        const user = await this.getUserById(userId);
        if (!user) return false;

        try {
            await this.userSessionRepository.insertDeletionLog({
                userId,
                username: user.username,
                email: user.email,
                action,
                ipAddress,
                userAgent,
            });
            return true;
        } catch (err) {
            logger.error('Failed to log deletion action:', err);
            return false;
        }
    }

    async getAccountsPendingDeletion() {
        const rows = await this.userRepository.listPendingDeletion();
        return rows || [];
    }

    async permanentlyDeleteAccount(userId) {
        // Log the permanent deletion
        await this.logDeletionAction(userId, 'data_purged');

        // **Cascade-delete loop stays inline by design** (PR 10.3 / Phase 10).
        // The enumerated table list IS the audit trail for what
        // permanent-deletion covers. Replacing it with N
        // repo-method calls would expand the diff without changing
        // semantics, and three of the seven tables aren't owned
        // by any repo yet (`user_inventory` is owned by
        // UserInventoryRepository but the others aren't). A future
        // PR can revisit once every table has a repo.
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
        await this.userRepository.purgeAccount(userId);
        return true;
    }

    async verifyUserPassword(userId, password) {
        try {
            logger.debug('Verifying password for user:', userId);
            const user = await this.userRepository.getPasswordHash(userId);

            if (!user || !user.password) {
                logger.debug('User not found or no password set for user:', userId);
                return false;
            }

            const isValid = await bcrypt.compare(password, user.password);
            logger.debug('Password comparison result for user', userId, ':', isValid);
            return isValid;
        } catch (error) {
            logger.error('Error verifying user password:', error);
            return false;
        }
    }

    async changePassword(userId, newPassword) {
        try {
            logger.debug('Changing password for user:', userId);
            const hashedPassword = await bcrypt.hash(newPassword, this.saltRounds);
            logger.debug('Password hashed successfully');

            // update() auto-stamps updated_at = CURRENT_TIMESTAMP, matching
            // the legacy inline SQL behavior.
            const result = await this.userRepository.update(userId, { password: hashedPassword });
            logger.debug('Database update result:', result);

            return true;
        } catch (error) {
            logger.error('Error changing password:', error);
            throw new Error('Failed to change password');
        }
    }

    async updateProfile(userId, profileData) {
        try {
            const { bio, website, location, displayName, avatar_url, description } = profileData;

            // Build the column-map for UserRepository.update only with the
            // fields the caller actually supplied. update() handles the
            // empty-map case by short-circuiting, and auto-stamps
            // updated_at = CURRENT_TIMESTAMP — matching the legacy SQL.
            const fields = {};
            if (bio !== undefined) fields.bio = bio;
            if (website !== undefined) fields.website = website;
            if (location !== undefined) fields.location = location;
            if (displayName !== undefined) fields.display_name = displayName;
            if (avatar_url !== undefined) fields.avatar_url = avatar_url;
            if (description !== undefined) fields.description = description;

            if (Object.keys(fields).length === 0) {
                // No fields to update
                return await this.getUserProfile(userId);
            }

            await this.userRepository.update(userId, fields);

            // Return the updated profile
            return await this.getUserProfile(userId);
        } catch (error) {
            logger.error('Error updating user profile:', error);
            throw new Error('Failed to update user profile');
        }
    }

    async getUserProfile(userId) {
        try {
            const user = await this.userRepository.getProfileById(userId);
            
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
            logger.error('Error getting user profile:', error);
            throw error;
        }
    }
}

module.exports = AccountService;
