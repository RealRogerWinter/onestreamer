const path = require('path');
const fs = require('fs').promises;
const { EventEmitter } = require('events');
const axios = require('axios');
const https = require('https');

class SoundFxService extends EventEmitter {
    constructor() {
        super();
        this.audioDirectory = path.join(__dirname, '..', 'audio');
        this.ttsQueue = [];
        this.isProcessingTTS = false;
        this.ttsQueueDelay = 10000; // 10 seconds between TTS messages
        this.lastTTSTime = 0;
        this.availableVoices = [
            { id: 'alloy', name: 'Alloy', gender: 'neutral', description: 'Neutral, professional voice' },
            { id: 'echo', name: 'Echo', gender: 'male', description: 'Male, warm voice' },
            { id: 'fable', name: 'Fable', gender: 'neutral', description: 'British accent' },
            { id: 'onyx', name: 'Onyx', gender: 'male', description: 'Deep male voice' },
            { id: 'nova', name: 'Nova', gender: 'female', description: 'Female, energetic voice' },
            { id: 'shimmer', name: 'Shimmer', gender: 'female', description: 'Soft female voice' }
        ];
        this.activeAudioEffects = new Map();
        this.soundboardQueue = [];
        this.isProcessingSoundboard = false;
        this.soundboardQueueDelay = 2000; // 2 seconds between soundboard sounds
        this.lastSoundboardTime = 0;
        this.initializeService();
    }

    async initializeService() {
        try {
            await fs.mkdir(this.audioDirectory, { recursive: true });
            const soundsDir = path.join(this.audioDirectory, 'sounds');
            await fs.mkdir(soundsDir, { recursive: true });
            console.log('✅ SOUNDFX: Service initialized successfully');
        } catch (error) {
            console.error('❌ SOUNDFX: Failed to initialize service:', error);
        }
    }

    getAvailableVoices() {
        return this.availableVoices;
    }

    async queueTTS(userId, username, text, voiceId = 'alloy', metadata = {}) {
        if (!text || text.trim().length === 0) {
            throw new Error('Text is required for TTS');
        }

        if (text.length > 200) {
            throw new Error('Text is too long (max 200 characters)');
        }

        const voice = this.availableVoices.find(v => v.id === voiceId);
        if (!voice) {
            throw new Error(`Invalid voice ID: ${voiceId}`);
        }

        const ttsRequest = {
            id: `tts_${userId}_${Date.now()}`,
            userId,
            username,
            text: text.trim(),
            voiceId,
            voice,
            timestamp: Date.now(),
            status: 'queued',
            metadata
        };

        this.ttsQueue.push(ttsRequest);
        console.log(`🎤 SOUNDFX: TTS queued - User: ${username}, Voice: ${voice.name}, Text: "${text}"`);

        this.emit('tts-queued', ttsRequest);

        if (!this.isProcessingTTS) {
            this.processTTSQueue();
        }

        return ttsRequest;
    }

