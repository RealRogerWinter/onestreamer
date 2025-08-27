const express = require('express');
const router = express.Router();
const { authenticateToken, authenticateAdmin } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');

// Configure multer for audio file uploads
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit for audio files
    },
    fileFilter: (req, file, cb) => {
        const allowedMimes = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/m4a'];
        if (allowedMimes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only audio files are allowed.'));
        }
    }
});

// Get available TTS voices
router.get('/voices', (req, res) => {
    try {
        const soundFxService = req.app.get('soundFxService');
        const voices = soundFxService.getAvailableVoices();
        res.json(voices);
    } catch (error) {
        console.error('Error fetching TTS voices:', error);
        res.status(500).json({ error: 'Failed to fetch voices' });
    }
});

// Queue a TTS message
router.post('/tts', authenticateToken, async (req, res) => {
    try {
        const { text, voiceId = 'alloy', metadata = {} } = req.body;
        const soundFxService = req.app.get('soundFxService');
        
        if (!text || text.trim().length === 0) {
            return res.status(400).json({ error: 'Text is required' });
        }

        const ttsRequest = await soundFxService.queueTTS(
            req.user.id,
            req.user.username,
            text,
            voiceId,
            metadata
        );

        res.json({
            success: true,
            request: ttsRequest,
            queueStatus: soundFxService.getTTSQueueStatus()
        });
    } catch (error) {
        console.error('Error queueing TTS:', error);
        res.status(400).json({ error: error.message || 'Failed to queue TTS' });
    }
});

// Get TTS queue status
router.get('/tts/queue', authenticateToken, (req, res) => {
    try {
        const soundFxService = req.app.get('soundFxService');
        const status = soundFxService.getTTSQueueStatus();
        res.json(status);
    } catch (error) {
        console.error('Error fetching TTS queue status:', error);
        res.status(500).json({ error: 'Failed to fetch queue status' });
    }
});

// Clear TTS queue (admin only)
router.delete('/tts/queue', authenticateAdmin, (req, res) => {
    try {
        const soundFxService = req.app.get('soundFxService');
        const cleared = soundFxService.clearTTSQueue();
        res.json({ success: true, cleared });
    } catch (error) {
        console.error('Error clearing TTS queue:', error);
        res.status(500).json({ error: 'Failed to clear queue' });
    }
});

// Upload audio file
router.post('/upload', authenticateAdmin, upload.single('audio'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const soundFxService = req.app.get('soundFxService');
        const result = await soundFxService.uploadAudioFile(
            req.file.originalname,
            req.file.buffer
        );

        res.json({
            success: true,
            file: result
        });
    } catch (error) {
        console.error('Error uploading audio file:', error);
        res.status(400).json({ error: error.message || 'Failed to upload file' });
    }
});

// Get available sound files
router.get('/sounds', async (req, res) => {
    try {
        const soundFxService = req.app.get('soundFxService');
        const sounds = await soundFxService.getAvailableSounds();
        res.json(sounds);
    } catch (error) {
        console.error('Error fetching sounds:', error);
        res.status(500).json({ error: 'Failed to fetch sounds' });
    }
});

// Play an audio file
router.post('/play', authenticateToken, async (req, res) => {
    try {
        const { fileName, metadata = {} } = req.body;
        
        if (!fileName) {
            return res.status(400).json({ error: 'File name is required' });
        }

        const soundFxService = req.app.get('soundFxService');
        const effect = await soundFxService.playAudioFile(
            req.user.id,
            req.user.username,
            fileName,
            metadata
        );

        res.json({
            success: true,
            effect
        });
    } catch (error) {
        console.error('Error playing audio file:', error);
        res.status(400).json({ error: error.message || 'Failed to play audio' });
    }
});

