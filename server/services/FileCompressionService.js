const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const logger = require('../bootstrap/logger').child({ svc: 'FileCompressionService' });
class FileCompressionService {
  constructor(database) {
    this.db = database.db;
    this.runAsync = database.runAsync;
    this.getAsync = database.getAsync;
    this.allAsync = database.allAsync;
    this.compressionQueue = new Map();
    this.activeCompressions = new Map();
    this.maxConcurrentCompressions = 2;
    this.isProcessing = false;
    
    // Compression profiles
    this.compressionProfiles = {
      'high_quality': {
        video: {
          codec: 'libx264',
          preset: 'slow',
          crf: 18,
          profile: 'high',
          level: '4.1'
        },
        audio: {
          codec: 'aac',
          bitrate: '192k',
          sampleRate: 48000
        },
        container: 'mp4'
      },
      'balanced': {
        video: {
          codec: 'libx264',
          preset: 'medium', 
          crf: 23,
          profile: 'high',
          level: '4.1'
        },
        audio: {
          codec: 'aac',
          bitrate: '128k',
          sampleRate: 48000
        },
        container: 'mp4'
      },
      'small_size': {
        video: {
          codec: 'libx264',
          preset: 'fast',
          crf: 28,
          profile: 'baseline',
          level: '3.1'
        },
        audio: {
          codec: 'aac',
          bitrate: '96k',
          sampleRate: 44100
        },
        container: 'mp4'
      },
      'web_optimized': {
        video: {
          codec: 'libvpx-vp9',
          preset: 'good',
          crf: 25,
          bitrate: '1000k'
        },
        audio: {
          codec: 'libopus',
          bitrate: '128k'
        },
        container: 'webm'
      }
    };
    
    // Storage paths
    this.storagePaths = {
      processing: path.join(__dirname, '../../recordings/processing'),
      completed: path.join(__dirname, '../../recordings/completed'),
      archived: path.join(__dirname, '../../recordings/archived'),
      temp: path.join(__dirname, '../../recordings/temp')
    };
    
    // Start processing queue
    this.startQueueProcessing();
  }
  
  async addToCompressionQueue(recordingId, inputPath, options = {}) {
    logger.debug(`🗜️ COMPRESSION: Adding recording ${recordingId} to compression queue`);
    
    try {
      const profile = options.profile || 'balanced';
      const priority = options.priority || 'normal'; // 'high', 'normal', 'low'
      const generateThumbnail = options.generateThumbnail !== false;
      
      if (!this.compressionProfiles[profile]) {
        throw new Error(`Unknown compression profile: ${profile}`);
      }
      
      if (!fs.existsSync(inputPath)) {
        throw new Error(`Input file does not exist: ${inputPath}`);
      }
      
      const compressionTask = {
        id: recordingId,
        inputPath: inputPath,
        profile: profile,
        priority: priority,
        generateThumbnail: generateThumbnail,
        queuedAt: new Date(),
        status: 'queued',
        progress: 0,
        retries: 0,
        maxRetries: 3
      };
      
      // Set priority order (high priority tasks first)
      const priorityOrder = { 'high': 3, 'normal': 2, 'low': 1 };
      compressionTask.priorityWeight = priorityOrder[priority] || 2;
      
      this.compressionQueue.set(recordingId, compressionTask);
      
      // Update recording status in database
      await this.updateCompressionStatus(recordingId, 'queued');
      
      logger.debug(`✅ COMPRESSION: Recording ${recordingId} added to queue (${this.compressionQueue.size} in queue)`);
      
      // Start processing if not already running
      if (!this.isProcessing) {
        this.processQueue();
      }
      
      return { success: true, queuePosition: this.compressionQueue.size };
      
    } catch (error) {
      logger.error('❌ COMPRESSION: Failed to add to queue:', error);
      return { success: false, error: error.message };
    }
  }
  
  startQueueProcessing() {
    // Process queue every 10 seconds
    setInterval(() => {
      if (!this.isProcessing && this.compressionQueue.size > 0) {
        this.processQueue();
      }
    }, 10000);
  }
  
