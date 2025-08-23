const express = require('express');
const router = express.Router();
const { authenticateToken, authenticateAdmin } = require('../middleware/auth');
const database = require('../database/database');

let chatBotService = null;

// Initialize service reference
function initializeChatBotRoutes(service) {
    chatBotService = service;
    
    // Auto-initialize bots after routes are set up
    setTimeout(() => {
        console.log('🤖 ROUTES: Auto-initializing ChatBot service...');
        chatBotService.initialize().catch(err => {
            console.error('❌ ROUTES: Failed to auto-initialize ChatBots:', err);
        });
    }, 3000);
}

// Get all chatbots
router.get('/', authenticateAdmin, async (req, res) => {
    try {
        const bots = await chatBotService.getAllBots();
        res.json(bots);
    } catch (error) {
        console.error('Error fetching chatbots:', error);
        res.status(500).json({ error: 'Failed to fetch chatbots' });
    }
});

// Get global prompt configuration
router.get('/config', authenticateAdmin, async (req, res) => {
    try {
        const config = await database.getAsync('SELECT * FROM chatbot_config WHERE id = 1');
        res.json(config || { global_prompt: '', updated_at: null });
    } catch (error) {
        console.error('Error fetching global config:', error);
        res.status(500).json({ error: 'Failed to fetch global configuration' });
    }
});

// Update global prompt configuration
router.put('/config', authenticateAdmin, async (req, res) => {
    const { global_prompt } = req.body;
    
    if (!global_prompt || typeof global_prompt !== 'string') {
        return res.status(400).json({ error: 'Global prompt is required and must be a string' });
    }
    
    try {
        await database.runAsync(
            'UPDATE chatbot_config SET global_prompt = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
            [global_prompt]
        );
        
        // Reload the global prompt in the LLM service
        if (chatBotService?.llmService) {
            await chatBotService.llmService.loadGlobalPrompt();
        }
        
        const config = await database.getAsync('SELECT * FROM chatbot_config WHERE id = 1');
        res.json(config);
    } catch (error) {
        console.error('Error updating global config:', error);
        res.status(500).json({ error: 'Failed to update global configuration' });
    }
});

// Get available LLM models
router.get('/models', authenticateAdmin, async (req, res) => {
    try {
        const availableModels = chatBotService.llmService.getAvailableModels();
        const currentModel = chatBotService.llmService.getCurrentModel();
        
        res.json({
            available: availableModels,
            current: currentModel
        });
    } catch (error) {
        console.error('Error fetching available models:', error);
        res.status(500).json({ error: 'Failed to fetch available models' });
    }
});

// Switch LLM model
router.put('/models', authenticateAdmin, async (req, res) => {
    const { model } = req.body;
    
    if (!model || typeof model !== 'string') {
        return res.status(400).json({ error: 'Model name is required and must be a string' });
    }
    
    try {
        const result = await chatBotService.llmService.switchModel(model);
        res.json(result);
    } catch (error) {
        console.error('Error switching model:', error);
        res.status(500).json({ error: 'Failed to switch model' });
    }
});

// Check LLM availability
router.get('/llm-status', authenticateAdmin, async (req, res) => {
    try {
        const isAvailable = await chatBotService.llmService.testConnection();
        res.json({ 
            available: isAvailable,
            model: chatBotService.llmService.model,
            host: chatBotService.llmService.ollama.config.host
        });
    } catch (error) {
        console.error('Error checking LLM status:', error);
        res.status(500).json({ error: 'Failed to check LLM status' });
    }
});

// Create new chatbot
router.post('/', authenticateAdmin, async (req, res) => {
    try {
        const bot = await chatBotService.createBot(req.body);
        res.status(201).json(bot);
    } catch (error) {
        console.error('Error creating chatbot:', error);
        res.status(500).json({ error: 'Failed to create chatbot' });
    }
});

// Update chatbot
router.put('/:id', authenticateAdmin, async (req, res) => {
    try {
        const bot = await chatBotService.updateBot(req.params.id, req.body);
        res.json(bot);
    } catch (error) {
        console.error('Error updating chatbot:', error);
        res.status(500).json({ error: 'Failed to update chatbot' });
    }
});

// Delete chatbot
router.delete('/:id', authenticateAdmin, async (req, res) => {
    try {
        await chatBotService.deleteBot(req.params.id);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting chatbot:', error);
        res.status(500).json({ error: 'Failed to delete chatbot' });
    }
});

// Toggle chatbot enabled state
router.post('/:id/toggle', authenticateAdmin, async (req, res) => {
    try {
        const bot = await chatBotService.toggleBot(req.params.id);
        res.json(bot);
    } catch (error) {
        console.error('Error toggling chatbot:', error);
        res.status(500).json({ error: 'Failed to toggle chatbot' });
    }
});

// Enable all chatbots
router.post('/all/enable', authenticateAdmin, async (req, res) => {
    try {
        const result = await chatBotService.enableAllBots();
        res.json(result);
    } catch (error) {
        console.error('Error enabling all chatbots:', error);
        res.status(500).json({ error: 'Failed to enable all chatbots' });
    }
});

// Disable all chatbots
router.post('/all/disable', authenticateAdmin, async (req, res) => {
    console.log('🔴 API: Disable all chatbots endpoint called');
    console.log('🔴 API: Request user:', req.user);
    console.log('🔴 API: Request headers:', req.headers);
    
    try {
        console.log('🔴 API: Calling chatBotService.disableAllBots()...');
        const result = await chatBotService.disableAllBots();
        console.log('🔴 API: disableAllBots result:', result);
        res.json(result);
    } catch (error) {
        console.error('🔴 API: Error disabling all chatbots:', error);
        console.error('🔴 API: Error stack:', error.stack);
        res.status(500).json({ error: 'Failed to disable all chatbots' });
    }
});

// Test chatbot response
router.post('/:id/test', authenticateAdmin, async (req, res) => {
    try {
        const result = await chatBotService.testBot(req.params.id);
        res.json(result);
    } catch (error) {
        console.error('Error testing chatbot:', error);
        res.status(500).json({ error: 'Failed to test chatbot' });
    }
});

// Send manual message from chatbot
router.post('/:id/send', authenticateAdmin, async (req, res) => {
    try {
        const { message } = req.body;
        const result = await chatBotService.sendManualMessage(req.params.id, message);
        res.json(result);
    } catch (error) {
        console.error('Error sending manual message:', error);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// Get active chatbot sessions
router.get('/sessions', authenticateAdmin, async (req, res) => {
    try {
        const sessions = await chatBotService.getActiveSessions();
        res.json(sessions);
    } catch (error) {
        console.error('Error fetching sessions:', error);
        res.status(500).json({ error: 'Failed to fetch sessions' });
    }
});

// Get chatbot message history
router.get('/:id/history', authenticateAdmin, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const history = await chatBotService.getMessageHistory(req.params.id, limit);
        res.json(history);
    } catch (error) {
        console.error('Error fetching message history:', error);
        res.status(500).json({ error: 'Failed to fetch message history' });
    }
});


module.exports = { router, initializeChatBotRoutes };