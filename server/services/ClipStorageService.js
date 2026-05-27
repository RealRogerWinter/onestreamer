const fs = require('fs');
const path = require('path');

const logger = require('../bootstrap/logger').child({ svc: 'ClipStorageService' });
/**
 * ClipStorageService - Manages file storage for clips
 * Handles directory structure, file paths, and cleanup
 */
class ClipStorageService {
  constructor() {
    this.basePath = path.join(__dirname, '..', '..', 'clips');
    this.storagePaths = {
      videos: path.join(this.basePath, 'videos'),
      thumbnails: path.join(this.basePath, 'thumbnails'),
      temp: path.join(this.basePath, 'temp')
    };

    this.initialize();
  }

  /**
   * Initialize storage directories
   */
  initialize() {
    logger.debug('📁 CLIPS: Initializing clip storage directories...');

    Object.entries(this.storagePaths).forEach(([name, dir]) => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        logger.debug(`📁 CLIPS: Created directory: ${dir}`);
      }
    });

    logger.debug('✅ CLIPS: Storage directories initialized');
  }

  /**
   * Get the video file path for a clip
   * @param {string} clipId - The clip ID
   * @returns {string} Full path to clip video file
   */
  getClipPath(clipId) {
    return path.join(this.storagePaths.videos, `${clipId}.mp4`);
  }

  /**
   * Get the thumbnail path for a clip
   * @param {string} clipId - The clip ID
   * @returns {string} Full path to clip thumbnail
   */
  getThumbnailPath(clipId) {
    return path.join(this.storagePaths.thumbnails, `${clipId}.jpg`);
  }

  /**
   * Get a temporary file path for processing
   * @param {string} clipId - The clip ID
   * @param {string} extension - File extension
   * @returns {string} Full path to temp file
   */
  getTempPath(clipId, extension = 'mp4') {
    return path.join(this.storagePaths.temp, `${clipId}_temp.${extension}`);
  }

  /**
   * Check if a clip video file exists
   * @param {string} clipId - The clip ID
   * @returns {boolean} True if file exists
   */
  clipExists(clipId) {
    return fs.existsSync(this.getClipPath(clipId));
  }

  /**
   * Check if a clip thumbnail exists
   * @param {string} clipId - The clip ID
   * @returns {boolean} True if thumbnail exists
   */
  thumbnailExists(clipId) {
    return fs.existsSync(this.getThumbnailPath(clipId));
  }

  /**
   * Get file size for a clip
   * @param {string} clipId - The clip ID
   * @returns {number|null} File size in bytes or null if not found
   */
  getClipSize(clipId) {
    const clipPath = this.getClipPath(clipId);
    if (fs.existsSync(clipPath)) {
      return fs.statSync(clipPath).size;
    }
    return null;
  }

  /**
   * Delete a clip's files (video and thumbnail)
   * @param {string} clipId - The clip ID
   * @returns {Object} Result with deleted files
   */
  deleteClip(clipId) {
    const result = { video: false, thumbnail: false };

    const clipPath = this.getClipPath(clipId);
    const thumbPath = this.getThumbnailPath(clipId);

    if (fs.existsSync(clipPath)) {
      fs.unlinkSync(clipPath);
      result.video = true;
      logger.debug(`🗑️ CLIPS: Deleted video for clip ${clipId}`);
    }

    if (fs.existsSync(thumbPath)) {
      fs.unlinkSync(thumbPath);
      result.thumbnail = true;
      logger.debug(`🗑️ CLIPS: Deleted thumbnail for clip ${clipId}`);
    }

    return result;
  }

  /**
   * Clean up temporary files older than specified age
   * @param {number} maxAgeMs - Maximum age in milliseconds (default 24 hours)
   * @returns {number} Number of files deleted
   */
  cleanupTempFiles(maxAgeMs = 24 * 60 * 60 * 1000) {
    let deletedCount = 0;
    const now = Date.now();

    try {
      const tempFiles = fs.readdirSync(this.storagePaths.temp);

      for (const file of tempFiles) {
        const filePath = path.join(this.storagePaths.temp, file);
        const stats = fs.statSync(filePath);
        const age = now - stats.mtimeMs;

        if (age > maxAgeMs) {
          fs.unlinkSync(filePath);
          deletedCount++;
        }
      }

      if (deletedCount > 0) {
        logger.debug(`🧹 CLIPS: Cleaned up ${deletedCount} temp files`);
      }
    } catch (error) {
      logger.error('❌ CLIPS: Error cleaning up temp files:', error);
    }

    return deletedCount;
  }

  /**
   * Get storage statistics
   * @returns {Object} Storage stats
   */
  getStorageStats() {
    const stats = {
      videos: { count: 0, size: 0 },
      thumbnails: { count: 0, size: 0 },
      temp: { count: 0, size: 0 },
      total: { count: 0, size: 0 }
    };

    try {
      // Count videos
      const videos = fs.readdirSync(this.storagePaths.videos);
      stats.videos.count = videos.length;
      for (const file of videos) {
        const filePath = path.join(this.storagePaths.videos, file);
        stats.videos.size += fs.statSync(filePath).size;
      }

      // Count thumbnails
      const thumbnails = fs.readdirSync(this.storagePaths.thumbnails);
      stats.thumbnails.count = thumbnails.length;
      for (const file of thumbnails) {
        const filePath = path.join(this.storagePaths.thumbnails, file);
        stats.thumbnails.size += fs.statSync(filePath).size;
      }

      // Count temp files
      const tempFiles = fs.readdirSync(this.storagePaths.temp);
      stats.temp.count = tempFiles.length;
      for (const file of tempFiles) {
        const filePath = path.join(this.storagePaths.temp, file);
        stats.temp.size += fs.statSync(filePath).size;
      }

      // Calculate totals
      stats.total.count = stats.videos.count + stats.thumbnails.count + stats.temp.count;
      stats.total.size = stats.videos.size + stats.thumbnails.size + stats.temp.size;

    } catch (error) {
      logger.error('❌ CLIPS: Error getting storage stats:', error);
    }

    return stats;
  }

  /**
   * Format bytes to human readable string
   * @param {number} bytes - Size in bytes
   * @returns {string} Formatted size string
   */
  formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
  }
}

module.exports = ClipStorageService;
