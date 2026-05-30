/**
 * MessageStore.js - StreamBot settings + canned-message persistence extracted
 * from StreamBotService.
 *
 * Wraps the node-sqlite3 `db` (owner.db) for the streambot_settings and
 * streambot_messages tables. Bodies moved verbatim from the service (only
 * `this.`→`owner.`); cross-method calls route through `owner.<method>` so the
 * service's delegators (and test spies) stay live.
 */

class MessageStore {
    constructor(owner) {
        this.owner = owner;
    }

    async getSettings() {
        const owner = this.owner;
        return new Promise((resolve, reject) => {
            owner.db.get(
                'SELECT * FROM streambot_settings LIMIT 1',
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                }
            );
        });
    }

    async updateSettings(updates) {
        const owner = this.owner;
        const fields = [];
        const values = [];

        for (const [key, value] of Object.entries(updates)) {
            fields.push(`${key} = ?`);
            values.push(value);
        }

        if (fields.length === 0) return;

        fields.push('updated_at = CURRENT_TIMESTAMP');

        return new Promise((resolve, reject) => {
            owner.db.run(
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
        const owner = this.owner;
        return new Promise((resolve, reject) => {
            owner.db.all(
                'SELECT * FROM streambot_messages ORDER BY order_index ASC',
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    async getEnabledMessages() {
        const owner = this.owner;
        return new Promise((resolve, reject) => {
            owner.db.all(
                'SELECT * FROM streambot_messages WHERE enabled = 1 ORDER BY order_index ASC',
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    async getMessage(id) {
        const owner = this.owner;
        return new Promise((resolve, reject) => {
            owner.db.get(
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
        const owner = this.owner;
        // If no order index provided, add to the end
        if (orderIndex === null || orderIndex === undefined) {
            const messages = await owner.getMessages();
            orderIndex = messages.length;
        }

        return new Promise((resolve, reject) => {
            owner.db.run(
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
        const owner = this.owner;
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
            owner.db.run(
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
        const owner = this.owner;
        return new Promise((resolve, reject) => {
            owner.db.run(
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
        const owner = this.owner;
        // Update order_index for all messages based on the array order
        const promises = messageIds.map((id, index) => {
            return owner.updateMessage(id, { order_index: index });
        });

        return Promise.all(promises);
    }

    async toggleMessage(id) {
        const owner = this.owner;
        const message = await owner.getMessage(id);
        if (!message) throw new Error('Message not found');

        return owner.updateMessage(id, { enabled: message.enabled ? 0 : 1 });
    }
}

module.exports = MessageStore;