  async processQueue() {
    if (this.isProcessing || this.activeCompressions.size >= this.maxConcurrentCompressions) {
      return;
    }
    
    this.isProcessing = true;
    
    try {
      // Get next task with highest priority
      const nextTask = this.getNextQueuedTask();
      if (!nextTask) {
        this.isProcessing = false;
        return;
      }
      
      logger.debug(`🎬 COMPRESSION: Starting compression for ${nextTask.id}`);
      
      // Move task to active compressions
      this.compressionQueue.delete(nextTask.id);
      this.activeCompressions.set(nextTask.id, nextTask);
      nextTask.status = 'processing';
      nextTask.startedAt = new Date();
      
      // Update database
      await this.updateCompressionStatus(nextTask.id, 'processing');
      
      // Start compression
      const result = await this.compressFile(nextTask);
      
      if (result.success) {
        logger.debug(`✅ COMPRESSION: Completed compression for ${nextTask.id}`);
        nextTask.status = 'completed';
        nextTask.completedAt = new Date();
        nextTask.outputPath = result.outputPath;
        nextTask.outputSize = result.fileSize;
        nextTask.compressionRatio = result.compressionRatio;
        
        await this.updateCompressionStatus(nextTask.id, 'completed', {
          outputPath: result.outputPath,
          fileSize: result.fileSize,
          compressionRatio: result.compressionRatio
        });
        
        // Generate thumbnail if requested
        if (nextTask.generateThumbnail && result.outputPath) {
          await this.generateThumbnail(nextTask.id, result.outputPath);
        }
        
      } else {
        logger.error(`❌ COMPRESSION: Failed compression for ${nextTask.id}:`, result.error);
        nextTask.status = 'failed';
        nextTask.error = result.error;
        nextTask.retries++;
        
        // Retry if under max retries
        if (nextTask.retries < nextTask.maxRetries) {
          logger.debug(`🔄 COMPRESSION: Retrying ${nextTask.id} (attempt ${nextTask.retries + 1})`);
          nextTask.status = 'queued';
          this.compressionQueue.set(nextTask.id, nextTask);
        } else {
          await this.updateCompressionStatus(nextTask.id, 'failed', { error: result.error });
        }
      }
      
      // Remove from active compressions
      this.activeCompressions.delete(nextTask.id);
      
    } catch (error) {
      logger.error('❌ COMPRESSION: Error processing queue:', error);
    }
    
    this.isProcessing = false;
    
    // Continue processing if more tasks in queue
    if (this.compressionQueue.size > 0) {
      setTimeout(() => this.processQueue(), 1000);
    }
  }
  
  getNextQueuedTask() {
    let nextTask = null;
    let highestPriority = 0;
    
    for (const task of this.compressionQueue.values()) {
      if (task.status === 'queued' && task.priorityWeight > highestPriority) {
        nextTask = task;
        highestPriority = task.priorityWeight;
      }
    }
    
    return nextTask;
  }
  
  async compressFile(task) {
    try {
      const profile = this.compressionProfiles[task.profile];
      const inputPath = task.inputPath;
      const inputStats = fs.statSync(inputPath);
      
      // Generate output path
      const inputDir = path.dirname(inputPath);
      const inputName = path.basename(inputPath, path.extname(inputPath));
      const outputPath = path.join(
        this.storagePaths.completed, 
        `${inputName}_compressed.${profile.container}`
      );
      
      logger.debug(`🗜️ COMPRESSION: Compressing ${inputPath} -> ${outputPath}`);
      
      return new Promise((resolve, reject) => {
        let ffmpegCommand = ffmpeg(inputPath);
        
        // Apply video settings
        if (profile.video.codec === 'libx264') {
          ffmpegCommand = ffmpegCommand
            .videoCodec(profile.video.codec)
            .addOption('-preset', profile.video.preset)
            .addOption('-crf', profile.video.crf.toString())
            .addOption('-profile:v', profile.video.profile)
            .addOption('-level', profile.video.level)
            .addOption('-pix_fmt', 'yuv420p') // Ensure compatibility
            .addOption('-movflags', '+faststart'); // Web optimization
            
        } else if (profile.video.codec === 'libvpx-vp9') {
          ffmpegCommand = ffmpegCommand
            .videoCodec(profile.video.codec)
            .addOption('-deadline', profile.video.preset)
            .addOption('-crf', profile.video.crf.toString())
            .videoBitrate(profile.video.bitrate)
            .addOption('-row-mt', '1')
            .addOption('-tile-columns', '2');
        }
        
        // Apply audio settings
        ffmpegCommand = ffmpegCommand
          .audioCodec(profile.audio.codec)
          .audioBitrate(profile.audio.bitrate);
        
        if (profile.audio.sampleRate) {
          ffmpegCommand = ffmpegCommand.audioFrequency(profile.audio.sampleRate);
        }
        
        // Set output format and path
        ffmpegCommand = ffmpegCommand
          .format(profile.container)
          .output(outputPath);
        
        // Progress tracking
        ffmpegCommand.on('progress', (progress) => {
          task.progress = progress.percent || 0;
          if (progress.percent && progress.percent > 0) {
            logger.debug(`📊 COMPRESSION: ${task.id} progress: ${Math.round(progress.percent)}%`);
          }
        });
        
        // Error handling
        ffmpegCommand.on('error', (err) => {
          logger.error(`❌ COMPRESSION: FFmpeg error for ${task.id}:`, err);
          resolve({ 
            success: false, 
            error: err.message 
          });
        });
        
        // Success handling
        ffmpegCommand.on('end', () => {
          try {
            if (fs.existsSync(outputPath)) {
              const outputStats = fs.statSync(outputPath);
              const compressionRatio = ((inputStats.size - outputStats.size) / inputStats.size * 100).toFixed(2);
              
              logger.debug(`🎉 COMPRESSION: ${task.id} completed successfully`);
              logger.debug(`📊 COMPRESSION: Size reduction: ${compressionRatio}% (${this.formatFileSize(inputStats.size)} -> ${this.formatFileSize(outputStats.size)})`);
              
              resolve({
                success: true,
                outputPath: outputPath,
                fileSize: outputStats.size,
                compressionRatio: parseFloat(compressionRatio)
              });
              
            } else {
              resolve({ 
                success: false, 
                error: 'Output file not created' 
              });
            }
          } catch (error) {
            resolve({ 
              success: false, 
              error: error.message 
            });
          }
        });
        
        // Start compression
        ffmpegCommand.run();
      });
      
    } catch (error) {
      logger.error('❌ COMPRESSION: Error in compressFile:', error);
      return { success: false, error: error.message };
    }
  }
  
