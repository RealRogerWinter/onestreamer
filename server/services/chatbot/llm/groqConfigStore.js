// Groq config persistence + enable/disable/update for ChatBotLLMService.
// The Groq settings live on the host service instance; these helpers read and
// mutate that `state` object (the service) and persist it to the groq_config
// table. Passed `database` for db access and `logger` for diagnostics.

function loadGroqConfig(state, database, logger) {
    try {
        // Use database module directly
        const db = database.db;
        if (!db) {
            logger.debug('⚠️ ChatBotLLMService: Database not ready for Groq config');
            return;
        }

        db.get(`SELECT * FROM groq_config WHERE id = 1`, (err, row) => {
            if (err) {
                logger.error('❌ ChatBotLLMService: Error loading Groq config:', err);
                return;
            }

            if (row) {
                state.groqEnabled = row.enabled === 1;
                state.groqApiKey = row.api_key || null;
                state.groqModel = row.model || 'llama-3.1-8b-instant';

                if (state.groqEnabled && state.groqApiKey) {
                    logger.debug('✅ ChatBotLLMService: Groq API enabled from database');
                } else {
                    logger.debug('📝 ChatBotLLMService: Groq API disabled or no API key');
                }
            } else {
                logger.debug('📝 ChatBotLLMService: No Groq config found in database');
            }
        });
    } catch (error) {
        logger.error('❌ ChatBotLLMService: Error loading Groq config:', error);
    }
}

function saveGroqConfig(state, database, logger) {
    try {
        const db = database.db;
        if (!db) {
            logger.debug('⚠️ ChatBotLLMService: Database not ready, cannot save Groq config');
            return;
        }

        const query = `
                INSERT OR REPLACE INTO groq_config (id, enabled, api_key, model, updated_at)
                VALUES (1, ?, ?, ?, datetime('now'))
            `;

        db.run(query, [
            state.groqEnabled ? 1 : 0,
            state.groqApiKey,
            state.groqModel
        ], (err) => {
            if (err) {
                logger.error('❌ ChatBotLLMService: Error saving Groq config:', err);
            } else {
                logger.debug('💾 ChatBotLLMService: Groq config saved to database');
            }
        });
    } catch (error) {
        logger.error('❌ ChatBotLLMService: Error saving Groq config:', error);
    }
}

function enableGroq(state, database, logger, apiKey = null) {
    if (apiKey) {
        state.groqApiKey = apiKey;
    }
    if (!state.groqApiKey) {
        logger.error('❌ Groq API key not provided');
        return false;
    }
    state.groqEnabled = true;
    saveGroqConfig(state, database, logger); // Save to database
    logger.debug('✅ Groq API enabled for ALL chatbot responses');
    return true;
}

function disableGroq(state, database, logger) {
    state.groqEnabled = false;
    saveGroqConfig(state, database, logger); // Save to database
    logger.debug('✅ Groq API disabled, using local Ollama');
    return true;
}

function updateGroqSettings(state, database, logger, enabled, apiKey = null, model = null) {
    state.groqEnabled = enabled;
    if (apiKey !== null) {
        state.groqApiKey = apiKey;
    }
    if (model !== null) {
        state.groqModel = model;
    }
    saveGroqConfig(state, database, logger);
    logger.debug(`✅ Groq settings updated: enabled=${enabled}, hasKey=${!!state.groqApiKey}, model=${state.groqModel}`);
    return {
        enabled: state.groqEnabled,
        hasApiKey: !!state.groqApiKey,
        model: state.groqModel,
        availableModels: state.groqModels
    };
}

function getGroqStatus(state) {
    return {
        enabled: state.groqEnabled,
        hasApiKey: !!state.groqApiKey,
        model: state.groqModel,
        availableModels: state.groqModels
    };
}

module.exports = {
    loadGroqConfig,
    saveGroqConfig,
    enableGroq,
    disableGroq,
    updateGroqSettings,
    getGroqStatus,
};
