const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const { authenticateToken } = require('../../middleware/auth');

// Session / profile surface: /me, change-username, profile, avatar (upload +
// delete), and the public /user/:username lookup. Mounted at '/' by the parent
// so paths/methods/middleware are byte-for-byte identical to the prior
// monolithic router. The `upload` multer instance is injected from the parent
// so its module-scoped storage/limits config is shared verbatim.
module.exports = function createSessionRouter({ logger, authService, upload }) {
    const router = express.Router();

    router.get('/me', authenticateToken, async (req, res) => {
        try {
            const user = await authService.accountService.getUserById(req.user.id);
            const stats = await authService.accountService.getUserStats(req.user.id);

            // Use points_balance, not calculated points
            const points = stats?.points_balance || 0;

            // Check if user can change username
            const canChangeUsername = await authService.accountService.canChangeUsername(req.user.id);

            res.json({
                user: {
                    ...user,
                    canChangeUsername,
                    avatar_url: user.avatar_url,
                    description: user.description
                },
                stats: {
                    ...stats,
                    points  // This is now the balance, not calculated
                }
            });
        } catch (error) {
            logger.error('Get user error:', error);
            res.status(500).json({ error: 'Failed to get user data' });
        }
    });

    router.put('/change-username', authenticateToken, async (req, res) => {
        try {
            const { newUsername } = req.body;

            if (!newUsername) {
                return res.status(400).json({ error: 'New username is required' });
            }

            const result = await authService.accountService.changeUsername(req.user.id, newUsername);

            // Generate new token with updated username
            const user = await authService.accountService.getUserById(req.user.id);
            const token = authService.generateToken(user);
            const refreshToken = authService.generateRefreshToken(user);

            res.json({
                success: true,
                username: result.username,
                token,
                refreshToken,
                message: 'Username changed successfully'
            });
        } catch (error) {
            logger.error('Change username error:', error);
            res.status(400).json({ error: error.message });
        }
    });

    router.put('/profile', authenticateToken, async (req, res) => {
        try {
            const userId = req.user.id;
            const { bio, website, location, displayName, currentPassword, newPassword, description } = req.body;

            logger.debug('Profile update request:', {
                userId,
                hasCurrentPassword: !!currentPassword,
                hasNewPassword: !!newPassword,
                hasBio: !!bio,
                hasWebsite: !!website,
                hasLocation: !!location,
                hasDisplayName: !!displayName
            });

            // Update user profile
            const user = await authService.accountService.getUserById(userId);
            if (!user) {
                return res.status(404).json({ error: 'User not found' });
            }

            // Handle password change if requested
            if (currentPassword && newPassword) {
                logger.debug('Attempting password change for user:', userId);
                // Verify current password
                const isValidPassword = await authService.accountService.verifyUserPassword(userId, currentPassword);
                logger.debug('Current password validation result:', isValidPassword);
                if (!isValidPassword) {
                    return res.status(400).json({ error: 'Current password is incorrect' });
                }

                // Update password
                await authService.accountService.changePassword(userId, newPassword);
                logger.debug('Password changed successfully for user:', userId);
            }

            // Update profile fields
            const updatedProfile = await authService.accountService.updateProfile(userId, {
                bio,
                website,
                location,
                displayName,
                description
            });

            res.json({
                success: true,
                message: 'Profile updated successfully',
                profile: updatedProfile
            });
        } catch (error) {
            logger.error('Profile update error:', error);
            res.status(500).json({ error: 'Failed to update profile' });
        }
    });

    // Avatar upload endpoint with enhanced error handling
    router.post('/avatar', authenticateToken, (req, res) => {
        upload.single('avatar')(req, res, async (err) => {
            try {
                // Handle multer errors
                if (err) {
                    logger.error('Multer error:', err);
                    if (err.code === 'LIMIT_FILE_SIZE') {
                        return res.status(400).json({ error: 'File size too large. Maximum size is 5MB.' });
                    }
                    if (err.message === 'Only image files are allowed') {
                        return res.status(400).json({ error: err.message });
                    }
                    return res.status(400).json({ error: 'Error uploading file: ' + err.message });
                }

                if (!req.file) {
                    return res.status(400).json({ error: 'No file uploaded' });
                }

                const userId = req.user.id;
                const avatarUrl = `/uploads/avatars/${req.file.filename}`;

                logger.debug('Avatar upload:', {
                    userId,
                    filename: req.file.filename,
                    mimetype: req.file.mimetype,
                    size: req.file.size,
                    avatarUrl
                });

                // Get old avatar to delete it
                const user = await authService.accountService.getUserById(userId);
                if (user && user.avatar_url) {
                    // NOTE: the original handler lived in server/routes/auth.js, so
                    // `path.join(__dirname, '..', ...)` resolved relative to
                    // server/routes → i.e. server/<avatar_url>. This module sits one
                    // level deeper (server/routes/auth/), so we add an extra '..' to
                    // preserve the EXACT same resolved path (server/<avatar_url>).
                    const oldAvatarPath = path.join(__dirname, '..', '..', user.avatar_url);
                    try {
                        await fs.unlink(oldAvatarPath);
                        logger.debug('Deleted old avatar:', oldAvatarPath);
                    } catch (err) {
                        logger.debug('Could not delete old avatar:', err.message);
                    }
                }

                // Update user's avatar URL in database
                await authService.accountService.updateProfile(userId, {
                    avatar_url: avatarUrl
                });

                res.json({
                    success: true,
                    avatar_url: avatarUrl,
                    message: 'Avatar uploaded successfully'
                });
            } catch (error) {
                logger.error('Avatar upload error:', error);
                res.status(500).json({ error: 'Failed to upload avatar: ' + error.message });
            }
        });
    });

    // Delete avatar endpoint
    router.delete('/avatar', authenticateToken, async (req, res) => {
        try {
            const userId = req.user.id;
            const user = await authService.accountService.getUserById(userId);

            if (user.avatar_url) {
                // Extract filename from URL path
                const filename = user.avatar_url.split('/').pop();
                const avatarPath = path.join('/var/www/uploads/avatars', filename);
                try {
                    await fs.unlink(avatarPath);
                } catch (err) {
                    logger.debug('Could not delete avatar file:', err.message);
                }
            }

            // Remove avatar URL from database
            await authService.accountService.updateProfile(userId, {
                avatar_url: null
            });

            res.json({
                success: true,
                message: 'Avatar deleted successfully'
            });
        } catch (error) {
            logger.error('Avatar delete error:', error);
            res.status(500).json({ error: 'Failed to delete avatar' });
        }
    });

    // Get user public profile endpoint
    router.get('/user/:username', async (req, res) => {
        try {
            const { username } = req.params;

            // Remove any emoji prefix (like 🤖) from the username for checking
            const cleanUsername = username.replace(/^🤖\s*/, '');

            // List of animal names used for anonymous users
            const ANONYMOUS_ANIMALS = [
                'Lion', 'Tiger', 'Bear', 'Wolf', 'Fox', 'Rabbit', 'Deer', 'Eagle', 'Hawk', 'Owl',
                'Cat', 'Dog', 'Mouse', 'Rat', 'Hamster', 'Squirrel', 'Beaver', 'Otter', 'Seal', 'Whale',
                'Shark', 'Fish', 'Crab', 'Lobster', 'Shrimp', 'Octopus', 'Jellyfish', 'Starfish', 'Turtle', 'Snake',
                'Lizard', 'Frog', 'Toad', 'Salamander', 'Newt', 'Butterfly', 'Bee', 'Ant', 'Spider', 'Scorpion',
                'Penguin', 'Flamingo', 'Swan', 'Duck', 'Goose', 'Chicken', 'Turkey', 'Peacock', 'Parrot', 'Canary'
            ];

            // Check if this is an anonymous user (animal name + numbers pattern)
            const isAnonymousPattern = ANONYMOUS_ANIMALS.some(animal => {
                const pattern = new RegExp(`^${animal}\\d+$`, 'i');
                return pattern.test(cleanUsername);
            });

            // Also check for explicit anonymous/guest prefixes
            if (isAnonymousPattern || cleanUsername.toLowerCase().startsWith('anonymous') || cleanUsername.toLowerCase().startsWith('guest')) {
                // Return a special response for anonymous users
                return res.json({
                    username: cleanUsername,
                    is_anonymous: true,
                    description: 'This is an anonymous user. No account information available.',
                    created_at: new Date().toISOString()
                });
            }

            // Special case for StreamBot
            if (cleanUsername.toLowerCase() === 'streambot') {
                return res.json({
                    username: 'StreamBot',
                    is_chatbot: true,
                    description: 'The StreamBot is responsible for various functions of OneStreamer including notifications, automated messages, and system operations.',
                    bot_type: 'System Bot',
                    is_system: true,
                    created_at: '2024-01-01T00:00:00.000Z',
                    is_anonymous: false
                });
            }

            // Check if this is a chatbot by checking active chatbots
            const db = require('../../database/database').db;
            const chatbot = await new Promise((resolve, reject) => {
                db.get(
                    `SELECT c.*, t.personality_prompt
                     FROM chatbots c
                     LEFT JOIN temporary_bots t ON c.id = t.chatbot_id
                     WHERE c.name = ? AND c.is_enabled = 1`,
                    [cleanUsername],
                    (err, row) => {
                        if (err) reject(err);
                        else resolve(row);
                    }
                );
            });

            if (chatbot) {
                // Use personality_prompt for temporary bots, otherwise use the full prompt
                let description = chatbot.prompt || 'AI Chatbot';
                if (chatbot.is_temporary && chatbot.personality_prompt) {
                    description = chatbot.personality_prompt;
                }

                // Return chatbot information
                return res.json({
                    username: cleanUsername,
                    is_chatbot: true,
                    description: description,
                    bot_type: chatbot.llm_model || 'default',
                    duration_minutes: chatbot.is_temporary ? 60 : null,
                    created_at: chatbot.created_at,
                    expires_at: chatbot.expires_at,
                    is_anonymous: false
                });
            }

            const user = await authService.accountService.getUserByUsername(cleanUsername);

            if (!user) {
                // If not found as a user, might be an inactive chatbot
                const inactiveChatbot = await new Promise((resolve, reject) => {
                    db.get(
                        `SELECT c.*, t.personality_prompt
                         FROM chatbots c
                         LEFT JOIN temporary_bots t ON c.id = t.chatbot_id
                         WHERE c.name = ?`,
                        [cleanUsername],
                        (err, row) => {
                            if (err) reject(err);
                            else resolve(row);
                        }
                    );
                });

                if (inactiveChatbot) {
                    // Use personality_prompt for temporary bots, otherwise use the full prompt
                    let description = inactiveChatbot.prompt || 'AI Chatbot (Inactive)';
                    if (inactiveChatbot.is_temporary && inactiveChatbot.personality_prompt) {
                        description = inactiveChatbot.personality_prompt + ' (Inactive)';
                    } else if (!inactiveChatbot.is_temporary) {
                        description = (inactiveChatbot.prompt || 'AI Chatbot') + ' (Inactive)';
                    }

                    return res.json({
                        username: cleanUsername,
                        is_chatbot: true,
                        description: description,
                        bot_type: inactiveChatbot.llm_model || 'default',
                        is_active: false,
                        is_anonymous: false
                    });
                }

                return res.status(404).json({ error: 'User not found' });
            }

            // Get user stats if available
            const userStats = await authService.accountService.getUserStats(user.id);

            // Return only public information
            res.json({
                username: user.username,
                avatar_url: user.avatar_url,
                description: user.description,
                is_admin: user.is_admin,
                is_moderator: user.is_moderator,
                created_at: user.created_at,
                is_anonymous: false,
                is_chatbot: false,
                // Include stats if available
                points_balance: userStats?.points_balance || 0,
                total_stream_time: userStats?.total_stream_time || 0,
                total_view_time: userStats?.total_view_time || 0,
                stream_count: userStats?.stream_count || 0
            });
        } catch (error) {
            logger.error('Get user profile error:', error);
            res.status(500).json({ error: 'Failed to get user profile' });
        }
    });

    return router;
};
