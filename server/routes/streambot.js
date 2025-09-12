const express = require('express');
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
        console.error('Error fetching StreamBot settings:', error);
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
        console.error('Error updating StreamBot settings:', error);
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
        console.error('Error toggling StreamBot:', error);
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
        console.error('Error fetching StreamBot messages:', error);
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
        console.error('Error fetching StreamBot message:', error);
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
        console.error('Error creating StreamBot message:', error);
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
        console.error('Error updating StreamBot message:', error);
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
        console.error('Error deleting StreamBot message:', error);
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
        console.error('Error toggling StreamBot message:', error);
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
        console.error('Error reordering StreamBot messages:', error);
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
        console.error('Error sending test StreamBot message:', error);
        res.status(500).json({ error: 'Failed to send test message' });
    }
});

module.exports = router;