// Stop a sound effect
router.post('/stop/:effectId', authenticateToken, (req, res) => {
    try {
        const soundFxService = req.app.get('soundFxService');
        const stopped = soundFxService.stopEffect(req.params.effectId);
        
        if (!stopped) {
            return res.status(404).json({ error: 'Effect not found' });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error stopping effect:', error);
        res.status(500).json({ error: 'Failed to stop effect' });
    }
});

// Stop all sound effects (admin only)
router.post('/stop-all', authenticateAdmin, (req, res) => {
    try {
        const soundFxService = req.app.get('soundFxService');
        const count = soundFxService.stopAllEffects();
        res.json({ success: true, stopped: count });
    } catch (error) {
        console.error('Error stopping all effects:', error);
        res.status(500).json({ error: 'Failed to stop effects' });
    }
});

// Proxy audio from 101soundboards to bypass CORS
router.get('/proxy/soundboard', async (req, res) => {
    try {
        const { url } = req.query;
        
        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }
        
        // Validate it's a 101soundboards URL
        if (!url.includes('101soundboards.com')) {
            return res.status(400).json({ error: 'Invalid soundboard URL' });
        }
        
        const axios = require('axios');
        
        // Fetch the audio file
        const response = await axios.get(url, {
            responseType: 'stream',
            headers: {
                'User-Agent': 'OneStreamer/1.0',
                'Referer': 'https://www.101soundboards.com'
            },
            timeout: 30000
        });
        
        // Set appropriate headers
        res.setHeader('Content-Type', response.headers['content-type'] || 'audio/mpeg');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.setHeader('Access-Control-Allow-Origin', '*');
        
        // Stream the audio to the client
        response.data.pipe(res);
    } catch (error) {
        console.error('Error proxying soundboard audio:', error.message);
        res.status(500).json({ error: 'Failed to fetch audio' });
    }
});

// Get active sound effects
router.get('/active', (req, res) => {
    try {
        const soundFxService = req.app.get('soundFxService');
        const effects = soundFxService.getActiveEffects();
        res.json(effects);
    } catch (error) {
        console.error('Error fetching active effects:', error);
        res.status(500).json({ error: 'Failed to fetch active effects' });
    }
});

// Serve audio files
router.get('/files/:fileName', async (req, res) => {
    try {
        const { fileName } = req.params;
        const soundFxService = req.app.get('soundFxService');
        const fs = require('fs').promises;
        
        // Sanitize filename
        const safeName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
        const filePath = path.join(__dirname, '..', 'audio', 'sounds', safeName);
        
        // Check if file exists
        try {
            await fs.access(filePath);
        } catch {
            return res.status(404).json({ error: 'Audio file not found' });
        }
        
        // Set appropriate headers
        const ext = path.extname(fileName).toLowerCase();
        const mimeTypes = {
            '.mp3': 'audio/mpeg',
            '.wav': 'audio/wav',
            '.ogg': 'audio/ogg',
            '.m4a': 'audio/mp4'
        };
        
        const mimeType = mimeTypes[ext] || 'audio/mpeg';
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        
        // Stream the file
        const stream = require('fs').createReadStream(filePath);
        stream.pipe(res);
    } catch (error) {
        console.error('Error serving audio file:', error);
        res.status(500).json({ error: 'Failed to serve audio file' });
    }
});

// Trigger 101soundboards item (from inventory use)
router.post('/item/soundboard', authenticateToken, async (req, res) => {
    try {
        const { itemId, soundUrl } = req.body;
        
        if (!itemId || !soundUrl) {
            return res.status(400).json({ error: 'Item ID and sound URL are required' });
        }

        const itemService = req.app.get('itemService');
        const inventoryService = req.app.get('inventoryService');
        const soundFxService = req.app.get('soundFxService');
        const streamService = req.app.get('streamService');

        // Validate item
        const item = await itemService.getItemById(itemId);
        if (!item || item.name !== '101soundboards') {
            return res.status(400).json({ error: 'Invalid soundboard item' });
        }

        // Check inventory
        const inventoryItem = await inventoryService.getInventoryItem(req.user.id, itemId);
        if (!inventoryItem || inventoryItem.quantity < 1) {
            return res.status(400).json({ error: 'Item not in inventory' });
        }

        // Validate item usage (cooldown)
        const validation = await itemService.validateItemUsage(req.user.id, itemId);
        if (!validation.valid) {
            return res.status(429).json({ 
                error: validation.error || 'Cannot use item',
                cooldownRemaining: validation.cooldownRemaining
            });
        }

        // Get stream status
        const streamStatus = streamService.getStreamStatus();
        const streamId = streamStatus.hasActiveStream ? streamStatus.streamerId : null;

        // Use the item
        const useResult = await inventoryService.useItem(req.user.id, itemId, streamId);

        // Queue the soundboard
        const soundboardRequest = await soundFxService.queue101Soundboard(
            req.user.id,
            req.user.username,
            soundUrl,
            {
                itemId,
                itemName: item.display_name,
                streamId
            }
        );

        // Emit socket events
        const io = req.app.get('io');
        if (io) {
            io.emit('item-used', {
                userId: req.user.id,
                username: req.user.username,
                item: useResult.item,
                streamId,
                soundboardData: {
                    soundUrl,
                    requestId: soundboardRequest.id
                }
            });
        }

        res.json({
            success: true,
            item: useResult.item,
            remainingQuantity: useResult.remainingQuantity,
            soundboardRequest,
            queueStatus: soundFxService.getSoundboardQueueStatus()
        });
    } catch (error) {
        console.error('Error using soundboard item:', error);
        res.status(500).json({ error: error.message || 'Failed to use soundboard item' });
    }
});

