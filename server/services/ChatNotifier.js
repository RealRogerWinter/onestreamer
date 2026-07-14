// server/services/ChatNotifier.js
//
// Thin wrapper around the chat microservice's POST /api/system-message endpoint.
// Extracted from server/routes/items.js (PR-J3) so that DrawingService,
// ThrowingService, and ItemUseService can share one injected dependency for
// system-chat broadcasts instead of each route file having to pass an
// items.js-local `sendSystemMessage` helper around.
//
// Behaviour is byte-equivalent to the original helper in items.js: same URL,
// same payload shape, same self-signed TLS bypass, same 5s timeout, same
// log lines, same swallow-on-failure semantics (returns null).

const axios = require('axios');
const https = require('https');
// CH3: attaches the X-Internal-Secret header to chat-service calls.
const { chatAxiosConfig } = require('../utils/chatServiceClient');

const logger = require('../bootstrap/logger').child({ svc: 'ChatNotifier' });
class ChatNotifier {
    /**
     * @param {object} [opts]
     * @param {string} [opts.chatServiceUrl] override CHAT_SERVICE_URL (env-aware default)
     * @param {object} [opts.httpsAgent]     custom https.Agent (test seam)
     * @param {object} [opts.axiosInstance]  custom axios instance (test seam)
     */
    constructor(opts = {}) {
        this.chatServiceUrl = opts.chatServiceUrl
            || process.env.CHAT_SERVICE_URL
            || 'https://127.0.0.1:8444';

        this.httpsAgent = opts.httpsAgent || new https.Agent({
            rejectUnauthorized: false // Allow self-signed certificates for local HTTPS
        });

        this.axios = opts.axiosInstance || axios;

        // Bind so callers can pass `notifier.send` directly as a function value
        // (matches the old `sendSystemMessage` callsite ergonomics).
        this.send = this.send.bind(this);
    }

    /**
     * Send a system message to the chat microservice.
     *
     * Failures are logged and swallowed (returns null) — matches the original
     * helper. Throwing here would break item-use side-effects that fire after
     * the chat broadcast.
     *
     * @param {string} message
     * @param {string} [username='🤖 StreamBot']
     * @returns {Promise<any|null>} chat service response body, or null on failure
     */
    async send(message, username = '🤖 StreamBot') {
        try {
            // Add timestamp and call stack to debug duplicate messages
            const timestamp = Date.now();
            const stack = new Error().stack.split('\n')[2].trim();
            logger.debug(`📤 CHAT: Attempting to send message at ${timestamp}: "${message}" from ${stack}`);

            const response = await this.axios.post(`${this.chatServiceUrl}/api/system-message`, {
                message,
                username
            }, chatAxiosConfig(this.chatServiceUrl, {
                timeout: 5000,
                httpsAgent: this.httpsAgent
            }));

            logger.debug(`✅ CHAT: System message sent successfully at ${timestamp}: "${message}"`);
            return response.data;
        } catch (error) {
            logger.error(`❌ CHAT: Failed to send system message:`, error.message);
            logger.error(`❌ CHAT: URL attempted: ${this.chatServiceUrl}/api/system-message`);
            return null;
        }
    }
}

module.exports = ChatNotifier;
