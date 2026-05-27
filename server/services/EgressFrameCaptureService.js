const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const logger = require('../bootstrap/logger').child({ svc: 'EgressFrameCaptureService' });
/**
 * EgressFrameCaptureService
 *
 * Extracts a single JPEG frame from the LiveKit Egress HLS recording so that
 * VisionBot can pair it with a transcription window. The egress recording is
 * continuous (4s HLS segments to `egress-recordings/<sessionId>/`); this
 * service picks the segment whose write-time aligns with the transcription
 * window's end and pipes one frame through ffmpeg.
 *
 * Sync semantics — the critical bit: Whisper has 5–30s latency, so the
 * "latest" segment when a transcription completes is content from *after* the
 * transcript was spoken. To put the frame and transcript in the same window,
 * we anchor segment selection to the transcription's `endTime` (the wall-clock
 * time at which the audio window closed), not "now". We pick the segment
 * whose `mtime` is the largest value ≤ `endTime + segmentDuration*1000`.
 *
 * Process safety: ffmpeg can hang on a partial-write `.ts`. Every spawn has a
 * 6s SIGTERM / 8s SIGKILL escalation, and we cap concurrent ffmpegs at 2 to
 * prevent runaway under back-pressure.
 */
class EgressFrameCaptureService {
    constructor({ continuousRecordingService, framesArchiveDir, frameRetentionHours, bannedRetentionDays, cleanupIntervalMs } = {}) {
        this.continuousRecordingService = continuousRecordingService;
        this.framesArchiveDir = framesArchiveDir || path.join(__dirname, '..', '..', 'logs', 'visionbot', 'frames');
        this.frameRetentionHours = frameRetentionHours ?? 1;
        // OmniImageMod PR 2: flagged frames are promoted to the `banned/`
        // subdir on moderation events and survive the rolling-hour purge so
        // ban appeals can show the evidence. ModerationService loads the
        // current value from moderation_global_config.image_frame_retention_days
        // at boot and pushes it via setBannedRetentionDays().
        this.bannedRetentionDays = bannedRetentionDays ?? 30;
        this.cleanupIntervalMs = cleanupIntervalMs ?? 30 * 60 * 1000;

        this.activeProcesses = new Set();
        this.MAX_CONCURRENT = 2;
        this.cache = null;
        this.CACHE_TTL_MS = 10_000;

        this._ensureArchiveDir();
        this._startCleanupInterval();
    }

    _ensureArchiveDir() {
        if (!fs.existsSync(this.framesArchiveDir)) {
            fs.mkdirSync(this.framesArchiveDir, { recursive: true });
        }
    }

    _startCleanupInterval() {
        this._cleanupTimer = setInterval(() => {
            this.purgeOldFrames().catch(err => {
                logger.error('❌ EgressFrameCaptureService: purgeOldFrames failed:', err.message);
            });
        }, this.cleanupIntervalMs);
        // Don't keep the event loop alive solely for this timer.
        if (this._cleanupTimer.unref) this._cleanupTimer.unref();
    }

    /**
     * Capture a frame aligned to a transcription window.
     *
     * @param {string|number} streamerId
     * @param {Date|number}   transcriptionEndTime   wall-clock end of the
     *                                                transcribed audio window
     * @param {number}        streamGeneration       monotonic stream counter
     *                                                from StreamService — used
     *                                                to invalidate cache on
     *                                                takeover and pass through
     *                                                to the emit-time guard.
     * @returns {Promise<null | {
     *   streamerId, streamGeneration, jpegBase64, capturedAt,
     *   sourceSegment, sizeBytes, transcriptionEndTime
     * }>}
     */
    async captureFrame(streamerId, transcriptionEndTime, streamGeneration = 0) {
        const endTimeMs = transcriptionEndTime instanceof Date
            ? transcriptionEndTime.getTime()
            : Number(transcriptionEndTime);

        if (this._cacheHit(streamerId, streamGeneration)) {
            return this.cache;
        }

        if (!this.continuousRecordingService || !this.continuousRecordingService.isRecording) {
            this._logSkip('no_egress', { streamerId });
            return null;
        }

        const sessionId = this.continuousRecordingService.currentSessionId;
        if (!sessionId) {
            this._logSkip('no_session_id', { streamerId });
            return null;
        }

        const outputDir = this.continuousRecordingService.outputDir;
        const sessionDir = path.join(outputDir, sessionId);
        if (!fs.existsSync(sessionDir)) {
            this._logSkip('no_session_dir', { streamerId, sessionDir });
            return null;
        }

        const playlistPath = this._findLatestPlaylist(sessionDir);
        if (!playlistPath) {
            this._logSkip('no_playlist', { streamerId, sessionDir });
            return null;
        }

        const segmentPath = this._pickSegmentForWindow(sessionDir, playlistPath, endTimeMs);
        if (!segmentPath) {
            this._logSkip('no_segment_in_window', { streamerId, endTimeMs });
            return null;
        }

        if (this.activeProcesses.size >= this.MAX_CONCURRENT) {
            this._logSkip('ffmpeg_concurrency_cap', { streamerId, activeCount: this.activeProcesses.size });
            return null;
        }

        let jpegBuffer;
        try {
            jpegBuffer = await this._extractFrame(segmentPath);
        } catch (err) {
            this._logSkip('ffmpeg_error', { streamerId, error: err.message });
            return null;
        }
        if (!jpegBuffer || jpegBuffer.length === 0 || jpegBuffer.length > 4 * 1024 * 1024) {
            this._logSkip('invalid_jpeg_buffer', { streamerId, size: jpegBuffer ? jpegBuffer.length : 0 });
            return null;
        }

        const capturedAt = Date.now();
        const result = {
            streamerId,
            streamGeneration,
            jpegBase64: jpegBuffer.toString('base64'),
            capturedAt,
            sourceSegment: path.basename(segmentPath),
            sizeBytes: jpegBuffer.length,
            transcriptionEndTime: endTimeMs,
        };

        this.cache = result;
        // Capture the audit path so callers (ModerationService.handleVisionFrame)
        // can hand it back to promoteFrameForEvent if the frame is flagged.
        // The audit copy itself is best-effort; null on failure is fine.
        result.auditPath = this._writeAuditCopy(streamerId, capturedAt, jpegBuffer);
        return result;
    }

