const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

/**
 * ClipProcessorService - Handles FFmpeg processing for clips
 * Manages queue, trimming, thumbnail generation, and callbacks
 * Supports both single-file MP4 recordings and HLS segments
 */
class ClipProcessorService extends EventEmitter {
  constructor(clipStorageService, io = null) {
    super();
    this.storageService = clipStorageService;
    this.io = io; // Socket.IO for real-time updates

    // Processing queue
    this.queue = [];
    this.activeJobs = 0;
    this.maxConcurrent = 2; // Max concurrent FFmpeg processes

    // Timeouts for FFmpeg operations (in milliseconds)
    this.TIMEOUT_CONCAT = 2 * 60 * 1000;     // 2 minutes for concat
    this.TIMEOUT_ENCODE = 5 * 60 * 1000;     // 5 minutes for encoding
    this.TIMEOUT_THUMBNAIL = 30 * 1000;       // 30 seconds for thumbnail

    // Processing stats
    this.stats = {
      processed: 0,
      failed: 0,
      totalProcessingTime: 0
    };

    // Callback for updating clip records
    this.onClipProcessed = null;

    console.log('🎬 CLIP PROCESSOR: Service initialized');
  }

  /**
   * Spawn FFmpeg with timeout handling
   * @param {Array} args - FFmpeg arguments
   * @param {number} timeoutMs - Timeout in milliseconds
   * @param {string} operationName - Name for logging
   * @returns {Promise} Resolves on success, rejects on error/timeout
   */
  spawnWithTimeout(args, timeoutMs, operationName) {
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', args);
      let stderr = '';
      let killed = false;

      // Set up timeout
      const timeout = setTimeout(() => {
        killed = true;
        ffmpeg.kill('SIGKILL');
        reject(new Error(`${operationName} timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);

      ffmpeg.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      ffmpeg.on('error', (error) => {
        clearTimeout(timeout);
        if (!killed) {
          reject(new Error(`${operationName} failed: ${error.message}`));
        }
      });

      ffmpeg.on('close', (code) => {
        clearTimeout(timeout);
        if (killed) return; // Already rejected by timeout

        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${operationName} failed with code ${code}: ${stderr.slice(-500)}`));
        }
      });
    });
  }

  /**
   * Set the callback for when clips finish processing
   * @param {Function} callback - Callback function(clipId, result)
   */
  setProcessedCallback(callback) {
    this.onClipProcessed = callback;
  }

  /**
   * Add a clip to the processing queue
   * @param {Object} job - Job details
   */
  queueClip(job) {
    const { clipId, segments, clipStartMs, clipEndMs, clipDurationMs } = job;

    console.log(`📥 CLIP PROCESSOR: Queuing clip ${clipId} (${clipDurationMs}ms from ${segments?.length || 0} segments)`);

    this.queue.push({
      clipId,
      segments: segments || [],
      clipStartMs,
      clipEndMs,
      clipDurationMs,
      queuedAt: Date.now()
    });

    // Try to process next job
    this.processNext();
  }

  /**
   * Process the next job in queue if capacity available
   */
  async processNext() {
    if (this.activeJobs >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    const job = this.queue.shift();
    this.activeJobs++;

    const startTime = Date.now();

    try {
      console.log(`🔄 CLIP PROCESSOR: Starting processing for clip ${job.clipId}`);

      // Emit processing start event
      this.emitSocketEvent('clip-processing-start', { clipId: job.clipId });

      const result = await this.processClipFromSegments(job);

      // Update stats
      this.stats.processed++;
      this.stats.totalProcessingTime += Date.now() - startTime;

      // Notify completion
      if (this.onClipProcessed) {
        await this.onClipProcessed(job.clipId, {
          status: 'ready',
          filePath: result.clipPath,
          thumbnailPath: result.thumbnailPath,
          fileSize: result.fileSize
        });
      }

      // Emit success event
      this.emitSocketEvent('clip-ready', {
        clipId: job.clipId,
        thumbnailUrl: `/api/clips/${job.clipId}/thumbnail`
      });

      console.log(`✅ CLIP PROCESSOR: Completed clip ${job.clipId} in ${Date.now() - startTime}ms`);

    } catch (error) {
      console.error(`❌ CLIP PROCESSOR: Failed to process clip ${job.clipId}:`, error);

      this.stats.failed++;

      // Notify failure
      if (this.onClipProcessed) {
        await this.onClipProcessed(job.clipId, {
          status: 'failed',
          error: error.message
        });
      }

      // Emit failure event
      this.emitSocketEvent('clip-failed', {
        clipId: job.clipId,
        error: error.message
      });

    } finally {
      this.activeJobs--;
      // Process next job in queue
      setImmediate(() => this.processNext());
    }
  }

  /**
   * Process a clip from HLS segments
   * @param {Object} job - Job details with segments array
   * @returns {Object} Processing result
   */
  async processClipFromSegments(job) {
    const { clipId, segments, clipStartMs, clipEndMs, clipDurationMs } = job;

    if (!segments || segments.length === 0) {
      throw new Error('No segments provided for clip');
    }

    // Verify all segment files exist
    for (const segment of segments) {
      if (!fs.existsSync(segment.segmentPath)) {
        throw new Error(`Segment file not found: ${segment.segmentPath}`);
      }
    }

    // Generate output paths
    const clipPath = this.storageService.getClipPath(clipId);
    const thumbnailPath = this.storageService.getThumbnailPath(clipId);
    const concatListPath = this.storageService.getTempPath(clipId, 'txt');

    try {
      // Step 1: Create concat file list
      const concatList = segments.map(s => `file '${s.segmentPath}'`).join('\n');
      fs.writeFileSync(concatListPath, concatList);

      // Step 2: Calculate trim offsets relative to the first segment
      const firstSegmentStart = segments[0].startMs;
      const trimStart = Math.max(0, (clipStartMs - firstSegmentStart) / 1000);
      const trimDuration = clipDurationMs / 1000;

      // Step 3: Concat, trim, and encode in ONE step to maintain A/V sync
      await this.concatAndEncode(concatListPath, clipPath, trimStart, trimDuration);

      // Step 4: Generate thumbnail
      await this.generateThumbnail(clipPath, thumbnailPath);

      // Step 5: Clean up temp files
      if (fs.existsSync(concatListPath)) {
        fs.unlinkSync(concatListPath);
      }

      // Get final file size
      const fileSize = fs.statSync(clipPath).size;

      return {
        clipPath,
        thumbnailPath,
        fileSize
      };

    } catch (error) {
      // Clean up on failure
      if (fs.existsSync(concatListPath)) fs.unlinkSync(concatListPath);
      if (fs.existsSync(clipPath)) fs.unlinkSync(clipPath);
      if (fs.existsSync(thumbnailPath)) fs.unlinkSync(thumbnailPath);

      throw error;
    }
  }

  /**
   * Concat segments, trim, and encode to MP4 in one step
   * Using -ss before input maintains A/V sync
   * @param {string} concatListPath - Path to concat list file
   * @param {string} outputPath - Output MP4 file path
   * @param {number} trimStart - Start offset in seconds
   * @param {number} trimDuration - Duration in seconds
   */
  concatAndEncode(concatListPath, outputPath, trimStart, trimDuration) {
    // Use filter_complex with trim/atrim to cut both streams at same point
    // This maintains perfect A/V sync by trimming video and audio together
    const trimEnd = trimStart + trimDuration;
    const filterComplex = `[0:v]trim=start=${trimStart.toFixed(3)}:end=${trimEnd.toFixed(3)},setpts=PTS-STARTPTS[v];[0:a]atrim=start=${trimStart.toFixed(3)}:end=${trimEnd.toFixed(3)},asetpts=PTS-STARTPTS[a]`;

    const args = [
      '-f', 'concat',
      '-safe', '0',
      '-i', concatListPath,
      '-filter_complex', filterComplex,
      '-map', '[v]',
      '-map', '[a]',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-force_key_frames', 'expr:eq(t,0)', // Keyframe at start for instant playback
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart', // Progressive download
      '-pix_fmt', 'yuv420p',
      '-y',
      outputPath
    ];

    console.log(`📹 CLIP PROCESSOR: Processing ${trimDuration.toFixed(1)}s clip (offset: ${trimStart.toFixed(1)}s)`);

    return this.spawnWithTimeout(args, this.TIMEOUT_ENCODE, 'FFmpeg concat+encode');
  }

  /**
   * Generate thumbnail from video
   * @param {string} videoPath - Source video path
   * @param {string} thumbnailPath - Output thumbnail path
   */
  async generateThumbnail(videoPath, thumbnailPath) {
    // Get thumbnail from 1 second in, or middle of clip
    const args = [
      '-i', videoPath,
      '-ss', '1', // 1 second in
      '-vframes', '1', // Single frame
      '-vf', 'scale=480:-1', // Width 480, maintain aspect ratio
      '-q:v', '3', // Quality (2-5 is good for JPEG)
      '-y',
      thumbnailPath
    ];

    console.log(`🖼️ CLIP PROCESSOR: Generating thumbnail...`);

    try {
      await this.spawnWithTimeout(args, this.TIMEOUT_THUMBNAIL, 'Thumbnail generation');
    } catch (error) {
      // Thumbnail is non-critical, log but don't fail the whole clip
      console.warn(`⚠️ CLIP PROCESSOR: Thumbnail generation failed: ${error.message}`);
    }
  }

  /**
   * Emit a Socket.IO event if available
   * @param {string} event - Event name
   * @param {Object} data - Event data
   */
  emitSocketEvent(event, data) {
    if (this.io) {
      this.io.emit(event, data);
    }
    this.emit(event, data); // Also emit on EventEmitter
  }

  /**
   * Get queue status
   * @returns {Object} Queue status
   */
  getStatus() {
    return {
      queueLength: this.queue.length,
      activeJobs: this.activeJobs,
      maxConcurrent: this.maxConcurrent,
      stats: this.stats
    };
  }

  /**
   * Get queue contents (for admin view)
   * @returns {Array} Queue items
   */
  getQueue() {
    return this.queue.map(job => ({
      clipId: job.clipId,
      queuedAt: job.queuedAt,
      waitTime: Date.now() - job.queuedAt,
      segmentCount: job.segments?.length || 0
    }));
  }

  /**
   * Cancel a queued job (not active ones)
   * @param {string} clipId - Clip ID to cancel
   * @returns {boolean} Whether job was found and removed
   */
  cancelJob(clipId) {
    const index = this.queue.findIndex(job => job.clipId === clipId);
    if (index !== -1) {
      this.queue.splice(index, 1);
      console.log(`🚫 CLIP PROCESSOR: Cancelled job for clip ${clipId}`);
      return true;
    }
    return false;
  }

  /**
   * Set Socket.IO instance for real-time updates
   * @param {Object} io - Socket.IO instance
   */
  setSocketIO(io) {
    this.io = io;
  }
}

module.exports = ClipProcessorService;
