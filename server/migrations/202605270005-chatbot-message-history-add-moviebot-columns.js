/**
 * Extend chatbot_message_history for MovieBot logging.
 *
 * - exact_prompt: the literal prompt the LLM saw (for replay/debug).
 * - message_type: 'chat' | 'moviebot' | ... — tags which bot loop produced it.
 * - content: alias for `message`, kept for the MovieBot ingest shape.
 * - metadata: JSON sidecar (e.g. timing, model, token counts).
 */

'use strict';

const { addColumn } = require('./_runner');

function run(db, logger) {
    addColumn(db, 'chatbot_message_history', 'exact_prompt', 'TEXT', logger);
    addColumn(db, 'chatbot_message_history', 'message_type', "TEXT DEFAULT 'chat'", logger);
    addColumn(db, 'chatbot_message_history', 'content', 'TEXT', logger);
    addColumn(db, 'chatbot_message_history', 'metadata', 'TEXT', logger);
}

module.exports = { run };
