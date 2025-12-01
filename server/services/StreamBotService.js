const EventEmitter = require('events');
const https = require('https');
const axios = require('axios');

class StreamBotService extends EventEmitter {
    constructor(database) {
        super();
        // Handle both direct sqlite3 database and wrapper object
        this.db = database.db || database;
        this.intervalId = null;
        this.isInitialized = false;
        this.chatServiceUrl = process.env.CHAT_SERVICE_URL || 'https://127.0.0.1:8444';
    }

    async initialize() {
        if (this.isInitialized) return;
        
        console.log('🤖 Initializing StreamBot Service...');
        
        // Start the periodic message system
        await this.startPeriodicMessages();
        
        this.isInitialized = true;
        console.log('✅ StreamBot Service initialized');
    }

    async startPeriodicMessages() {
        // Clear any existing interval
        if (this.intervalId) {
            clearInterval(this.intervalId);
        }

        // Get settings
        const settings = await this.getSettings();
        
        if (!settings || !settings.enabled) {
            console.log('🤖 StreamBot periodic messages are disabled');
            return;
        }

        console.log(`🤖 Starting StreamBot periodic messages (interval: ${settings.interval_minutes} minutes)`);
        
        // Send a message immediately if it's been long enough
        const lastSent = settings.last_sent_at ? new Date(settings.last_sent_at) : null;
        const now = new Date();
        const minutesSinceLastSent = lastSent ? (now - lastSent) / 1000 / 60 : Infinity;
        
        if (minutesSinceLastSent >= settings.interval_minutes) {
            await this.sendNextMessage();
        }

        // Set up the interval
        this.intervalId = setInterval(async () => {
            await this.sendNextMessage();
        }, settings.interval_minutes * 60 * 1000);
    }

    async stopPeriodicMessages() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
            console.log('🤖 StreamBot periodic messages stopped');
        }
    }

    async sendToChatService(message) {
        try {
            const agent = new https.Agent({  
                rejectUnauthorized: false // Allow self-signed certificates
            });

            const response = await axios.post(
                `${this.chatServiceUrl}/api/system-message`,
                {
                    message: message,
                    username: '🤖 StreamBot'
                },
                {
                    httpsAgent: agent,
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (response.data.success) {
                console.log('📨 StreamBot message sent to chat service successfully');
            }
        } catch (error) {
            console.error('❌ Failed to send StreamBot message to chat:', error.message);
            // Also emit locally as fallback
            this.emit('sendMessage', message);
        }
    }

    async sendNextMessage() {
        try {
            const settings = await this.getSettings();
            if (!settings || !settings.enabled) return;

            // Get enabled messages ordered by order_index
            const messages = await this.getEnabledMessages();
            if (messages.length === 0) {
                console.log('🤖 No enabled StreamBot messages to send');
                return;
            }

            // Get the current message index and wrap around if necessary
            let currentIndex = settings.current_message_index || 0;
            if (currentIndex >= messages.length) {
                currentIndex = 0;
            }

            const message = messages[currentIndex];
            
            // Send message to chat service via HTTP
            await this.sendToChatService(message.message);
            
            console.log(`🤖 StreamBot sent message ${currentIndex + 1}/${messages.length}: "${message.message.substring(0, 50)}..."`);

            // Update the index and last sent time
            const nextIndex = (currentIndex + 1) % messages.length;
            await this.updateSettings({
                current_message_index: nextIndex,
                last_sent_at: new Date().toISOString()
            });

        } catch (error) {
            console.error('❌ Error sending StreamBot message:', error);
        }
    }

    // Database methods
    async getSettings() {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT * FROM streambot_settings LIMIT 1',
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                }
            );
        });
    }

    async updateSettings(updates) {
        const fields = [];
        const values = [];
        
        for (const [key, value] of Object.entries(updates)) {
            fields.push(`${key} = ?`);
            values.push(value);
        }
        
        if (fields.length === 0) return;
        
        fields.push('updated_at = CURRENT_TIMESTAMP');
        
        return new Promise((resolve, reject) => {
            this.db.run(
                `UPDATE streambot_settings SET ${fields.join(', ')} WHERE id = 1`,
                values,
                function(err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    }

    async getMessages() {
        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT * FROM streambot_messages ORDER BY order_index ASC',
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    async getEnabledMessages() {
        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT * FROM streambot_messages WHERE enabled = 1 ORDER BY order_index ASC',
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    async getMessage(id) {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT * FROM streambot_messages WHERE id = ?',
                [id],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                }
            );
        });
    }

    async createMessage(message, orderIndex = null) {
        // If no order index provided, add to the end
        if (orderIndex === null || orderIndex === undefined) {
            const messages = await this.getMessages();
            orderIndex = messages.length;
        }

        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT INTO streambot_messages (message, enabled, order_index) VALUES (?, 1, ?)',
                [message, orderIndex],
                function(err) {
                    if (err) reject(err);
                    else resolve({ id: this.lastID, message, enabled: 1, order_index: orderIndex });
                }
            );
        });
    }

    async updateMessage(id, updates) {
        const fields = [];
        const values = [];
        
        for (const [key, value] of Object.entries(updates)) {
            if (key !== 'id') {
                fields.push(`${key} = ?`);
                values.push(value);
            }
        }
        
        if (fields.length === 0) return;
        
        fields.push('updated_at = CURRENT_TIMESTAMP');
        values.push(id);
        
        return new Promise((resolve, reject) => {
            this.db.run(
                `UPDATE streambot_messages SET ${fields.join(', ')} WHERE id = ?`,
                values,
                function(err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    }

    async deleteMessage(id) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'DELETE FROM streambot_messages WHERE id = ?',
                [id],
                function(err) {
                    if (err) reject(err);
                    else {
                        // Reorder remaining messages
                        resolve(this.changes);
                    }
                }
            );
        });
    }

    async reorderMessages(messageIds) {
        // Update order_index for all messages based on the array order
        const promises = messageIds.map((id, index) => {
            return this.updateMessage(id, { order_index: index });
        });
        
        return Promise.all(promises);
    }

    async toggleMessage(id) {
        const message = await this.getMessage(id);
        if (!message) throw new Error('Message not found');
        
        return this.updateMessage(id, { enabled: message.enabled ? 0 : 1 });
    }

    // Settings management
    async setInterval(minutes) {
        await this.updateSettings({ interval_minutes: minutes });
        // Restart the periodic messages with new interval
        await this.startPeriodicMessages();
    }

    async toggleEnabled() {
        const settings = await this.getSettings();
        const newEnabled = settings.enabled ? 0 : 1;
        
        await this.updateSettings({ enabled: newEnabled });
        
        if (newEnabled) {
            await this.startPeriodicMessages();
        } else {
            await this.stopPeriodicMessages();
        }
        
        return newEnabled;
    }
}

module.exports = StreamBotService;