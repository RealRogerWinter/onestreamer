const express = require('express');

const logger = require('../bootstrap/logger').child({ svc: 'admin' });

const router = express.Router();
const { authenticateAdmin, authenticateModerator } = require('../middleware/auth');
const { db, getAsync, allAsync, runAsync } = require('../database/database');
const UserRepository = require('../database/repository/UserRepository');

// Module-scoped repository — matches the PR-Q pattern used inside
// AccountService (and the "stateless services re-instantiated at module
// scope" convention documented in CLAUDE.md).
const userRepository = new UserRepository({ getAsync, runAsync, allAsync });

// Get all users (admin only)
router.get('/users', authenticateAdmin, async (req, res) => {
    try {
        const { search } = req.query;
        const users = await userRepository.listForAdmin({ search });
        res.json(users);
    } catch (error) {
        logger.error('Error fetching users:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// Promote user to admin (admin only)
router.post('/users/:userId/promote-admin', authenticateAdmin, async (req, res) => {
    try {
        const { userId } = req.params;

        // Check if user exists
        const user = await userRepository.getById(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Update user to admin
        await userRepository.update(userId, { is_admin: 1 });

        res.json({ message: 'User promoted to admin successfully', userId });
    } catch (error) {
        logger.error('Error promoting user to admin:', error);
        res.status(500).json({ error: 'Failed to promote user to admin' });
    }
});

// Demote admin (admin only)
router.post('/users/:userId/demote-admin', authenticateAdmin, async (req, res) => {
    try {
        const { userId } = req.params;

        // Prevent self-demotion
        if (req.userRecord.id === parseInt(userId)) {
            return res.status(400).json({ error: 'Cannot demote yourself' });
        }

        // Check if user exists
        const user = await userRepository.getById(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Update user to remove admin
        await userRepository.update(userId, { is_admin: 0 });

        res.json({ message: 'User demoted from admin successfully', userId });
    } catch (error) {
        logger.error('Error demoting user from admin:', error);
        res.status(500).json({ error: 'Failed to demote user from admin' });
    }
});

// Promote user to moderator (admin only)
router.post('/users/:userId/promote-moderator', authenticateAdmin, async (req, res) => {
    try {
        const { userId } = req.params;

        // Check if user exists
        const user = await userRepository.getById(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Update user to moderator
        await userRepository.update(userId, { is_moderator: 1 });

        res.json({ message: 'User promoted to moderator successfully', userId });
    } catch (error) {
        logger.error('Error promoting user to moderator:', error);
        res.status(500).json({ error: 'Failed to promote user to moderator' });
    }
});

// Demote moderator (admin only)
router.post('/users/:userId/demote-moderator', authenticateAdmin, async (req, res) => {
    try {
        const { userId } = req.params;

        // Check if user exists
        const user = await userRepository.getById(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Update user to remove moderator
        await userRepository.update(userId, { is_moderator: 0 });

        res.json({ message: 'User demoted from moderator successfully', userId });
    } catch (error) {
        logger.error('Error demoting user from moderator:', error);
        res.status(500).json({ error: 'Failed to demote user from moderator' });
    }
});

// Ban user (admin only)
router.post('/users/:userId/ban', authenticateAdmin, async (req, res) => {
    try {
        const { userId } = req.params;

        // Prevent self-ban
        if (req.userRecord.id === parseInt(userId)) {
            return res.status(400).json({ error: 'Cannot ban yourself' });
        }

        // Check if user exists
        const user = await userRepository.getById(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Ban the user
        await userRepository.update(userId, { is_banned: 1 });

        res.json({ message: 'User banned successfully', userId });
    } catch (error) {
        logger.error('Error banning user:', error);
        res.status(500).json({ error: 'Failed to ban user' });
    }
});

// Unban user (admin only)
router.post('/users/:userId/unban', authenticateAdmin, async (req, res) => {
    try {
        const { userId } = req.params;

        // Check if user exists
        const user = await userRepository.getById(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Unban the user
        await userRepository.update(userId, { is_banned: 0 });

        res.json({ message: 'User unbanned successfully', userId });
    } catch (error) {
        logger.error('Error unbanning user:', error);
        res.status(500).json({ error: 'Failed to unban user' });
    }
});

// Delete user (admin only)
router.delete('/users/:userId', authenticateAdmin, async (req, res) => {
    try {
        const { userId } = req.params;

        // Prevent self-deletion
        if (req.userRecord.id === parseInt(userId)) {
            return res.status(400).json({ error: 'Cannot delete yourself' });
        }

        // Check if user exists
        const user = await userRepository.getById(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Delete the user (cascade will handle related records)
        await userRepository.deleteById(userId);

        res.json({ message: 'User deleted successfully', userId });
    } catch (error) {
        logger.error('Error deleting user:', error);
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

// Get user status (internal use for chat service)
router.get('/internal/user/:userId/status', async (req, res) => {
    try {
        const { userId } = req.params;

        const user = await userRepository.getStatusFlags(userId);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({
            isAdmin: user.is_admin === 1,
            isModerator: user.is_moderator === 1,
            isBanned: user.is_banned === 1
        });
    } catch (error) {
        logger.error('Error fetching user status:', error);
        res.status(500).json({ error: 'Failed to fetch user status' });
    }
});

// IP Ban Management Routes (moderator access)
router.get('/ip-bans', authenticateModerator, async (req, res) => {
    try {
        const ipBans = await allAsync(`
            SELECT * FROM ip_bans
            ORDER BY created_at DESC
        `);
        res.json(ipBans);
    } catch (error) {
        logger.error('Error fetching IP bans:', error);
        res.status(500).json({ error: 'Failed to fetch IP bans' });
    }
});

router.post('/ip-bans', authenticateModerator, async (req, res) => {
    try {
        const { ip_address, reason } = req.body;

        if (!ip_address) {
            return res.status(400).json({ error: 'IP address is required' });
        }

        // Check if IP is already banned
        const existing = await getAsync('SELECT * FROM ip_bans WHERE ip_address = ?', [ip_address]);
        if (existing) {
            return res.status(400).json({ error: 'IP address is already banned' });
        }

        await runAsync(
            'INSERT INTO ip_bans (ip_address, reason, banned_by) VALUES (?, ?, ?)',
            [ip_address, reason || 'No reason provided', req.userRecord.username]
        );

        res.json({ message: 'IP address banned successfully' });
    } catch (error) {
        logger.error('Error banning IP:', error);
        res.status(500).json({ error: 'Failed to ban IP address' });
    }
});

router.delete('/ip-bans/:id', authenticateModerator, async (req, res) => {
    try {
        const { id } = req.params;

        const result = await runAsync('DELETE FROM ip_bans WHERE id = ?', [id]);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'IP ban not found' });
        }

        res.json({ message: 'IP ban removed successfully' });
    } catch (error) {
        logger.error('Error removing IP ban:', error);
        res.status(500).json({ error: 'Failed to remove IP ban' });
    }
});

module.exports = router;
