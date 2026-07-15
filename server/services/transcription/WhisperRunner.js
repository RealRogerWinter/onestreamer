const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const logger = require('../../bootstrap/logger').child({ svc: 'WhisperRunner' });

// A3 (audit Plan 07): watchdog-timeout scaling + child-process concurrency.
//
// The old fixed 20 s watchdog silently truncated long windows (MovieBot's
// 45 s capture routinely needs more than 20 s of whisper.cpp CPU time on a
// loaded host) and discarded whatever whisper had already emitted. The
// timeout now scales with the audio duration when the caller knows it:
//
//   timeoutMs = max(WHISPER_TIMEOUT_FLOOR_MS,
//                   audioDurationSec * WHISPER_TIMEOUT_PER_SEC_MS)
//
// Defaults: 20 s floor, 1500 ms per second of audio (~1.5x realtime — the
// floor absorbs model-load overhead for short clips). When the duration is
// unknown the floor alone applies (previous behaviour).
const DEFAULT_TIMEOUT_FLOOR_MS = 20000;
const DEFAULT_TIMEOUT_PER_SEC_MS = 1500;
const DEFAULT_MAX_CONCURRENT = 2;

function envPositiveInt(name, fallback) {
    const n = parseInt(process.env[name], 10);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}

function computeTimeoutMs(audioDurationSec) {
    const floorMs = envPositiveInt('WHISPER_TIMEOUT_FLOOR_MS', DEFAULT_TIMEOUT_FLOOR_MS);
    if (!Number.isFinite(audioDurationSec) || audioDurationSec <= 0) {
        return floorMs;
    }
    const perSecMs = envPositiveInt('WHISPER_TIMEOUT_PER_SEC_MS', DEFAULT_TIMEOUT_PER_SEC_MS);
    return Math.max(floorMs, Math.ceil(audioDurationSec * perSecMs));
}

// In-module semaphore bounding concurrent whisper.cpp child processes.
// Module-level (not per-instance) because there is one whisper binary and one
// CPU budget per host regardless of how many WhisperRunner instances exist.
// Excess runs queue FIFO and start when a slot frees — never rejected.
// Tunable via WHISPER_MAX_CONCURRENT (default 2).
const semaphore = { active: 0, waiters: [] };

/**
 * Take a slot. Returns `null` when acquired synchronously (so the caller can
 * spawn immediately, keeping the watchdog timer accurate), or a Promise that
 * resolves once a slot is handed over.
 */
function acquireSlot() {
    const max = envPositiveInt('WHISPER_MAX_CONCURRENT', DEFAULT_MAX_CONCURRENT);
    if (semaphore.active < max) {
        semaphore.active += 1;
        return null;
    }
    return new Promise((resolve) => semaphore.waiters.push(resolve));
}

function releaseSlot() {
    const next = semaphore.waiters.shift();
    if (next) {
        next(); // hand the slot straight to the next queued run; count unchanged
    } else {
        semaphore.active -= 1;
    }
}

// Whisper prints its banner/timings to stdout alongside transcript lines;
// keep only the transcript. Shared by the clean-exit stdout fallback and the
// timed-out partial-output path.
function parseStdoutTranscript(output) {
    return output
        .split('\n')
        .filter(line =>
            !line.includes('whisper_') &&
            !line.includes('time =') &&
            line.trim().length > 0
        )
        .join(' ')
        .trim();
}

/**
 * WhisperRunner
 *
 * Self-contained whisper.cpp subprocess driver. Spawns the whisper
 * binary against a WAV file and resolves the transcribed text.
 *
 * Extracted from `server/services/TranscriptionService.js`.
 */
class WhisperRunner {
    /**
     * @param {object} deps
     * @param {string} deps.whisperPath - root path to whisper install
     * @param {boolean} deps.isWindows - platform flag
     */
    constructor(deps = {}) {
        this.whisperPath = deps.whisperPath;
        this.isWindows = deps.isWindows;
    }

    /**
     * @param {string} audioPath - WAV file to transcribe
     * @param {object} config - { model, language }
     * @param {object} [options]
     * @param {number} [options.audioDurationSec] - duration of the audio
     *   window in seconds; scales the watchdog timeout. When omitted the
     *   WHISPER_TIMEOUT_FLOOR_MS floor applies.
     * @returns {Promise<string>} the transcript (possibly partial on timeout)
     */
    transcribeWithWhisperCpp(audioPath, config, options = {}) {
        const wait = acquireSlot();
        if (!wait) {
            return this._runReleasing(audioPath, config, options);
        }
        logger.debug('⏳ WHISPER: Concurrency limit reached, queueing run');
        return wait.then(() => this._runReleasing(audioPath, config, options));
    }

    _runReleasing(audioPath, config, options) {
        const run = this._runWhisperProcess(audioPath, config, options);
        // Release the slot when the child settles — as a side chain, so the
        // caller still sees the original resolution/rejection and a rejected
        // run can't become an unhandled rejection here.
        run.then(releaseSlot, releaseSlot);
        return run;
    }

