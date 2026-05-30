/**
 * AccountProfileManager.js - profile + credential operations extracted from
 * AccountService.
 *
 * Username-change policy, profile read/update, and password verify/change.
 * Reads owner.userRepository and owner.getUserById / owner.getUserProfile via
 * the `owner` back-reference so behavior is byte-identical to the in-service
 * form. Bodies moved verbatim (only `this.`→`owner.`).
 */

const bcrypt = require('bcrypt');

const logger = require('../../bootstrap/logger').child({ svc: 'AccountService' });

class AccountProfileManager {
    constructor(owner) {
        this.owner = owner;
    }

    async changeUsername(userId, newUsername) {
        const owner = this.owner;
        // Check if user exists and get their current info
        const user = await owner.getUserById(userId);
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
        const existingUser = await owner.getUserByUsername(newUsername);
        if (existingUser && existingUser.id !== userId) {
            throw new Error('Username already taken');
        }

        // Update username and mark as changed (auto-stamps updated_at).
        await owner.userRepository.update(userId, {
            username: newUsername,
            username_changed: 1
        });

        return {
            success: true,
            username: newUsername
        };
    }

    async canChangeUsername(userId) {
        const owner = this.owner;
        const user = await owner.getUserById(userId);
        if (!user) {
            return false;
        }

        // User can change username if:
        // 1. They signed up via OAuth
        // 2. They haven't changed it yet
        return user.oauth_provider && (user.username_changed === 0 || user.username_changed === false || user.username_changed === null);
    }

    async verifyUserPassword(userId, password) {
        const owner = this.owner;
        try {
            logger.debug('Verifying password for user:', userId);
            const user = await owner.userRepository.getPasswordHash(userId);

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
        const owner = this.owner;
        try {
            logger.debug('Changing password for user:', userId);
            const hashedPassword = await bcrypt.hash(newPassword, owner.saltRounds);
            logger.debug('Password hashed successfully');

            // update() auto-stamps updated_at = CURRENT_TIMESTAMP, matching
            // the legacy inline SQL behavior.
            const result = await owner.userRepository.update(userId, { password: hashedPassword });
            logger.debug('Database update result:', result);

            return true;
        } catch (error) {
            logger.error('Error changing password:', error);
            throw new Error('Failed to change password');
        }
    }

    async updateProfile(userId, profileData) {
        const owner = this.owner;
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
                return await owner.getUserProfile(userId);
            }

            await owner.userRepository.update(userId, fields);

            // Return the updated profile
            return await owner.getUserProfile(userId);
        } catch (error) {
            logger.error('Error updating user profile:', error);
            throw new Error('Failed to update user profile');
        }
    }

    async getUserProfile(userId) {
        const owner = this.owner;
        try {
            const user = await owner.userRepository.getProfileById(userId);

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

module.exports = AccountProfileManager;