    async processTTSQueue() {
        if (this.isProcessingTTS || this.ttsQueue.length === 0) {
            return;
        }

        this.isProcessingTTS = true;

        while (this.ttsQueue.length > 0) {
            const currentTime = Date.now();
            const timeSinceLastTTS = currentTime - this.lastTTSTime;
            
            if (timeSinceLastTTS < this.ttsQueueDelay && this.lastTTSTime > 0) {
                const waitTime = this.ttsQueueDelay - timeSinceLastTTS;
                console.log(`⏳ SOUNDFX: Waiting ${waitTime}ms before next TTS`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }

            const ttsRequest = this.ttsQueue.shift();
            ttsRequest.status = 'processing';

            try {
                await this.processTTSRequest(ttsRequest);
                this.lastTTSTime = Date.now();
                ttsRequest.status = 'completed';
                this.emit('tts-completed', ttsRequest);
            } catch (error) {
                console.error(`❌ SOUNDFX: Failed to process TTS:`, error);
                ttsRequest.status = 'failed';
                ttsRequest.error = error.message;
                this.emit('tts-failed', ttsRequest);
            }
        }

        this.isProcessingTTS = false;
    }

    async processTTSRequest(ttsRequest) {
        console.log(`🔊 SOUNDFX: Processing TTS - User: ${ttsRequest.username}, Voice: ${ttsRequest.voice.name}`);
        
        // Send TTS message to chat
        await this.sendTTSToChat(ttsRequest.username, ttsRequest.text);
        
        const audioData = await this.generateTTSAudio(ttsRequest.text, ttsRequest.voiceId);
        
        const soundEffect = {
            id: ttsRequest.id,
            type: 'tts',
            userId: ttsRequest.userId,
            username: ttsRequest.username,
            voiceId: ttsRequest.voiceId,
            voice: ttsRequest.voice,
            text: ttsRequest.text,
            audioData: audioData,
            duration: this.estimateTTSDuration(ttsRequest.text),
            timestamp: Date.now()
        };

        this.emit('sound-effect', soundEffect);

        await this.broadcastSoundEffect(soundEffect);

        return soundEffect;
    }

    async sendTTSToChat(username, text) {
        try {
            // Use 127.0.0.1 instead of localhost to avoid IPv6 issues
            const chatServiceUrl = process.env.CHAT_SERVICE_URL || 'http://127.0.0.1:8081';
            const formattedMessage = `📢 ${username} TTS: ${text}`;
            
            console.log(`📤 SOUNDFX: Sending TTS to chat at ${chatServiceUrl}/api/system-message`);
            
            // Create axios config with HTTPS agent for self-signed certificates
            const axiosConfig = {
                timeout: 5000
            };
            
            // If using HTTPS, add agent to accept self-signed certificates
            if (chatServiceUrl.startsWith('https')) {
                axiosConfig.httpsAgent = new https.Agent({
                    rejectUnauthorized: false
                });
            }
            
            const response = await axios.post(`${chatServiceUrl}/api/system-message`, {
                message: formattedMessage,
                username: '🤖 StreamBot',
                type: 'tts'
            }, axiosConfig);
            
            console.log(`💬 SOUNDFX: TTS message sent to chat - ${username}: ${text}`);
            console.log(`✅ SOUNDFX: Chat response:`, response.data);
        } catch (error) {
            console.error('❌ SOUNDFX: Failed to send TTS to chat:', error.message);
            console.error('❌ SOUNDFX: Error details:', {
                url: error.config?.url,
                method: error.config?.method,
                data: error.config?.data
            });
            // Don't throw - chat integration failure shouldn't stop TTS playback
        }
    }

    async generateTTSAudio(text, voiceId) {
        // Using Web Speech API through client-side synthesis
        // Server will coordinate but actual synthesis happens on client
        return {
            text,
            voiceId,
            method: 'client-synthesis'
        };
    }

    estimateTTSDuration(text) {
        const wordsPerMinute = 150;
        const wordCount = text.split(/\s+/).length;
        const durationSeconds = (wordCount / wordsPerMinute) * 60;
        return Math.max(1, Math.ceil(durationSeconds)) * 1000;
    }

    async playAudioFile(userId, username, fileName, metadata = {}) {
        const filePath = path.join(this.audioDirectory, 'sounds', fileName);
        
        try {
            await fs.access(filePath);
        } catch (error) {
            throw new Error(`Audio file not found: ${fileName}`);
        }

        const soundEffect = {
            id: `audio_${userId}_${Date.now()}`,
            type: 'audio-file',
            userId,
            username,
            fileName,
            filePath,
            timestamp: Date.now(),
            metadata
        };

        console.log(`🔊 SOUNDFX: Playing audio file - User: ${username}, File: ${fileName}`);
        
        this.emit('sound-effect', soundEffect);
        await this.broadcastSoundEffect(soundEffect);

        return soundEffect;
    }

    async uploadAudioFile(fileName, buffer) {
        const allowedExtensions = ['.mp3', '.wav', '.ogg', '.m4a'];
        const ext = path.extname(fileName).toLowerCase();
        
        if (!allowedExtensions.includes(ext)) {
            throw new Error(`Invalid file type. Allowed: ${allowedExtensions.join(', ')}`);
        }

        const maxSize = 5 * 1024 * 1024; // 5MB
        if (buffer.length > maxSize) {
            throw new Error('File too large. Maximum size: 5MB');
        }

        const safeName = `${Date.now()}_${fileName.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
        const filePath = path.join(this.audioDirectory, 'sounds', safeName);

        await fs.writeFile(filePath, buffer);
        console.log(`📁 SOUNDFX: Audio file uploaded: ${safeName}`);

        return {
            fileName: safeName,
            originalName: fileName,
            size: buffer.length,
            path: filePath
        };
    }

    async getAvailableSounds() {
        try {
            const soundsDir = path.join(this.audioDirectory, 'sounds');
            const files = await fs.readdir(soundsDir);
            
            const sounds = [];
            for (const file of files) {
                const filePath = path.join(soundsDir, file);
                const stats = await fs.stat(filePath);
                
                if (stats.isFile()) {
                    sounds.push({
                        fileName: file,
                        size: stats.size,
                        uploadedAt: stats.birthtime
                    });
                }
            }

            return sounds;
        } catch (error) {
            console.error('❌ SOUNDFX: Failed to get available sounds:', error);
            return [];
        }
    }

    async broadcastSoundEffect(soundEffect) {
        const io = this.io;
        if (!io) {
            console.warn('⚠️ SOUNDFX: Socket.IO not initialized, cannot broadcast');
            return;
        }

        io.emit('sound-effect-play', soundEffect);
        console.log(`📢 SOUNDFX: Broadcasted sound effect to all clients`);
    }

    setSocketIO(io) {
        this.io = io;
        console.log('✅ SOUNDFX: Socket.IO integration configured');
    }

    getTTSQueueStatus() {
        return {
            queueLength: this.ttsQueue.length,
            isProcessing: this.isProcessingTTS,
            queueDelay: this.ttsQueueDelay,
            lastTTSTime: this.lastTTSTime
        };
    }

    clearTTSQueue() {
        const cleared = this.ttsQueue.length;
        this.ttsQueue = [];
        console.log(`🗑️ SOUNDFX: Cleared ${cleared} TTS requests from queue`);
        return cleared;
    }

    async triggerItemSound(userId, itemId, itemData, metadata = {}) {
        const soundMapping = {
            'tomato': 'splat.mp3',
            'confetti_cannon': 'party.mp3',
            'disco_ball': 'disco.mp3',
            'freeze_frame': 'freeze.mp3',
            'smoke_bomb': 'smoke.mp3'
        };

        const soundFile = soundMapping[itemData.name];
        
        if (soundFile) {
            try {
                return await this.playAudioFile(
                    userId,
                    metadata.username || 'Unknown',
                    soundFile,
                    { itemId, itemName: itemData.name, ...metadata }
                );
            } catch (error) {
                console.log(`📢 SOUNDFX: No audio file for item ${itemData.name}, skipping`);
            }
        }

        return null;
    }

    getActiveEffects() {
        return Array.from(this.activeAudioEffects.values());
    }

    stopEffect(effectId) {
        if (this.activeAudioEffects.has(effectId)) {
            const effect = this.activeAudioEffects.get(effectId);
            this.activeAudioEffects.delete(effectId);
            
            this.emit('sound-effect-stop', { effectId, effect });
            
            if (this.io) {
                this.io.emit('sound-effect-stop', { effectId });
            }
            
            console.log(`⏹️ SOUNDFX: Stopped effect ${effectId}`);
            return true;
        }
        return false;
    }

    stopAllEffects() {
        const count = this.activeAudioEffects.size;
        this.activeAudioEffects.clear();
        
        if (this.io) {
            this.io.emit('sound-effect-stop-all');
        }
        
        console.log(`⏹️ SOUNDFX: Stopped all ${count} active effects`);
        return count;
    }

    async queue101Soundboard(userId, username, soundUrl, metadata = {}) {
        if (!soundUrl) {
            throw new Error('Sound URL is required');
        }

        const soundboardRequest = {
            id: `soundboard_${userId}_${Date.now()}`,
            userId,
            username,
            soundUrl,
            timestamp: Date.now(),
            status: 'queued',
            metadata
        };

        this.soundboardQueue.push(soundboardRequest);
        console.log(`📣 SOUNDFX: 101soundboards queued - User: ${username}, URL: ${soundUrl}`);

        this.emit('soundboard-queued', soundboardRequest);

        if (!this.isProcessingSoundboard) {
            this.processSoundboardQueue();
        }

        return soundboardRequest;
    }

    async processSoundboardQueue() {
        if (this.isProcessingSoundboard || this.soundboardQueue.length === 0) {
            return;
        }

        this.isProcessingSoundboard = true;

        while (this.soundboardQueue.length > 0) {
            const currentTime = Date.now();
            const timeSinceLastSound = currentTime - this.lastSoundboardTime;
            
            if (timeSinceLastSound < this.soundboardQueueDelay && this.lastSoundboardTime > 0) {
                const waitTime = this.soundboardQueueDelay - timeSinceLastSound;
                console.log(`⏳ SOUNDFX: Waiting ${waitTime}ms before next soundboard`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }

            const request = this.soundboardQueue.shift();
            request.status = 'processing';

            try {
                await this.processSoundboardRequest(request);
                this.lastSoundboardTime = Date.now();
                request.status = 'completed';
                this.emit('soundboard-completed', request);
            } catch (error) {
                console.error(`❌ SOUNDFX: Failed to process soundboard:`, error);
                request.status = 'failed';
                request.error = error.message;
                this.emit('soundboard-failed', request);
            }
        }

        this.isProcessingSoundboard = false;
    }

    async processSoundboardRequest(request) {
        console.log(`🔊 SOUNDFX: Processing 101soundboard - User: ${request.username}, URL: ${request.soundUrl}`);
        
        // Parse the URL to extract sound info
        const soundInfo = await this.parse101SoundboardUrl(request.soundUrl);
        
        if (!soundInfo) {
            throw new Error('Invalid 101soundboards URL');
        }

        // Fetch the actual sound file URL from the API
        const soundData = await this.fetch101SoundboardData(soundInfo.soundId);
        
        if (!soundData || !soundData.sound_file_url) {
            throw new Error('Failed to fetch sound data from 101soundboards');
        }

        // Apply 60-second duration limit
        const maxDuration = 60000; // 60 seconds in milliseconds
        const actualDuration = soundData.sound_duration || 0;
        const limitedDuration = Math.min(actualDuration, maxDuration);

        // Create a proxy URL to bypass CORS
        const proxyUrl = `/api/soundfx/proxy/soundboard?url=${encodeURIComponent(soundData.sound_file_url)}`;
        
        const soundEffect = {
            id: request.id,
            type: '101soundboard',
            userId: request.userId,
            username: request.username,
            soundUrl: request.soundUrl,
            soundFileUrl: proxyUrl,  // Use proxy URL instead of direct URL
            originalFileUrl: soundData.sound_file_url,  // Keep original for reference
            soundName: soundData.sound_transcript || 'Unknown Sound',
            boardName: soundData.board?.board_title || 'Unknown Board',
            duration: limitedDuration,
            maxDuration: maxDuration,
            timestamp: Date.now(),
            metadata: request.metadata
        };

        // Send to chat
        await this.sendSoundboardToChat(request.username, soundEffect.soundName, soundEffect.boardName);

        this.emit('sound-effect', soundEffect);
        await this.broadcastSoundEffect(soundEffect);

        return soundEffect;
    }

    async parse101SoundboardUrl(url) {
        try {
            // Handle different URL formats
            // Example: https://www.101soundboards.com/sounds/188391-potato
            // Or: /sounds/188391-potato
            const soundMatch = url.match(/\/sounds\/(\d+)(?:-[^\/]*)?/);
            if (soundMatch) {
                return {
                    soundId: soundMatch[1]
                };
            }
            return null;
        } catch (error) {
            console.error('❌ SOUNDFX: Failed to parse 101soundboards URL:', error);
            return null;
        }
    }

    async fetch101SoundboardData(soundId) {
        try {
            // Use the API endpoint to fetch sound data
            const apiUrl = `https://www.101soundboards.com/api/v1/sounds/${soundId}`;
            
            console.log(`🌐 SOUNDFX: Fetching from 101soundboards API: ${apiUrl}`);
            
            const response = await axios.get(apiUrl, {
                headers: {
                    'User-Agent': 'OneStreamer/1.0',
                    'Accept': 'application/json'
                },
                timeout: 10000
            });

            if (response.data) {
                // Convert relative URLs to absolute if needed
                const data = response.data;
                if (data.sound_file_url && !data.sound_file_url.startsWith('http')) {
                    data.sound_file_url = `https://www.101soundboards.com${data.sound_file_url}`;
                }
                return data;
            }
            
            return null;
        } catch (error) {
            console.error('❌ SOUNDFX: Failed to fetch from 101soundboards:', error.message);
            return null;
        }
    }