    _cacheHit(streamerId, streamGeneration) {
        if (!this.cache) return false;
        if (this.cache.streamerId !== streamerId) return false;
        if (this.cache.streamGeneration !== streamGeneration) {
            // Takeover happened — last frame is from a different streamer.
            this.cache = null;
            return false;
        }
        return (Date.now() - this.cache.capturedAt) < this.CACHE_TTL_MS;
    }

    _findLatestPlaylist(sessionDir) {
        let files;
        try {
            files = fs.readdirSync(sessionDir);
        } catch (e) {
            return null;
        }
        const playlists = files
            .filter(f => f.startsWith('playlist_') && f.endsWith('.m3u8'))
            .map(f => ({
                name: f,
                ts: parseInt((f.match(/playlist_(\d+)\.m3u8/) || [])[1] || '0', 10),
            }))
            .sort((a, b) => b.ts - a.ts);
        if (playlists.length === 0) return null;
        return path.join(sessionDir, playlists[0].name);
    }

    _pickSegmentForWindow(sessionDir, playlistPath, endTimeMs) {
        let content;
        try {
            content = fs.readFileSync(playlistPath, 'utf8');
        } catch (e) {
            return null;
        }
        const segments = content
            .split('\n')
            .map(l => l.trim())
            .filter(l => l.endsWith('.ts') && !l.startsWith('#'));
        if (segments.length < 2) {
            // Only one segment present (or zero) — the only candidate is the
            // one currently being written. Refuse to read a partial-write.
            return null;
        }

        // Drop the last entry — it's the in-progress write.
        const candidates = segments.slice(0, -1);

        const segmentDuration = (this.continuousRecordingService && this.continuousRecordingService.segmentDuration) || 4;
        const targetTime = endTimeMs + segmentDuration * 1000;

        let bestPath = null;
        let bestMtime = -1;
        let fallbackPath = null;
        let fallbackMtime = -1;
        for (const name of candidates) {
            const segPath = path.join(sessionDir, name);
            let stat;
            try {
                stat = fs.statSync(segPath);
            } catch (e) {
                continue;
            }
            const mt = stat.mtimeMs;
            if (mt > fallbackMtime) {
                fallbackMtime = mt;
                fallbackPath = segPath;
            }
            if (mt <= targetTime && mt > bestMtime) {
                bestMtime = mt;
                bestPath = segPath;
            }
        }

        // If nothing aligns with the window (transcription too recent for the
        // segment to have rolled yet), fall back to the newest fully-written
        // segment. This is the right call when the egress is slightly behind
        // the transcription completion — still close enough to be "same
        // window".
        return bestPath || fallbackPath;
    }

