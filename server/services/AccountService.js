const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { db, runAsync, getAsync, allAsync } = require('../database/database');
const UserRepository = require('../database/repository/UserRepository');
const AccountStatsRepository = require('../database/repository/AccountStatsRepository');
const UserSessionRepository = require('../database/repository/UserSessionRepository');

const PointsManager = require('./account/PointsManager');
const AdminPointsManager = require('./account/AdminPointsManager');
const AccountProfileManager = require('./account/AccountProfileManager');
const AccountLifecycleManager = require('./account/AccountLifecycleManager');

const logger = require('../bootstrap/logger').child({ svc: 'AccountService' });

// PR 16.4: typed error used by adminGrantPoints / adminRevokePoints to
// signal client-facing failures (admin row missing or not is_admin, target
// user not found, insufficient balance on revoke). Route handler in
// server/routes/internal.js catches and maps { statusCode, clientMessage }
// to the JSON body shape that the pre-PR routes built inline. Anything else
// propagates as a 500.
class AccountServiceError extends Error {
    constructor(statusCode, clientMessage) {
        super(clientMessage);
        this.name = 'AccountServiceError';
        this.statusCode = statusCode;
        this.clientMessage = clientMessage;
    }
}

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

        // Cohesive collaborators. Each takes an `owner` back-reference; ALL
        // service state stays on the service instance (single source of
        // truth via `owner.<field>`), and the public methods below remain
        // thin delegators with identical signatures.
        this.pointsManager = new PointsManager(this);
        this.adminPointsManager = new AdminPointsManager(this);
        this.profileManager = new AccountProfileManager(this);
        this.lifecycleManager = new AccountLifecycleManager(this);
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

    // S11: server-enforced minimum password policy — the client-side check
    // was the only gate, so a direct API call could set a trivial password.
    static validatePasswordPolicy(password) {
        if (typeof password !== 'string' || password.length < 8) {
            throw new Error('Password must be at least 8 characters long');
        }
        if (password.length > 200) {
            throw new Error('Password is too long');
        }
    }

    async resetPassword(resetToken, newPassword) {
        AccountService.validatePasswordPolicy(newPassword);

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
     * @param {object} [tx] - Optional withTransaction handle; the balance
     *   UPDATE + audit INSERT then join the caller's scope (ADR-0029).
     *   Without one, PointsManager opens its own scope so the pair is
     *   still atomic (audit DB7) — callers already inside a scope MUST
     *   pass their tx through (nesting deadlocks).
     * @returns {number} New balance
     */
    async addPoints(userId, amount, type, description, metadata = null, tx = null) {
        return this.pointsManager.addPoints(userId, amount, type, description, metadata, tx);
    }

    /**
     * Subtract points from user's balance
     * @param {number} userId - User ID
     * @param {number} amount - Amount to subtract (must be positive)
     * @param {string} type - Transaction type (purchase, penalty, etc)
     * @param {string} description - Human-readable description
     * @param {object} metadata - Optional metadata for the transaction
     * @param {object} [tx] - Optional withTransaction handle (ADR-0029)
     * @returns {number} New balance
     */
    async subtractPoints(userId, amount, type, description, metadata = null, tx = null) {
        return this.pointsManager.subtractPoints(userId, amount, type, description, metadata, tx);
    }

    /**
     * Get user's current points balance
     * @param {number} userId - User ID
     * @returns {number} Current balance
     */
    async getPointsBalance(userId) {
        return this.pointsManager.getPointsBalance(userId);
    }

    /**
     * Record a points transaction
     */
    async recordTransaction(userId, amount, balanceAfter, type, description, metadata = null, tx = null) {
        return this.pointsManager.recordTransaction(userId, amount, balanceAfter, type, description, metadata, tx);
    }

    /**
     * PR 16.4: admin grant. Verifies the caller is_admin, resolves
     * targetUsername to a user row, then funnels through `addPoints` with
     * `type='admin_award'` so the audit row carries the standard ledger
     * type. Extracted from the inline /api/internal/admin/award-points
     * handler in server/routes/internal.js.
     *
     * Auth (Bearer token + decoded.id === adminUserId) stays in the
     * handler — this method assumes the caller has proven they are
     * adminUserId; what it adds is the is_admin row-level check.
     *
     * @throws {AccountServiceError} 403 'Admin access required' when the
     *                               adminUserId row is missing or has
     *                               is_admin = 0; 404 `User 'X' not found`
     *                               when targetUsername doesn't resolve.
     * @returns {Promise<{ newBalance, targetUserId, targetUsername }>}
     *          Same subset the pre-PR handler used to build its 200 body.
     */
    async adminGrantPoints(adminUserId, targetUsername, amount) {
        return this.adminPointsManager.adminGrantPoints(adminUserId, targetUsername, amount);
    }

    /**
     * PR 16.4: admin revoke. Sibling of adminGrantPoints — same is_admin
     * guard, same target resolution, but adds a balance precheck (the
     * service throws 400 if `amount > currentBalance`, matching the pre-PR
     * `User only has X points` message) and funnels through
     * `subtractPoints` with `type='admin_deduction'`.
     *
     * @throws {AccountServiceError} 403 'Admin access required'; 404
     *                               `User 'X' not found`; 400
     *                               `User only has X points (cannot
     *                               deduct Y)`.
     * @returns {Promise<{ newBalance, targetUserId, targetUsername }>}
     */
    async adminRevokePoints(adminUserId, targetUsername, amount) {
        return this.adminPointsManager.adminRevokePoints(adminUserId, targetUsername, amount);
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
        return this.profileManager.changeUsername(userId, newUsername);
    }

    async canChangeUsername(userId) {
        return this.profileManager.canChangeUsername(userId);
    }

    // Account deletion methods
    async requestDeletion(userId, deletionToken, tokenExpires) {
        return this.lifecycleManager.requestDeletion(userId, deletionToken, tokenExpires);
    }

    async confirmDeletion(token) {
        return this.lifecycleManager.confirmDeletion(token);
    }

    async restoreAccount(userId) {
        return this.lifecycleManager.restoreAccount(userId);
    }

    async logDeletionAction(userId, action, ipAddress = null, userAgent = null) {
        return this.lifecycleManager.logDeletionAction(userId, action, ipAddress, userAgent);
    }

    async getAccountsPendingDeletion() {
        return this.lifecycleManager.getAccountsPendingDeletion();
    }

    async permanentlyDeleteAccount(userId) {
        return this.lifecycleManager.permanentlyDeleteAccount(userId);
    }

    async verifyUserPassword(userId, password) {
        return this.profileManager.verifyUserPassword(userId, password);
    }

    async changePassword(userId, newPassword) {
        return this.profileManager.changePassword(userId, newPassword);
    }

    async updateProfile(userId, profileData) {
        return this.profileManager.updateProfile(userId, profileData);
    }

    async getUserProfile(userId) {
        return this.profileManager.getUserProfile(userId);
    }
}

module.exports = AccountService;
module.exports.AccountServiceError = AccountServiceError;