  async generateThumbnail(recordingId, videoPath) {
    try {
      logger.debug(`🖼️ COMPRESSION: Generating thumbnail for ${recordingId}`);
      
      const thumbnailDir = path.join(__dirname, '../../recordings/thumbnails');
      if (!fs.existsSync(thumbnailDir)) {
        fs.mkdirSync(thumbnailDir, { recursive: true });
      }
      
      const thumbnailPath = path.join(thumbnailDir, `${recordingId}.jpg`);
      
      return new Promise((resolve, reject) => {
        ffmpeg(videoPath)
          .screenshots({
            timestamps: ['10%'], // Take screenshot at 10% of video duration
            filename: `${recordingId}.jpg`,
            folder: thumbnailDir,
            size: '320x180'
          })
          .on('end', () => {
            logger.debug(`✅ COMPRESSION: Thumbnail generated for ${recordingId}`);
            resolve({ success: true, thumbnailPath: thumbnailPath });
          })
          .on('error', (err) => {
            logger.error(`❌ COMPRESSION: Failed to generate thumbnail for ${recordingId}:`, err);
            resolve({ success: false, error: err.message });
          });
      });
      
    } catch (error) {
      logger.error('❌ COMPRESSION: Error generating thumbnail:', error);
      return { success: false, error: error.message };
    }
  }
  
  async updateCompressionStatus(recordingId, status, metadata = {}) {
    try {
      const query = `
        UPDATE recordings 
        SET compression_status = ?, metadata_json = ?, updated_at = datetime('now')
        WHERE id = ?
      `;
      
      const existingMetadata = await this.getRecordingMetadata(recordingId);
      const updatedMetadata = { ...existingMetadata, ...metadata, compressionStatus: status };
      
      await this.runAsync(query, [
        status,
        JSON.stringify(updatedMetadata),
        recordingId
      ]);
      
    } catch (error) {
      logger.error('❌ COMPRESSION: Failed to update compression status:', error);
    }
  }
  
  async getRecordingMetadata(recordingId) {
    try {
      const query = `SELECT metadata_json FROM recordings WHERE id = ?`;
      const result = await this.getAsync(query, [recordingId]);
      
      if (result && result.metadata_json) {
        return JSON.parse(result.metadata_json);
      }
      return {};
      
    } catch (error) {
      logger.error('❌ COMPRESSION: Failed to get recording metadata:', error);
      return {};
    }
  }
  
  getQueueStatus() {
    const queuedTasks = Array.from(this.compressionQueue.values()).map(task => ({
      id: task.id,
      status: task.status,
      profile: task.profile,
      priority: task.priority,
      queuedAt: task.queuedAt,
      retries: task.retries
    }));
    
    const activeTasks = Array.from(this.activeCompressions.values()).map(task => ({
      id: task.id,
      status: task.status,
      profile: task.profile,
      priority: task.priority,
      startedAt: task.startedAt,
      progress: task.progress
    }));
    
    return {
      queued: queuedTasks,
      active: activeTasks,
      queueSize: this.compressionQueue.size,
      activeCount: this.activeCompressions.size,
      maxConcurrent: this.maxConcurrentCompressions
    };
  }
  
  formatFileSize(bytes) {
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 Bytes';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
  }
  
  async cancelCompression(recordingId) {
    try {
      // Remove from queue if queued
      if (this.compressionQueue.has(recordingId)) {
        this.compressionQueue.delete(recordingId);
        await this.updateCompressionStatus(recordingId, 'cancelled');
        return { success: true, message: 'Compression removed from queue' };
      }
      
      // Cannot cancel active compressions easily with fluent-ffmpeg
      // This would require more complex process management
      if (this.activeCompressions.has(recordingId)) {
        return { success: false, error: 'Cannot cancel active compression' };
      }
      
      return { success: false, error: 'Compression task not found' };
      
    } catch (error) {
      logger.error('❌ COMPRESSION: Failed to cancel compression:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = FileCompressionService;