    _extractFrame(segmentPath) {
        return new Promise((resolve, reject) => {
            const proc = spawn('ffmpeg', [
                '-hide_banner', '-loglevel', 'error',
                '-sseof', '-0.5',
                '-i', segmentPath,
                '-frames:v', '1',
                '-vf', `scale='min(384,iw)':-2`,
                '-q:v', '5',
                '-f', 'mjpeg',
                'pipe:1',
            ]);

            this.activeProcesses.add(proc);
            const chunks = [];
            let killed = false;
            let settled = false;

            const sigTermTimer = setTimeout(() => {
                killed = true;
                try { proc.kill('SIGTERM'); } catch (_) {}
            }, 6000);
            const sigKillTimer = setTimeout(() => {
                killed = true;
                try { proc.kill('SIGKILL'); } catch (_) {}
            }, 8000);

            const cleanup = () => {
                clearTimeout(sigTermTimer);
                clearTimeout(sigKillTimer);
                this.activeProcesses.delete(proc);
            };

            proc.stdout.on('data', chunk => chunks.push(chunk));
            proc.stderr.on('data', () => { /* loglevel:error already suppresses noise */ });

            proc.on('error', err => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(err);
            });
            proc.on('exit', code => {
                if (settled) return;
                settled = true;
                cleanup();
                if (killed) return resolve(null);
                if (code !== 0) return resolve(null);
                resolve(Buffer.concat(chunks));
            });

            proc.unref();
        });
    }

    _writeAuditCopy(streamerId, capturedAt, jpegBuffer) {
        try {
            const safeStreamerId = String(streamerId).replace(/[^a-zA-Z0-9_-]/g, '_');
            const streamerDir = path.join(this.framesArchiveDir, safeStreamerId);
            if (!fs.existsSync(streamerDir)) {
                fs.mkdirSync(streamerDir, { recursive: true });
            }
            const isoTs = new Date(capturedAt).toISOString().replace(/[:.]/g, '-');
            const auditPath = path.join(streamerDir, `${isoTs}.jpg`);
            fs.writeFileSync(auditPath, jpegBuffer);
            return auditPath;
        } catch (e) {
            // Audit copy is best-effort.
            return null;
        }
    }

    /**
     * Promote a flagged frame out of the rolling-purge directory so it
     * survives the short hourly retention and is available for ban-appeal
     * review. Used by ModerationService.handleVisionFrame (OmniImageMod
     * PR 2) when an image moderation event is persisted. The target is the
     * `banned/` subdirectory under framesArchiveDir; purgeOldFrames skips
     * that subdir and uses bannedRetentionDays instead.
     *
     * @param {object} args
     * @param {string} args.originalPath  Path returned by _writeAuditCopy
     *                                    (also in capture result.auditPath).
     * @param {number} args.eventId       moderation_events.id; used in the
     *                                    permanent filename so an admin can
     *                                    match audit JPEG to event row.
     * @returns {Promise<string|null>} New absolute path, or null if the
     *   source file is missing or the copy failed.
     */
    async promoteFrameForEvent({ originalPath, eventId } = {}) {
        if (!originalPath || !eventId) return null;
        if (!fs.existsSync(originalPath)) return null;
        try {
            const bannedDir = path.join(this.framesArchiveDir, 'banned');
            if (!fs.existsSync(bannedDir)) {
                fs.mkdirSync(bannedDir, { recursive: true });
            }
            const target = path.join(bannedDir, `${eventId}.jpg`);
            fs.copyFileSync(originalPath, target);
            return target;
        } catch (e) {
            logger.warn(`EgressFrameCaptureService: promoteFrameForEvent failed: ${e.message}`);
            return null;
        }
    }

    async purgeOldFrames() {
        if (!fs.existsSync(this.framesArchiveDir)) return { deleted: 0 };
        const rollingCutoff = Date.now() - this.frameRetentionHours * 60 * 60 * 1000;
        const bannedCutoff = Date.now() - this.bannedRetentionDays * 24 * 60 * 60 * 1000;
        let deleted = 0;
        const streamerDirs = fs.readdirSync(this.framesArchiveDir);
        for (const sd of streamerDirs) {
            const dirPath = path.join(this.framesArchiveDir, sd);
            let stat;
            try { stat = fs.statSync(dirPath); } catch (_) { continue; }
            if (!stat.isDirectory()) continue;
            // The `banned/` subdir holds frames promoted by
            // promoteFrameForEvent on moderation flag. Apply a different
            // retention (days, not hours) so ban-appeal evidence survives
            // the rolling purge window.
            const cutoff = sd === 'banned' ? bannedCutoff : rollingCutoff;
            const files = fs.readdirSync(dirPath);
            for (const f of files) {
                if (!f.endsWith('.jpg')) continue;
                const fp = path.join(dirPath, f);
                try {
                    const fst = fs.statSync(fp);
                    if (fst.mtimeMs < cutoff) {
                        fs.unlinkSync(fp);
                        deleted += 1;
                    }
                } catch (_) { /* race vs concurrent write — ignore */ }
            }
        }
        return { deleted };
    }

    setRetentionHours(hours) {
        if (typeof hours === 'number' && hours > 0 && hours <= 24) {
            this.frameRetentionHours = hours;
        }
    }

    setBannedRetentionDays(days) {
        if (typeof days === 'number' && days > 0 && days <= 365) {
            this.bannedRetentionDays = days;
        }
    }

    invalidateCache() {
        this.cache = null;
    }

    _logSkip(reason, details) {
        // Quiet skip logging — captureFrame is called frequently and most
        // skips are "no_egress" while a stream isn't live.
        if (process.env.VISIONBOT_FRAME_DEBUG === '1') {
            logger.debug(`⏭️  EgressFrameCaptureService skip: ${reason}`, details);
        }
    }

    async stop() {
        if (this._cleanupTimer) {
            clearInterval(this._cleanupTimer);
            this._cleanupTimer = null;
        }
        // SIGKILL anything still alive so the shutdown loop doesn't wait on
        // an ffmpeg subprocess we no longer want output from.
        for (const proc of this.activeProcesses) {
            try { proc.kill('SIGKILL'); } catch (_) {}
        }
        this.activeProcesses.clear();
    }
}

module.exports = EgressFrameCaptureService;
