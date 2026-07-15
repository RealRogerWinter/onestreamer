/**
 * PeriodicMessageScheduler.js - StreamBot periodic-message loop extracted from
 * StreamBotService.
 *
 * Owns the start/stop of the canned-message interval, the cursor-advancing
 * send, and the HTTP post to the chat service. All timer/cursor state stays on
 * the service (owner.intervalId, owner.chatServiceUrl). Bodies moved verbatim
 * (only `this.`→`owner.`); cross-calls route through `owner.<method>` so the
 * service's delegators (and test spies) stay live.
 */

const axios = require('axios');
// CH3: attaches the X-Internal-Secret header (+ https agent + 5s timeout —
// this call site previously had NO timeout) to chat-service calls.
const { chatAxiosConfig } = require('../../utils/chatServiceClient');

const logger = require('../../bootstrap/logger').child({ svc: 'StreamBotService' });

class PeriodicMessageScheduler {
    constructor(owner) {
        this.owner = owner;
    }

    async startPeriodicMessages() {
        const owner = this.owner;
        // Clear any existing interval
        if (owner.intervalId) {
            clearInterval(owner.intervalId);
        }

        // Get settings
        const settings = await owner.getSettings();

        if (!settings || !settings.enabled) {
            logger.debug('🤖 StreamBot periodic messages are disabled');
            return;
        }

        logger.debug(`🤖 Starting StreamBot periodic messages (interval: ${settings.interval_minutes} minutes)`);

        // Send a message immediately if it's been long enough
        const lastSent = settings.last_sent_at ? new Date(settings.last_sent_at) : null;
        const now = new Date();
        const minutesSinceLastSent = lastSent ? (now - lastSent) / 1000 / 60 : Infinity;

        if (minutesSinceLastSent >= settings.interval_minutes) {
            await owner.sendNextMessage();
        }

        // Set up the interval
        owner.intervalId = setInterval(async () => {
            await owner.sendNextMessage();
        }, settings.interval_minutes * 60 * 1000);
    }

    async stopPeriodicMessages() {
        const owner = this.owner;
        if (owner.intervalId) {
            clearInterval(owner.intervalId);
            owner.intervalId = null;
            logger.debug('🤖 StreamBot periodic messages stopped');
        }
    }

    async sendToChatService(message) {
        const owner = this.owner;
        try {
            const response = await axios.post(
                `${owner.chatServiceUrl}/api/system-message`,
                {
                    message: message,
                    username: '🤖 StreamBot'
                },
                chatAxiosConfig(owner.chatServiceUrl, {
                    headers: {
                        'Content-Type': 'application/json'
                    }
                })
            );

            if (response.data.success) {
                logger.debug('📨 StreamBot message sent to chat service successfully');
            }
        } catch (error) {
            logger.error('❌ Failed to send StreamBot message to chat:', error.message);
            // Also emit locally as fallback
            owner.emit('sendMessage', message);
        }
    }

    async sendNextMessage() {
        const owner = this.owner;
        try {
            const settings = await owner.getSettings();
            if (!settings || !settings.enabled) return;

            // Get enabled messages ordered by order_index
            const messages = await owner.getEnabledMessages();
            if (messages.length === 0) {
                logger.debug('🤖 No enabled StreamBot messages to send');
                return;
            }

            // Get the current message index and wrap around if necessary
            let currentIndex = settings.current_message_index || 0;
            if (currentIndex >= messages.length) {
                currentIndex = 0;
            }

            const message = messages[currentIndex];

            // Send message to chat service via HTTP
            await owner.sendToChatService(message.message);

            logger.debug(`🤖 StreamBot sent message ${currentIndex + 1}/${messages.length}: "${message.message.substring(0, 50)}..."`);

            // Update the index and last sent time
            const nextIndex = (currentIndex + 1) % messages.length;
            await owner.updateSettings({
                current_message_index: nextIndex,
                last_sent_at: new Date().toISOString()
            });

        } catch (error) {
            logger.error('❌ Error sending StreamBot message:', error);
        }
    }
}

module.exports = PeriodicMessageScheduler;
