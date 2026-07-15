/**
 * B2StorageService - Backblaze B2 Storage Integration
 *
 * Handles uploading recordings to B2, generating signed URLs for playback,
 * and managing file lifecycle (deletion after retention period).
 *
 * Uses S3-compatible API for Backblaze B2.
 */

const { S3Client, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
// R6 (P2.2): lib-storage Upload does automatic multipart, so whole-run
// archives past S3/B2's 5 GB single-PutObject cap can actually upload.
const { Upload } = require('@aws-sdk/lib-storage');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const logger = require('../bootstrap/logger').child({ svc: 'B2StorageService' });
class B2StorageService {
    constructor() {
        this.keyId = process.env.B2_APPLICATION_KEY_ID;
        this.applicationKey = process.env.B2_APPLICATION_KEY;
        this.bucketId = process.env.B2_BUCKET_ID;
        this.bucketName = process.env.B2_BUCKET_NAME;
        this.endpoint = process.env.B2_ENDPOINT;

        // R11 (P2.2): bound the concat ffmpeg. -c copy concat is pure I/O
        // (minutes even for a multi-GB day), so 30 min is generous headroom.
        // Set before the credentials guard: concatenateSegments is callable
        // on a disabled instance.
        this.concatTimeoutMs = Number(process.env.B2_CONCAT_TIMEOUT_MS) || 30 * 60 * 1000;

        if (!this.keyId || !this.applicationKey || !this.bucketName) {
            logger.warn('[B2Storage] Missing B2 credentials - service will be disabled');
            this.enabled = false;
            return;
        }

        this.enabled = true;

        // Initialize S3 client for B2
        this.s3Client = new S3Client({
            endpoint: `https://${this.endpoint}`,
            region: 'us-west-004',
            credentials: {
                accessKeyId: this.keyId,
                secretAccessKey: this.applicationKey
            },
            forcePathStyle: true,
            // P2.2: bound every network await so a wedged connection can't
            // latch the upload scheduler's isProcessing forever.
            // requestTimeout is socket-inactivity, so slow-but-progressing
            // multipart parts survive.
            requestHandler: {
                connectionTimeout: 10_000,
                requestTimeout: 120_000
            }
        });

        logger.debug(`[B2Storage] Initialized with bucket: ${this.bucketName}`);
    }

    /**
     * Check if B2 storage is enabled and configured
     */
    isEnabled() {
        return this.enabled;
    }

    /**
     * Concatenate HLS segments into a single MP4 file using FFmpeg
     * @param {string} segmentsDir - Directory containing .ts segments
     * @param {string} outputPath - Path for output MP4 file
     * @returns {Promise<{success: boolean, fileSize?: number, error?: string}>}
     */
    async concatenateSegments(segmentsDir, outputPath) {
        return new Promise((resolve) => {
            // R5 (P2.2): sort by the FULL (timestamp, index) tuple from
            // seg_<epochMs>_<idx>.ts. The old sort keyed on the first number
            // only — the shared egress timestamp — so all segments of one run
            // tied and fell back to readdir() order (scrambled archive).
            // Numeric idx compare is mandatory: the %05d INDEX grows to 6
            // digits past segment 99999. The tuple (not idx alone) keeps
            // legacy day-bucket dirs — multiple seg_<ts>_ prefixes per dir —
            // in true order too.
            const SEG_RE = /^seg_(\d+)_(\d+)\.ts$/;
            const allTs = fs.readdirSync(segmentsDir).filter(f => f.endsWith('.ts'));
            const strays = allTs.filter(f => !SEG_RE.test(f));
            if (strays.length > 0) {
                logger.warn(`[B2Storage] Excluding ${strays.length} non-segment .ts file(s) from concat: ${strays.slice(0, 5).join(', ')}`);
            }
            const segmentFiles = allTs
                .map(f => { const m = f.match(SEG_RE); return m && { f, ts: Number(m[1]), idx: Number(m[2]) }; })
                .filter(Boolean)
                .sort((a, b) => a.ts - b.ts || a.idx - b.idx)
                .map(e => path.join(segmentsDir, e.f));

            if (segmentFiles.length === 0) {
                return resolve({ success: false, error: 'No segment files found' });
            }

            logger.debug(`[B2Storage] Concatenating ${segmentFiles.length} segments to ${outputPath}`);

            // Create concat file list
            const concatListPath = path.join(segmentsDir, 'concat_list.txt');
            const concatContent = segmentFiles.map(f => `file '${f}'`).join('\n');
            fs.writeFileSync(concatListPath, concatContent);

            // Run FFmpeg to concatenate
            const ffmpeg = spawn('ffmpeg', [
                '-y',
                '-f', 'concat',
                '-safe', '0',
                '-i', concatListPath,
                '-c', 'copy',
                '-bsf:a', 'aac_adtstoasc',
                '-movflags', '+faststart',
                outputPath
            ]);

            let stderr = '';
            ffmpeg.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            // R11 (P2.2): bound the concat. A hung ffmpeg used to never
            // resolve this promise, latching the upload scheduler's
            // isProcessing latch and halting all future uploads. Mirrors
            // ClipProcessorService.spawnWithTimeout.
            let timedOut = false;
            const killTimer = setTimeout(() => {
                timedOut = true;
                logger.error(`[B2Storage] Concat ffmpeg exceeded ${this.concatTimeoutMs}ms - killing`);
                ffmpeg.kill('SIGKILL');
            }, this.concatTimeoutMs);

            ffmpeg.on('close', (code) => {
                clearTimeout(killTimer);
                // Clean up concat list
                try {
                    fs.unlinkSync(concatListPath);
                } catch (e) {}

                if (timedOut) {
                    // The killed child has closed, so the fd is released —
                    // remove the partial output (the concat-failure return in
                    // processAndUploadSession never reaches its temp cleanup).
                    try {
                        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                    } catch (e) {}
                    return resolve({ success: false, error: `Concat timed out after ${this.concatTimeoutMs}ms` });
                }

                if (code === 0 && fs.existsSync(outputPath)) {
                    const stats = fs.statSync(outputPath);
                    logger.debug(`[B2Storage] Concatenation complete: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
                    resolve({ success: true, fileSize: stats.size });
                } else {
                    logger.error(`[B2Storage] FFmpeg failed with code ${code}`);
                    resolve({ success: false, error: stderr.slice(-500) });
                }
            });

            ffmpeg.on('error', (err) => {
                clearTimeout(killTimer);
                resolve({ success: false, error: err.message });
            });
        });
    }

    /**
     * Upload a recording to B2
     * @param {string} sessionId - Recording session ID
     * @param {string} localPath - Path to local MP4 file
     * @param {object} metadata - Optional metadata to store with file
     * @returns {Promise<{success: boolean, fileId?: string, fileName?: string, error?: string}>}
     */
    async uploadRecording(sessionId, localPath, metadata = {}) {
        if (!this.enabled) {
            return { success: false, error: 'B2 storage not configured' };
        }

        if (!fs.existsSync(localPath)) {
            return { success: false, error: `File not found: ${localPath}` };
        }

        try {
            const stats = fs.statSync(localPath);
            const fileName = `recordings/${sessionId}.mp4`;
            const fileStream = fs.createReadStream(localPath);

            logger.debug(`[B2Storage] Uploading ${fileName} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

            // R6 (P2.2): automatic multipart via lib-storage. Single
            // PutObject hard-caps at 5 GB, so whole-run archives above that
            // could never upload (and retried every 30 min forever). 64 MiB
            // parts × the 10k-part cap gives a 640 GB ceiling; queueSize 2
            // bounds buffered memory to ~128 MB; leavePartsOnError:false
            // aborts the multipart upload on failure so B2 doesn't bill
            // orphaned parts. ContentLength is gone — lib-storage sizes
            // parts itself.
            const upload = new Upload({
                client: this.s3Client,
                params: {
                    Bucket: this.bucketName,
                    Key: fileName,
                    Body: fileStream,
                    ContentType: 'video/mp4',
                    Metadata: {
                        sessionId: sessionId,
                        uploadedAt: new Date().toISOString(),
                        ...Object.fromEntries(
                            Object.entries(metadata).map(([k, v]) => [k, String(v)])
                        )
                    }
                },
                partSize: 64 * 1024 * 1024,
                queueSize: 2,
                leavePartsOnError: false
            });

            const result = await upload.done();

            logger.debug(`[B2Storage] Upload complete: ${fileName}`);

            return {
                success: true,
                fileId: result.ETag?.replace(/"/g, ''),
                fileName: fileName,
                fileSize: stats.size
            };
        } catch (error) {
            logger.error(`[B2Storage] Upload failed:`, error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * Generate a time-limited signed URL for video playback
     * @param {string} fileName - B2 file name/key
     * @param {number} validSeconds - URL validity in seconds (default 4 hours)
     * @returns {Promise<{success: boolean, url?: string, expiresAt?: Date, error?: string}>}
     */
    async getSignedUrl(fileName, validSeconds = 14400) {
        if (!this.enabled) {
            return { success: false, error: 'B2 storage not configured' };
        }

        try {
            const command = new GetObjectCommand({
                Bucket: this.bucketName,
                Key: fileName
            });

            const url = await getSignedUrl(this.s3Client, command, {
                expiresIn: validSeconds
            });

            const expiresAt = new Date(Date.now() + validSeconds * 1000);

            return {
                success: true,
                url: url,
                expiresAt: expiresAt
            };
        } catch (error) {
            logger.error(`[B2Storage] Failed to generate signed URL:`, error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * Check if a file exists in B2
     * @param {string} fileName - B2 file name/key
     * @returns {Promise<{exists: boolean, size?: number}>}
     */
    async fileExists(fileName) {
        if (!this.enabled) {
            return { exists: false };
        }

        try {
            const command = new HeadObjectCommand({
                Bucket: this.bucketName,
                Key: fileName
            });

            const result = await this.s3Client.send(command);
            return { exists: true, size: result.ContentLength };
        } catch (error) {
            if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
                return { exists: false };
            }
            throw error;
        }
    }

    /**
     * Delete a file from B2
     * @param {string} fileName - B2 file name/key
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async deleteFile(fileName) {
        if (!this.enabled) {
            return { success: false, error: 'B2 storage not configured' };
        }

        try {
            const command = new DeleteObjectCommand({
                Bucket: this.bucketName,
                Key: fileName
            });

            await this.s3Client.send(command);
            logger.debug(`[B2Storage] Deleted: ${fileName}`);

            return { success: true };
        } catch (error) {
            logger.error(`[B2Storage] Delete failed:`, error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get storage statistics
     * @returns {Promise<{success: boolean, stats?: object, error?: string}>}
     */
    async getStorageStats() {
        if (!this.enabled) {
            return { success: false, error: 'B2 storage not configured' };
        }

        // B2 doesn't have a direct API for bucket stats via S3
        // We'd need to list all objects and sum, which is expensive
        // For now, return configuration info
        return {
            success: true,
            stats: {
                bucketName: this.bucketName,
                endpoint: this.endpoint,
                enabled: this.enabled
            }
        };
    }

    /**
     * Process and upload a recording session
     * This is the main method called by the upload scheduler
     * @param {string} sessionId - Recording session ID
     * @param {string} segmentsDir - Directory containing HLS segments
     * @param {object} metadata - Session metadata
     * @returns {Promise<{success: boolean, fileId?: string, fileName?: string, fileSize?: number, error?: string}>}
     */
    async processAndUploadSession(sessionId, segmentsDir, metadata = {}) {
        if (!this.enabled) {
            return { success: false, error: 'B2 storage not configured' };
        }

        // Create temp directory for processing
        const tempDir = path.join(segmentsDir, '..', 'temp');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        const outputPath = path.join(tempDir, `${sessionId}.mp4`);

        try {
            // Step 1: Concatenate segments to MP4
            logger.debug(`[B2Storage] Processing session ${sessionId}`);
            const concatResult = await this.concatenateSegments(segmentsDir, outputPath);

            if (!concatResult.success) {
                return { success: false, error: `Concatenation failed: ${concatResult.error}` };
            }

            // Step 2: Upload to B2
            const uploadResult = await this.uploadRecording(sessionId, outputPath, metadata);

            // Step 3: Clean up temp file
            try {
                fs.unlinkSync(outputPath);
            } catch (e) {
                logger.warn(`[B2Storage] Failed to clean up temp file: ${e.message}`);
            }

            if (!uploadResult.success) {
                return uploadResult;
            }

            return {
                success: true,
                fileId: uploadResult.fileId,
                fileName: uploadResult.fileName,
                fileSize: concatResult.fileSize
            };
        } catch (error) {
            // Clean up on error
            try {
                if (fs.existsSync(outputPath)) {
                    fs.unlinkSync(outputPath);
                }
            } catch (e) {}

            logger.error(`[B2Storage] Process and upload failed:`, error.message);
            return { success: false, error: error.message };
        }
    }
}

// Export singleton instance
module.exports = new B2StorageService();