    async sendSoundboardToChat(username, soundName, boardName) {
        try {
            const chatServiceUrl = process.env.CHAT_SERVICE_URL || 'http://127.0.0.1:8081';
            const formattedMessage = `🔊 ${username} played: "${soundName}" from ${boardName}\n🎵 Browse more sounds at https://www.101soundboards.com`;
            
            console.log(`📤 SOUNDFX: Sending soundboard to chat at ${chatServiceUrl}/api/system-message`);
            
            const axiosConfig = {
                timeout: 5000
            };
            
            if (chatServiceUrl.startsWith('https')) {
                axiosConfig.httpsAgent = new https.Agent({
                    rejectUnauthorized: false
                });
            }
            
            const response = await axios.post(`${chatServiceUrl}/api/system-message`, {
                message: formattedMessage,
                username: '🤖 StreamBot',
                type: 'soundboard'
            }, axiosConfig);
            
            console.log(`💬 SOUNDFX: Soundboard message sent to chat`);
        } catch (error) {
            console.error('❌ SOUNDFX: Failed to send soundboard to chat:', error.message);
            // Don't throw - chat integration failure shouldn't stop sound playback
        }
    }

    getSoundboardQueueStatus() {
        return {
            queueLength: this.soundboardQueue.length,
            isProcessing: this.isProcessingSoundboard,
            queueDelay: this.soundboardQueueDelay,
            lastSoundTime: this.lastSoundboardTime
        };
    }

    clearSoundboardQueue() {
        const cleared = this.soundboardQueue.length;
        this.soundboardQueue = [];
        console.log(`🗑️ SOUNDFX: Cleared ${cleared} soundboard requests from queue`);
        return cleared;
    }
}

module.exports = SoundFxService;