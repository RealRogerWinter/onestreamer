const express = require('express');
const { authenticateAdmin } = require('../../middleware/auth');

// Admin user-management surface (list/search, promote/demote, ban/unban,
// delete). Every route is admin-gated. Mounted at '/' by the parent so
// paths/methods/middleware are byte-for-byte identical to the prior monolithic
// router.
module.exports = function createAdminRouter({ logger, authService }) {
    const router = express.Router();

    // Admin routes
    router.get('/admin/users', authenticateAdmin, async (req, res) => {
        try {
            const { search, limit = 50 } = req.query;
            let users;

            if (search) {
                users = await authService.accountService.searchUsers(search, parseInt(limit));
            } else {
                users = await authService.accountService.getAllUsers(parseInt(limit));
            }

            res.json({ users });
        } catch (error) {
            logger.error('Get users error:', error);
            res.status(500).json({ error: 'Failed to fetch users' });
        }
    });

    router.post('/admin/users/:id/promote', authenticateAdmin, async (req, res) => {
        try {
            const userId = parseInt(req.params.id);

            if (userId === req.user.id) {
                return res.status(400).json({ error: 'Cannot modify your own admin status' });
            }

            await authService.accountService.promoteToAdmin(userId);
            res.json({ message: 'User promoted to admin' });
        } catch (error) {
            logger.error('Promote user error:', error);
            res.status(500).json({ error: 'Failed to promote user' });
        }
    });

    router.post('/admin/users/:id/demote', authenticateAdmin, async (req, res) => {
        try {
            const userId = parseInt(req.params.id);

            if (userId === req.user.id) {
                return res.status(400).json({ error: 'Cannot modify your own admin status' });
            }

            await authService.accountService.demoteFromAdmin(userId);
            res.json({ message: 'User demoted from admin' });
        } catch (error) {
            logger.error('Demote user error:', error);
            res.status(500).json({ error: 'Failed to demote user' });
        }
    });

    router.post('/admin/users/:id/ban', authenticateAdmin, async (req, res) => {
        try {
            const userId = parseInt(req.params.id);

            if (userId === req.user.id) {
                return res.status(400).json({ error: 'Cannot ban yourself' });
            }

            await authService.accountService.banUser(userId);
            res.json({ message: 'User banned' });
        } catch (error) {
            logger.error('Ban user error:', error);
            res.status(500).json({ error: 'Failed to ban user' });
        }
    });

    router.post('/admin/users/:id/unban', authenticateAdmin, async (req, res) => {
        try {
            const userId = parseInt(req.params.id);
            await authService.accountService.unbanUser(userId);
            res.json({ message: 'User unbanned' });
        } catch (error) {
            logger.error('Unban user error:', error);
            res.status(500).json({ error: 'Failed to unban user' });
        }
    });

    router.delete('/admin/users/:id', authenticateAdmin, async (req, res) => {
        try {
            const userId = parseInt(req.params.id);

            if (userId === req.user.id) {
                return res.status(400).json({ error: 'Cannot delete yourself' });
            }

            await authService.accountService.deleteUser(userId);
            res.json({ message: 'User deleted' });
        } catch (error) {
            logger.error('Delete user error:', error);
            res.status(500).json({ error: 'Failed to delete user' });
        }
    });

    return router;
};
