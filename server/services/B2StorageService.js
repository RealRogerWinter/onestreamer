/**
 * B2StorageService - Backblaze B2 Storage Integration
 *
 * Handles uploading recordings to B2, generating signed URLs for playback,
 * and managing file lifecycle (deletion after retention period).
 *
 * Uses S3-compatible API for Backblaze B2.
 */

const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

class B2StorageService {
    constructor() {
        this.keyId = process.env.B2_APPLICATION_KEY_ID;
        this.applicationKey = process.env.B2_APPLICATION_KEY;
        this.bucketId = process.env.B2_BUCKET_ID;
        this.bucketName = process.env.B2_BUCKET_NAME;
        this.endpoint = process.env.B2_ENDPOINT;

        if (!this.keyId || !this.applicationKey || !this.bucketName) {
            console.warn('[B2Storage] Missing B2 credentials - service will be disabled');
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
            forcePathStyle: true
        });

        console.log(`[B2Storage] Initialized with bucket: ${this.bucketName}`);
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
            // Find all .ts segment files
            const segmentFiles = fs.readdirSync(segmentsDir)
                .filter(f => f.endsWith('.ts'))
                .sort((a, b) => {
                    // Sort by segment number
                    const numA = parseInt(a.match(/\d+/)?.[0] || '0');
                    const numB = parseInt(b.match(/\d+/)?.[0] || '0');
                    return numA - numB;
                })
                .map(f => path.join(segmentsDir, f));

            if (segmentFiles.length === 0) {
                return resolve({ success: false, error: 'No segment files found' });
            }

            console.log(`[B2Storage] Concatenating ${segmentFiles.length} segments to ${outputPath}`);

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

            ffmpeg.on('close', (code) => {
                // Clean up concat list
                try {
                    fs.unlinkSync(concatListPath);
                } catch (e) {}

                if (code === 0 && fs.existsSync(outputPath)) {
                    const stats = fs.statSync(outputPath);
                    console.log(`[B2Storage] Concatenation complete: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
                    resolve({ success: true, fileSize: stats.size });
                } else {
                    console.error(`[B2Storage] FFmpeg failed with code ${code}`);
                    resolve({ success: false, error: stderr.slice(-500) });
                }
            });

            ffmpeg.on('error', (err) => {
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

            console.log(`[B2Storage] Uploading ${fileName} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

            const command = new PutObjectCommand({
                Bucket: this.bucketName,
                Key: fileName,
                Body: fileStream,
                ContentType: 'video/mp4',
                ContentLength: stats.size,
                Metadata: {
                    sessionId: sessionId,
                    uploadedAt: new Date().toISOString(),
                    ...Object.fromEntries(
                        Object.entries(metadata).map(([k, v]) => [k, String(v)])
                    )
                }
            });

            const result = await this.s3Client.send(command);

            console.log(`[B2Storage] Upload complete: ${fileName}`);

            return {
                success: true,
                fileId: result.ETag?.replace(/"/g, ''),
                fileName: fileName,
                fileSize: stats.size
            };
        } catch (error) {
            console.error(`[B2Storage] Upload failed:`, error.message);
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
            console.error(`[B2Storage] Failed to generate signed URL:`, error.message);
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
            console.log(`[B2Storage] Deleted: ${fileName}`);

            return { success: true };
        } catch (error) {
            console.error(`[B2Storage] Delete failed:`, error.message);
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
            console.log(`[B2Storage] Processing session ${sessionId}`);
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
                console.warn(`[B2Storage] Failed to clean up temp file: ${e.message}`);
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

            console.error(`[B2Storage] Process and upload failed:`, error.message);
            return { success: false, error: error.message };
        }
    }
}

// Export singleton instance
module.exports = new B2StorageService();
