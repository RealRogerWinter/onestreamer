/**
 * RotationStatePersistence — JSON-file persistence of the rotation's
 * enabled flag + settings across server restarts. Extracted from
 * RandomStreamRotationService in PR 17.5.
 *
 * Holds no rotation state of its own — just the target file path + a
 * `host` ref. `save()` reads the host's current `isEnabled` /
 * `shouldAutoRestart` / `settings` and writes them; `load()` reads the
 * file and writes `shouldAutoRestart` / `settings` back onto the host.
 * The bodies are byte-equivalent to the pre-PR `_saveState` / `_loadState`
 * (same state shape, same log lines, same swallow-and-log error handling).
 * The shared `logger` is the RandomStreamRotationService child, so log
 * lines keep their `svc: 'RandomStreamRotationService'` binding.
 */

const fs = require('fs');
const path = require('path');

class RotationStatePersistence {
    constructor({ host, stateFile, logger }) {
        this.host = host;
        this.stateFile = stateFile;
        this.logger = logger;
    }

    save() {
        const host = this.host;
        try {
            const dir = path.dirname(this.stateFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const state = {
                enabled: host.isEnabled || host.shouldAutoRestart,
                settings: host.settings,
                savedAt: new Date().toISOString(),
            };
            fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
            this.logger.debug(`💾 Random rotation state saved (enabled: ${state.enabled})`);
        } catch (error) {
            this.logger.error('❌ Failed to save rotation state:', error.message);
        }
    }

    load() {
        const host = this.host;
        try {
            if (fs.existsSync(this.stateFile)) {
                const data = fs.readFileSync(this.stateFile, 'utf8');
                const state = JSON.parse(data);
                if (state.enabled) {
                    host.shouldAutoRestart = true;
                    this.logger.debug('📂 Random rotation state loaded - will auto-start when ready');
                }
                if (state.settings) {
                    host.settings = { ...host.settings, ...state.settings };
                    this.logger.debug('📂 Random rotation settings restored');
                }
            }
        } catch (error) {
            this.logger.error('❌ Failed to load rotation state:', error.message);
        }
    }
}

module.exports = RotationStatePersistence;
