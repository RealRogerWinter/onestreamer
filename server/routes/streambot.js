const express = require('express');

const logger = require('../bootstrap/logger').child({ svc: 'streambot' });

const router = express.Router();
const { authenticateAdmin } = require('../middleware/auth');

// All routes require admin authentication
router.use(authenticateAdmin);

// Get StreamBot settings
router.get('/settings', async (req, res) => {
    try {
        const streamBotService = req.app.get('streamBotService');
        const settings = await streamBotService.getSettings();
        res.json(settings);
    } catch (error) {
        logger.error('Error fetching StreamBot settings:', error);
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
});

// Update StreamBot settings
router.put('/settings', async (req, res) => {
    try {
        const streamBotService = req.app.get('streamBotService');
        const { interval_minutes, enabled } = req.body;
        
        const updates = {};
        if (interval_minutes !== undefined) {
            updates.interval_minutes = interval_minutes;
        }
        if (enabled !== undefined) {
            updates.enabled = enabled;
        }
        
        await streamBotService.updateSettings(updates);
        
        // Restart the service with new settings
        await streamBotService.startPeriodicMessages();
        
        const settings = await streamBotService.getSettings();
        res.json(settings);
    } catch (error) {
        logger.error('Error updating StreamBot settings:', error);
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

// Toggle StreamBot enabled status
router.post('/toggle', async (req, res) => {
    try {
        const streamBotService = req.app.get('streamBotService');
        const enabled = await streamBotService.toggleEnabled();
        res.json({ enabled });
    } catch (error) {
        logger.error('Error toggling StreamBot:', error);
        res.status(500).json({ error: 'Failed to toggle StreamBot' });
    }
});

// Get all messages
router.get('/messages', async (req, res) => {
    try {
        const streamBotService = req.app.get('streamBotService');
        const messages = await streamBotService.getMessages();
        res.json(messages);
    } catch (error) {
        logger.error('Error fetching StreamBot messages:', error);
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
});

// Get a single message
router.get('/messages/:id', async (req, res) => {
    try {
        const streamBotService = req.app.get('streamBotService');
        const message = await streamBotService.getMessage(req.params.id);
        
        if (!message) {
            return res.status(404).json({ error: 'Message not found' });
        }
        
        res.json(message);
    } catch (error) {
        logger.error('Error fetching StreamBot message:', error);
        res.status(500).json({ error: 'Failed to fetch message' });
    }
});

// Create a new message
router.post('/messages', async (req, res) => {
    try {
        const streamBotService = req.app.get('streamBotService');
        const { message, order_index } = req.body;
        
        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }
        
        const newMessage = await streamBotService.createMessage(message, order_index);
        res.json(newMessage);
    } catch (error) {
        logger.error('Error creating StreamBot message:', error);
        res.status(500).json({ error: 'Failed to create message' });
    }
});

// Update a message
router.put('/messages/:id', async (req, res) => {
    try {
        const streamBotService = req.app.get('streamBotService');
        const { message, enabled, order_index } = req.body;
        
        const updates = {};
        if (message !== undefined) updates.message = message;
        if (enabled !== undefined) updates.enabled = enabled;
        if (order_index !== undefined) updates.order_index = order_index;
        
        await streamBotService.updateMessage(req.params.id, updates);
        
        const updatedMessage = await streamBotService.getMessage(req.params.id);
        res.json(updatedMessage);
    } catch (error) {
        logger.error('Error updating StreamBot message:', error);
        res.status(500).json({ error: 'Failed to update message' });
    }
});

// Delete a message
router.delete('/messages/:id', async (req, res) => {
    try {
        const streamBotService = req.app.get('streamBotService');
        await streamBotService.deleteMessage(req.params.id);
        res.json({ success: true });
    } catch (error) {
        logger.error('Error deleting StreamBot message:', error);
        res.status(500).json({ error: 'Failed to delete message' });
    }
});

// Toggle message enabled status
router.post('/messages/:id/toggle', async (req, res) => {
    try {
        const streamBotService = req.app.get('streamBotService');
        await streamBotService.toggleMessage(req.params.id);
        
        const message = await streamBotService.getMessage(req.params.id);
        res.json(message);
    } catch (error) {
        logger.error('Error toggling StreamBot message:', error);
        res.status(500).json({ error: 'Failed to toggle message' });
    }
});

// Reorder messages
router.post('/messages/reorder', async (req, res) => {
    try {
        const streamBotService = req.app.get('streamBotService');
        const { messageIds } = req.body;
        
        if (!Array.isArray(messageIds)) {
            return res.status(400).json({ error: 'messageIds must be an array' });
        }
        
        await streamBotService.reorderMessages(messageIds);
        
        const messages = await streamBotService.getMessages();
        res.json(messages);
    } catch (error) {
        logger.error('Error reordering StreamBot messages:', error);
        res.status(500).json({ error: 'Failed to reorder messages' });
    }
});

// Send test message
router.post('/test', async (req, res) => {
    try {
        const streamBotService = req.app.get('streamBotService');
        const { message } = req.body;

        if (!message) {
            // Send the next message in the queue
            await streamBotService.sendNextMessage();
        } else {
            // Send a custom test message
            streamBotService.emit('sendMessage', message);
        }

        res.json({ success: true });
    } catch (error) {
        logger.error('Error sending test StreamBot message:', error);
        res.status(500).json({ error: 'Failed to send test message' });
    }
});

// ==========================================
// AUTO-SUMMON BOT ROUTES
// ==========================================

// Get auto-summon settings
router.get('/auto-summon/settings', async (req, res) => {
    try {
        const streamBotService = req.app.get('streamBotService');
        const settings = await streamBotService.getAutoSummonSettings();
        res.json(settings);
    } catch (error) {
        logger.error('Error fetching auto-summon settings:', error);
        res.status(500).json({ error: 'Failed to fetch auto-summon settings' });
    }
});

// Update auto-summon settings
router.put('/auto-summon/settings', async (req, res) => {
    try {
        const streamBotService = req.app.get('streamBotService');
        const { enabled, interval_minutes, bot_duration_seconds } = req.body;

        const updates = {};
        if (enabled !== undefined) {
            updates.enabled = enabled;
        }
        if (interval_minutes !== undefined) {
            updates.interval_minutes = interval_minutes;
        }
        if (bot_duration_seconds !== undefined) {
            updates.bot_duration_seconds = bot_duration_seconds;
        }

        await streamBotService.updateAutoSummonSettings(updates);

        // Restart auto-summon if enabled was changed
        if (enabled !== undefined) {
            if (enabled) {
                await streamBotService.startAutoSummon();
            } else {
                await streamBotService.stopAutoSummon();
            }
        } else if (interval_minutes !== undefined) {
            // Restart with new interval if auto-summon is enabled
            const settings = await streamBotService.getAutoSummonSettings();
            if (settings.enabled) {
                await streamBotService.startAutoSummon();
            }
        }

        const newSettings = await streamBotService.getAutoSummonSettings();
        res.json(newSettings);
    } catch (error) {
        logger.error('Error updating auto-summon settings:', error);
        res.status(500).json({ error: 'Failed to update auto-summon settings' });
    }
});

// Toggle auto-summon enabled status
router.post('/auto-summon/toggle', async (req, res) => {
    try {
        const streamBotService = req.app.get('streamBotService');
        const enabled = await streamBotService.toggleAutoSummon();
        res.json({ enabled });
    } catch (error) {
        logger.error('Error toggling auto-summon:', error);
        res.status(500).json({ error: 'Failed to toggle auto-summon' });
    }
});

// Trigger immediate auto-summon (manual)
router.post('/auto-summon/trigger', async (req, res) => {
    try {
        const streamBotService = req.app.get('streamBotService');
        await streamBotService.triggerManualAutoSummon();
        res.json({ success: true, message: 'Auto-summon triggered successfully' });
    } catch (error) {
        logger.error('Error triggering auto-summon:', error);
        res.status(500).json({ error: 'Failed to trigger auto-summon' });
    }
});

// Get auto-summoned bot history
router.get('/auto-summon/history', async (req, res) => {
    try {
        const streamBotService = req.app.get('streamBotService');
        const limit = parseInt(req.query.limit) || 20;
        const history = await streamBotService.getAutoSummonedBotHistory(limit);
        res.json(history);
    } catch (error) {
        logger.error('Error fetching auto-summon history:', error);
        res.status(500).json({ error: 'Failed to fetch auto-summon history' });
    }
});

// Test Groq character generation (preview without creating bot)
router.post('/auto-summon/preview-character', async (req, res) => {
    try {
        const streamBotService = req.app.get('streamBotService');
        const character = await streamBotService.generateWhimsicalCharacter();
        res.json(character);
    } catch (error) {
        logger.error('Error generating preview character:', error);
        res.status(500).json({ error: 'Failed to generate character preview' });
    }
});

module.exports = router;