    _runWhisperProcess(audioPath, config, options = {}) {
        return new Promise((resolve, reject) => {
            const modelPath = path.join(this.whisperPath, 'models', `ggml-${config.model}.bin`);
            const whisperExe = this.isWindows
                ? path.join(this.whisperPath, 'Release', 'whisper-cli.exe')
                : path.join(this.whisperPath, 'whisper.cpp', 'main');

            const args = [
                '-m', modelPath,
                '-f', audioPath,
                '-t', '2', // reduced threads to avoid hanging
                '--no-timestamps',
                '-otxt',
                // PR-M4 (ADR-0013): Whisper hardening for the AI moderation
                // pipeline. (1) `--temperature 0.0` for deterministic output —
                // ASR moderation evidence is more credible when re-running
                // produces the same transcript. (2) `--initial-prompt` steers
                // Whisper away from its default behaviour of redacting
                // profanity to `***` — that redaction defeats Stage 1 word-
                // filter matching. The prompt is short and avoids any
                // appearance of an instruction that could fight the user's
                // language choice.
                '--temperature', '0.0',
                '--prompt', 'Transcribe verbatim, including any profanity.',
            ];

            if (config.language && config.language !== 'auto') {
                args.push('-l', config.language);
            }

            logger.debug(`🎙️ WHISPER: Running command: ${whisperExe} ${args.join(' ')}`);
            const whisperProcess = spawn(whisperExe, args);

            let output = '';
            let stderr = '';
            let timeoutId;
            // Set when WE terminate the process (watchdog timeout) so the close
            // handler can tell our own SIGTERM/SIGKILL apart from a crash signal.
            let killedByTimeout = false;

            // Add timeout to kill hanging whisper process. Scales with the
            // audio duration when the caller provides it (A3, audit Plan 07).
            const timeoutMs = computeTimeoutMs(options.audioDurationSec);
            timeoutId = setTimeout(() => {
                logger.debug(`⚠️ WHISPER: Process timeout after ${timeoutMs}ms, killing...`);
                killedByTimeout = true;
                whisperProcess.kill('SIGTERM');
                setTimeout(() => {
                    if (!whisperProcess.killed) {
                        whisperProcess.kill('SIGKILL');
                    }
                }, 2000);
            }, timeoutMs);

            whisperProcess.stdout.on('data', (data) => {
                output += data.toString();
            });

            whisperProcess.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            whisperProcess.on('close', (code, signal) => {
                clearTimeout(timeoutId);

                // Our own watchdog kill (SIGTERM, then SIGKILL) — expected,
                // not a crash. Salvage whatever transcript whisper already
                // emitted on stdout instead of discarding it (A3): a timed-out
                // 45 s window used to come back as '' even when 40 s of it had
                // been transcribed. The result is truncated — WARN loudly so
                // operators can raise WHISPER_TIMEOUT_* / lower window sizes.
                if (killedByTimeout) {
                    const partial = parseStdoutTranscript(output);
                    const durationLabel = Number.isFinite(options.audioDurationSec)
                        ? `${options.audioDurationSec}s`
                        : 'unknown';
                    logger.warn(
                        `⚠️ WHISPER: Process timed out after ${timeoutMs}ms (audio duration: ${durationLabel}); `
                        + `returning ${partial.length} chars of partial transcript (truncated)`
                    );
                    resolve(partial);
                    return;
                }

                // Terminated by a signal we did NOT send: the binary crashed
                // (SIGILL = illegal instruction; SIGSEGV/SIGABRT/SIGBUS = native
                // fault). The old code folded this into the `code === null` success
                // path and silently returned '' — so an instruction-set mismatch
                // (e.g. an AVX-512 binary on an AVX2-only host) looked like endless
                // silence with no error, and every transcript came back 0 words.
                // Surface it loudly and reject so the failure is visible.
                if (signal) {
                    logger.error(`❌ WHISPER: binary terminated by signal ${signal} (the whisper.cpp subprocess crashed)`);
                    if (signal === 'SIGILL') {
                        logger.error('   SIGILL = illegal instruction: the whisper.cpp binary was almost'
                            + ' certainly built for a CPU feature this host lacks (commonly AVX-512).'
                            + ' Rebuild it AVX2-only — see scripts/setup/setup-whisper.js / Dockerfile'
                            + ' (-DGGML_AVX512=OFF).');
                    }
                    if (stderr.trim()) {
                        logger.error(`   stderr: ${stderr.trim()}`);
                    }
                    reject(new Error(`Whisper terminated by signal ${signal}`));
                    return;
                }

                if (code === 0) {
                    // Read the output text file
                    const txtPath = audioPath + '.txt';
                    if (fs.existsSync(txtPath)) {
                        const transcription = fs.readFileSync(txtPath, 'utf8').trim();
                        logger.debug(`✅ WHISPER: Transcription from file (${transcription.split(' ').length} words)`);
                        fs.unlinkSync(txtPath);
                        resolve(transcription);
                    } else if (output.trim()) {
                        // Parse output from stdout if no file
                        const transcription = parseStdoutTranscript(output);
                        logger.debug(`✅ WHISPER: Transcription from stdout (${transcription.split(' ').length} words)`);
                        resolve(transcription);
                    } else {
                        logger.debug('⚠️ WHISPER: No transcription output');
                        resolve('');
                    }
                } else {
                    logger.error(`❌ WHISPER: Process exited with code ${code}`);
                    logger.error(`   stderr: ${stderr}`);
                    reject(new Error(`Whisper process exited with code ${code}`));
                }
            });

            whisperProcess.on('error', (error) => {
                clearTimeout(timeoutId);
                reject(error);
            });
        });
    }
}

module.exports = WhisperRunner;
