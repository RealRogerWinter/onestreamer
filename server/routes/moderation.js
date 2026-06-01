const express = require('express');

const logger = require('../bootstrap/logger').child({ svc: 'moderation' });

const router = express.Router();
const AuthService = require('../services/AuthService');
const authService = new AuthService();
const { db, getAsync, runAsync, allAsync } = require('../database/database');
const UserRepository = require('../database/repository/UserRepository');
// Canonical auth middleware — sets req.userRecord and enforces the is_banned
// 403 (a banned moderator/admin is blocked). Replaces the former inline
// authenticate/authenticateModerator/authenticateAdmin closures, which set
// req.currentUser and skipped the is_banned check (privilege gap).
const { authenticateModerator, authenticateAdmin } = require('../middleware/auth');

// Module-scoped repository — matches the PR-Q pattern used inside
// AccountService / admin.js (stateless services re-instantiated at module
// scope per CLAUDE.md).
const userRepository = new UserRepository({ getAsync, runAsync, allAsync });

// Ban user from chat
router.post('/ban-chat', authenticateModerator, async (req, res) => {
    try {
        const { username } = req.body;
        
        if (!username) {
            return res.status(400).json({ error: 'Username is required' });
        }
        
        // Check if it's an anonymous user (animal name + numbers)
        const ANONYMOUS_ANIMALS = [
            'Lion', 'Tiger', 'Bear', 'Wolf', 'Fox', 'Rabbit', 'Deer', 'Eagle', 'Hawk', 'Owl',
            'Cat', 'Dog', 'Mouse', 'Rat', 'Hamster', 'Squirrel', 'Beaver', 'Otter', 'Seal', 'Whale',
            'Shark', 'Fish', 'Crab', 'Lobster', 'Shrimp', 'Octopus', 'Jellyfish', 'Starfish', 'Turtle', 'Snake',
            'Lizard', 'Frog', 'Toad', 'Salamander', 'Newt', 'Butterfly', 'Bee', 'Ant', 'Spider', 'Scorpion',
            'Penguin', 'Flamingo', 'Swan', 'Duck', 'Goose', 'Chicken', 'Turkey', 'Peacock', 'Parrot', 'Canary'
        ];
        
        const isAnonymous = ANONYMOUS_ANIMALS.some(animal => {
            const pattern = new RegExp(`^${animal}\\d+$`, 'i');
            return pattern.test(username);
        });
        
        let user = null;
        if (!isAnonymous) {
            // Get user by username for registered users
            user = await authService.accountService.getUserByUsername(username);
            if (!user) {
                return res.status(404).json({ error: 'User not found' });
            }
            
            // Don't allow banning admins
            if (user.is_admin) {
                return res.status(403).json({ error: 'Cannot ban administrators' });
            }
            
            // Don't allow moderators to ban other moderators (only admins can)
            if (user.is_moderator && !req.userRecord.is_admin) {
                return res.status(403).json({ error: 'Only administrators can ban moderators' });
            }
        }
        
        // Handle ban differently for anonymous vs registered users
        if (isAnonymous) {
            // For anonymous users, we need to track the ban by username in a separate table or by IP
            // For now, we'll store it in a banned_usernames table
            await new Promise((resolve, reject) => {
                db.run(
                    `INSERT OR REPLACE INTO banned_usernames (username, banned_by, banned_at, ban_type) 
                     VALUES (?, ?, CURRENT_TIMESTAMP, 'chat')`,
                    [username, req.userRecord.id],
                    (err) => {
                        if (err) reject(err);
                        else resolve();
                    }
                );
            });
        } else {
            // Update user's chat_banned status for registered users
            await userRepository.banFromChat(user.id, req.userRecord.id);
        }
        
        // Log the moderation action
        await new Promise((resolve, reject) => {
            db.run(
                `INSERT INTO moderation_logs (moderator_id, moderator_username, target_user_id, target_username, action, reason, created_at) 
                 VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [req.userRecord.id, req.userRecord.username, user ? user.id : null, username, 'chat_ban', 'Banned from chat via user profile', ],
                (err) => {
                    if (err) reject(err);
                    else resolve();
                }
            );
        });
        
        res.json({ success: true, message: `${username} has been banned from chat` });
    } catch (error) {
        logger.error('Chat ban error:', error);
        res.status(500).json({ error: 'Failed to ban user from chat' });
    }
});

// Timeout user from chat
router.post('/timeout', authenticateModerator, async (req, res) => {
    try {
        const { username, duration } = req.body;
        
        if (!username || !duration) {
            return res.status(400).json({ error: 'Username and duration are required' });
        }
        
        // Get user by username
        const user = await authService.accountService.getUserByUsername(username);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Don't allow timing out admins
        if (user.is_admin) {
            return res.status(403).json({ error: 'Cannot timeout administrators' });
        }
        
        // Don't allow moderators to timeout other moderators (only admins can)
        if (user.is_moderator && !req.userRecord.is_admin) {
            return res.status(403).json({ error: 'Only administrators can timeout moderators' });
        }
        
        // Calculate timeout end time based on duration
        let timeoutMinutes;
        switch(duration) {
            case '1 hour':
                timeoutMinutes = 60;
                break;
            case '1 day':
                timeoutMinutes = 60 * 24;
                break;
            case '1 week':
                timeoutMinutes = 60 * 24 * 7;
                break;
            case '1 month':
                timeoutMinutes = 60 * 24 * 30;
                break;
            default:
                return res.status(400).json({ error: 'Invalid duration' });
        }
        
        const timeoutUntil = new Date(Date.now() + timeoutMinutes * 60 * 1000).toISOString();
        
        // Update user's timeout status
        await userRepository.setChatTimeout(user.id, req.userRecord.id, timeoutUntil);
        
        // Log the moderation action
        await new Promise((resolve, reject) => {
            db.run(
                `INSERT INTO moderation_logs (moderator_id, moderator_username, target_user_id, target_username, action, reason, created_at) 
                 VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [req.userRecord.id, req.userRecord.username, user.id, username, 'chat_timeout', `Timeout for ${duration}`, ],
                (err) => {
                    if (err) reject(err);
                    else resolve();
                }
            );
        });
        
        res.json({ success: true, message: `${username} has been timed out for ${duration}` });
    } catch (error) {
        logger.error('Timeout error:', error);
        res.status(500).json({ error: 'Failed to timeout user' });
    }
});

// Ban user from streaming (admin only)
router.post('/ban-streamer', authenticateAdmin, async (req, res) => {
    try {
        const { username } = req.body;
        
        if (!username) {
            return res.status(400).json({ error: 'Username is required' });
        }
        
        // Get user by username
        const user = await authService.accountService.getUserByUsername(username);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Don't allow banning other admins
        if (user.is_admin) {
            return res.status(403).json({ error: 'Cannot ban other administrators from streaming' });
        }
        
        // Update user's streaming_banned status
        await userRepository.banFromStreaming(user.id, req.userRecord.id);
        
        // Log the moderation action
        await new Promise((resolve, reject) => {
            db.run(
                `INSERT INTO moderation_logs (moderator_id, moderator_username, target_user_id, target_username, action, reason, created_at) 
                 VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [req.userRecord.id, req.userRecord.username, user.id, username, 'streaming_ban', 'Banned from streaming via user profile', ],
                (err) => {
                    if (err) reject(err);
                    else resolve();
                }
            );
        });
        
        res.json({ success: true, message: `${username} has been banned from streaming` });
    } catch (error) {
        logger.error('Streaming ban error:', error);
        res.status(500).json({ error: 'Failed to ban user from streaming' });
    }
});

module.exports = router;
