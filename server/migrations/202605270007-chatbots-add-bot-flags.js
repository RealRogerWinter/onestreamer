/**
 * Per-bot toggles on chatbots:
 *
 * - use_assigned_name: render the assigned username (vs prompt-derived).
 * - llm_model: per-bot model override.
 * - moviebot_enabled: bot participates in the MovieBot transcription loop.
 * - vision_bot_enabled: bot opts into VisionBot screenshot commentary.
 */

'use strict';

const { addColumn } = require('./_runner');

function run(db, logger) {
    addColumn(db, 'chatbots', 'use_assigned_name', 'BOOLEAN DEFAULT 1', logger);
    addColumn(db, 'chatbots', 'llm_model', 'TEXT', logger);
    addColumn(db, 'chatbots', 'moviebot_enabled', 'BOOLEAN DEFAULT 0', logger);
    addColumn(db, 'chatbots', 'vision_bot_enabled', 'BOOLEAN DEFAULT 0', logger);
}

module.exports = { run };
