const fs = require('fs');
const path = require('path');

const logger = require('../../bootstrap/logger').child({ svc: 'AudioFileJanitor' });

/**
 * AudioFileJanitor
 *
 * Owns transcription directory bootstrapping and periodic cleanup of
 * stale audio buffer files.
 *
 * Extracted from `server/services/TranscriptionService.js`. The
 * `baseDir` dep is the repo root (originally resolved relative to
 * `server/services` via `__dirname`); it is injected so the resolved
 * paths stay identical after the move.
 */
class AudioFileJanitor {
    /**
     * @param {object} deps
     * @param {string} deps.tempDir - transcription temp directory
     * @param {string} deps.baseDir - repo root used for sibling dirs
     */
    constructor(deps = {}) {
        this.tempDir = deps.tempDir;
        this.baseDir = deps.baseDir;
    }

    initializeDirectories() {
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }

        const transcriptsDir = path.join(this.baseDir, 'transcripts');
        if (!fs.existsSync(transcriptsDir)) {
            fs.mkdirSync(transcriptsDir, { recursive: true });
        }
    }

    // Clean up old audio files periodically
    async cleanupOldAudioFiles(maxAgeMinutes = 30) {
        const directories = [
            this.tempDir,
            path.join(this.baseDir, 'temp', 'audio'),
            path.join(this.baseDir, 'audio-buffers')
        ];

        let deletedCount = 0;
        const cutoffTime = Date.now() - (maxAgeMinutes * 60 * 1000);

        for (const dir of directories) {
            if (!fs.existsSync(dir)) continue;

            try {
                const files = fs.readdirSync(dir);

                for (const file of files) {
                    if (!file.endsWith('.wav')) continue;

                    const filePath = path.join(dir, file);
                    const stats = fs.statSync(filePath);

                    if (stats.mtimeMs < cutoffTime) {
                        try {
                            fs.unlinkSync(filePath);
                            deletedCount++;
                            logger.debug(`🧹 TRANSCRIPTION: Deleted old audio file: ${file} (age: ${Math.round((Date.now() - stats.mtimeMs) / 60000)} minutes)`);
                        } catch (e) {
                            logger.error(`⚠️ TRANSCRIPTION: Failed to delete ${file}:`, e.message);
                        }
                    }
                }
            } catch (error) {
                logger.error(`⚠️ TRANSCRIPTION: Error cleaning directory ${dir}:`, error.message);
            }
        }

        if (deletedCount > 0) {
            logger.debug(`✅ TRANSCRIPTION: Cleaned up ${deletedCount} old audio files`);
        }

        return { success: true, deletedCount };
    }

    // Start periodic cleanup (called from constructor or init)
    startPeriodicCleanup(intervalMinutes = 15) {
        if (this._cleanupTimer) return; // idempotent
        // Run cleanup every N minutes. Guarded unref: this background timer
        // must never be the only thing keeping a process alive (audit B6).
        this._cleanupTimer = setInterval(() => {
            this.cleanupOldAudioFiles(30); // Delete files older than 30 minutes
        }, intervalMinutes * 60 * 1000);
        if (typeof this._cleanupTimer.unref === 'function') this._cleanupTimer.unref();

        // Run initial cleanup
        this.cleanupOldAudioFiles(30);

        logger.debug(`🧹 TRANSCRIPTION: Started periodic cleanup (every ${intervalMinutes} minutes)`);
    }

    // Stop the cleanup interval (tests/shutdown).
    stopPeriodicCleanup() {
        if (this._cleanupTimer) {
            clearInterval(this._cleanupTimer);
            this._cleanupTimer = null;
        }
    }
}

module.exports = AudioFileJanitor;