// Get soundboard queue status
router.get('/soundboard/queue', authenticateToken, (req, res) => {
    try {
        const soundFxService = req.app.get('soundFxService');
        const status = soundFxService.getSoundboardQueueStatus();
        res.json(status);
    } catch (error) {
        console.error('Error fetching soundboard queue status:', error);
        res.status(500).json({ error: 'Failed to fetch queue status' });
    }
});

// Clear soundboard queue (admin only)
router.delete('/soundboard/queue', authenticateAdmin, (req, res) => {
    try {
        const soundFxService = req.app.get('soundFxService');
        const cleared = soundFxService.clearSoundboardQueue();
        res.json({ success: true, cleared });
    } catch (error) {
        console.error('Error clearing soundboard queue:', error);
        res.status(500).json({ error: 'Failed to clear queue' });
    }
});

// Trigger TTS item (from inventory use)
router.post('/item/tts', authenticateToken, async (req, res) => {
    try {
        const { itemId, text, voiceId = 'alloy' } = req.body;
        
        if (!itemId || !text) {
            return res.status(400).json({ error: 'Item ID and text are required' });
        }

        const itemService = req.app.get('itemService');
        const inventoryService = req.app.get('inventoryService');
        const soundFxService = req.app.get('soundFxService');
        const streamService = req.app.get('streamService');

        // Validate item
        const item = await itemService.getItemById(itemId);
        if (!item || (item.name !== 'megaphone' && item.name !== 'tts_message')) {
            return res.status(400).json({ error: 'Invalid TTS item' });
        }

        // Check inventory
        const inventoryItem = await inventoryService.getInventoryItem(req.user.id, itemId);
        if (!inventoryItem || inventoryItem.quantity < 1) {
            return res.status(400).json({ error: 'Item not in inventory' });
        }

        // Validate item usage (cooldown)
        const validation = await itemService.validateItemUsage(req.user.id, itemId);
        if (!validation.valid) {
            return res.status(429).json({ 
                error: validation.error || 'Cannot use item',
                cooldownRemaining: validation.cooldownRemaining
            });
        }

        // Get stream status
        const streamStatus = streamService.getStreamStatus();
        const streamId = streamStatus.hasActiveStream ? streamStatus.streamerId : null;

        // Use the item
        const useResult = await inventoryService.useItem(req.user.id, itemId, streamId);

        // Queue the TTS
        const ttsRequest = await soundFxService.queueTTS(
            req.user.id,
            req.user.username,
            text,
            voiceId,
            {
                itemId,
                itemName: item.display_name,
                streamId
            }
        );

        // Emit socket events
        const io = req.app.get('io');
        if (io) {
            io.emit('item-used', {
                userId: req.user.id,
                username: req.user.username,
                item: useResult.item,
                streamId,
                ttsData: {
                    text,
                    voiceId,
                    requestId: ttsRequest.id
                }
            });
        }

        res.json({
            success: true,
            item: useResult.item,
            remainingQuantity: useResult.remainingQuantity,
            ttsRequest,
            queueStatus: soundFxService.getTTSQueueStatus()
        });
    } catch (error) {
        console.error('Error using TTS item:', error);
        res.status(500).json({ error: error.message || 'Failed to use TTS item' });
    }
});

module.exports = router;