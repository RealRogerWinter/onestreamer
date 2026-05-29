const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const logger = require('../../bootstrap/logger').child({ svc: 'WhisperRunner' });

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

    async transcribeWithWhisperCpp(audioPath, config) {
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

            // Add timeout to kill hanging whisper process
            timeoutId = setTimeout(() => {
                logger.debug('⚠️ WHISPER: Process timeout, killing...');
                whisperProcess.kill('SIGTERM');
                setTimeout(() => {
                    if (!whisperProcess.killed) {
                        whisperProcess.kill('SIGKILL');
                    }
                }, 2000);
            }, 20000); // 20 second timeout

            whisperProcess.stdout.on('data', (data) => {
                output += data.toString();
            });

            whisperProcess.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            whisperProcess.on('close', (code) => {
                clearTimeout(timeoutId);

                if (code === 0 || code === null) {
                    // Read the output text file
                    const txtPath = audioPath + '.txt';
                    if (fs.existsSync(txtPath)) {
                        const transcription = fs.readFileSync(txtPath, 'utf8').trim();
                        logger.debug(`✅ WHISPER: Transcription from file (${transcription.split(' ').length} words)`);
                        fs.unlinkSync(txtPath);
                        resolve(transcription);
                    } else if (output.trim()) {
                        // Parse output from stdout if no file
                        const lines = output.split('\n');
                        const transcriptionLines = lines.filter(line =>
                            !line.includes('whisper_') &&
                            !line.includes('time =') &&
                            line.trim().length > 0
                        );
                        const transcription = transcriptionLines.join(' ').trim();
                        logger.debug(`✅ WHISPER: Transcription from stdout (${transcription.split(' ').length} words)`);
                        resolve(transcription);
                    } else {
                        logger.debug('⚠️ WHISPER: No transcription output');
                        resolve('');
                    }
                } else if (code === -15 || code === 143) { // SIGTERM
                    logger.debug('⚠️ WHISPER: Process timed out');
                    resolve(''); // Return empty string on timeout
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
