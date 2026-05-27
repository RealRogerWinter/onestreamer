const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const logger = require('../bootstrap/logger').child({ svc: 'RecordingStorageService' });
const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);
const unlink = promisify(fs.unlink);
const mkdir = promisify(fs.mkdir);
const copyFile = promisify(fs.copyFile);
const rename = promisify(fs.rename);

class RecordingStorageService {
  constructor(database) {
    this.db = database.db;
    this.runAsync = database.runAsync;
    this.getAsync = database.getAsync;
    this.allAsync = database.allAsync;
    
    // Storage configuration
    this.config = {
      retentionDays: 30,
      autoCleanupEnabled: true,
      maxStorageUsage: 0.90, // 90% of disk space
      archiveThresholdDays: 7,
      thumbnailRetentionDays: 60
    };
    
    // Storage paths
    this.storagePaths = {
      active: path.join(__dirname, '../../recordings/active'),
      processing: path.join(__dirname, '../../recordings/processing'),
      completed: path.join(__dirname, '../../recordings/completed'),
      archived: path.join(__dirname, '../../recordings/archived'),
      thumbnails: path.join(__dirname, '../../recordings/thumbnails'),
      metadata: path.join(__dirname, '../../recordings/metadata'),
      temp: path.join(__dirname, '../../recordings/temp'),
      backups: path.join(__dirname, '../../recordings/backups')
    };
    
    this.initializeStorage();
    this.startPeriodicCleanup();
  }
  
  async initializeStorage() {
    logger.debug('📁 STORAGE: Initializing recording storage directories...');
    
    try {
      // Create all required directories
      for (const [name, dirPath] of Object.entries(this.storagePaths)) {
        await this.ensureDirectory(dirPath);
        logger.debug(`📁 STORAGE: ${name} directory ready: ${dirPath}`);
      }
      
      // Create .gitkeep files to preserve empty directories in version control
      for (const dirPath of Object.values(this.storagePaths)) {
        const gitkeepPath = path.join(dirPath, '.gitkeep');
        if (!fs.existsSync(gitkeepPath)) {
          fs.writeFileSync(gitkeepPath, '# Keep this directory in version control\n');
        }
      }
      
      logger.debug('✅ STORAGE: Storage initialization completed');
      
    } catch (error) {
      logger.error('❌ STORAGE: Failed to initialize storage:', error);
      throw error;
    }
  }
  
  async ensureDirectory(dirPath) {
    try {
      await mkdir(dirPath, { recursive: true });
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
  }
  
  async moveRecording(recordingId, fromStatus, toStatus) {
    logger.debug(`📦 STORAGE: Moving recording ${recordingId} from ${fromStatus} to ${toStatus}`);
    
    try {
      // Get recording info from database
      const recording = await this.getRecording(recordingId);
      if (!recording) {
        throw new Error(`Recording not found: ${recordingId}`);
      }
      
      const fromPath = this.storagePaths[fromStatus];
      const toPath = this.storagePaths[toStatus];
      
      if (!fromPath || !toPath) {
        throw new Error(`Invalid storage status: ${fromStatus} -> ${toStatus}`);
      }
      
      // Find current file
      const currentFilePath = recording.file_path;
      if (!currentFilePath || !fs.existsSync(currentFilePath)) {
        throw new Error(`Current file not found: ${currentFilePath}`);
      }
      
      // Generate new file path
      const fileName = path.basename(currentFilePath);
      const newFilePath = path.join(toPath, fileName);
      
      // Move file
      await rename(currentFilePath, newFilePath);
      
      // Update database
      await this.updateRecordingFilePath(recordingId, newFilePath, toStatus);
      
      logger.debug(`✅ STORAGE: Moved recording ${recordingId} to ${toStatus}`);
      
      return { success: true, newPath: newFilePath };
      
    } catch (error) {
      logger.error(`❌ STORAGE: Failed to move recording ${recordingId}:`, error);
      return { success: false, error: error.message };
    }
  }
  
  async archiveRecording(recordingId) {
    logger.debug(`🗄️ STORAGE: Archiving recording ${recordingId}`);
    
    try {
      const result = await this.moveRecording(recordingId, 'completed', 'archived');
      if (result.success) {
        // Log archive event
        await this.logStorageEvent(recordingId, 'archived', { 
          archivedPath: result.newPath,
          archivedAt: new Date().toISOString()
        });
      }
      
      return result;
      
    } catch (error) {
      logger.error(`❌ STORAGE: Failed to archive recording:`, error);
      return { success: false, error: error.message };
    }
  }
  
  async deleteRecording(recordingId, userId = 'system') {
    logger.debug(`🗑️ STORAGE: Deleting recording ${recordingId}`);
    
    try {
      // Get recording info
      const recording = await this.getRecording(recordingId);
      if (!recording) {
        return { success: false, error: 'Recording not found' };
      }
      
      // Delete main file
      if (recording.file_path && fs.existsSync(recording.file_path)) {
        await unlink(recording.file_path);
        logger.debug(`🗑️ STORAGE: Deleted file: ${recording.file_path}`);
      }
      
      // Delete thumbnail if exists
      if (recording.thumbnail_path && fs.existsSync(recording.thumbnail_path)) {
        await unlink(recording.thumbnail_path);
        logger.debug(`🗑️ STORAGE: Deleted thumbnail: ${recording.thumbnail_path}`);
      }
      
      // Delete metadata file if exists
      const metadataPath = path.join(this.storagePaths.metadata, `${recordingId}.json`);
      if (fs.existsSync(metadataPath)) {
        await unlink(metadataPath);
        logger.debug(`🗑️ STORAGE: Deleted metadata: ${metadataPath}`);
      }
      
      // Log deletion event before removing from database
      await this.logStorageEvent(recordingId, 'deleted', { 
        userId,
        filePath: recording.file_path,
        fileSize: recording.file_size,
        deletedAt: new Date().toISOString()
      });
      
      // Remove from database
      await this.removeRecordingFromDatabase(recordingId);
      
      logger.debug(`✅ STORAGE: Recording ${recordingId} deleted completely`);
      
      return { success: true };
      
    } catch (error) {
      logger.error(`❌ STORAGE: Failed to delete recording:`, error);
      return { success: false, error: error.message };
    }
  }
  
  async cleanupOldRecordings() {
    logger.debug('🧹 STORAGE: Starting cleanup of old recordings...');
    
    try {
      let cleanedCount = 0;
      let archivedCount = 0;
      
      if (!this.config.autoCleanupEnabled) {
        logger.debug('⏭️ STORAGE: Auto cleanup is disabled');
        return { success: true, cleanedCount: 0, archivedCount: 0 };
      }
      
      const now = new Date();
      const retentionThreshold = new Date(now.getTime() - (this.config.retentionDays * 24 * 60 * 60 * 1000));
      const archiveThreshold = new Date(now.getTime() - (this.config.archiveThresholdDays * 24 * 60 * 60 * 1000));
      
      // Get recordings to process
      const query = `
        SELECT id, file_path, thumbnail_path, status, created_at, file_size
        FROM recordings 
        WHERE created_at < ? OR created_at < ?
        ORDER BY created_at ASC
      `;
      
      const recordings = await this.allAsync(query, [
        retentionThreshold.toISOString(),
        archiveThreshold.toISOString()
      ]);
      
      for (const recording of recordings) {
        const createdAt = new Date(recording.created_at);
        
        // Delete very old recordings
        if (createdAt < retentionThreshold) {
          const result = await this.deleteRecording(recording.id, 'cleanup');
          if (result.success) {
            cleanedCount++;
          }
        }
        // Archive old completed recordings
        else if (createdAt < archiveThreshold && recording.status === 'completed') {
          const result = await this.archiveRecording(recording.id);
          if (result.success) {
            archivedCount++;
          }
        }
      }
      
      // Cleanup orphaned files
      const orphanedCount = await this.cleanupOrphanedFiles();
      
      logger.debug(`✅ STORAGE: Cleanup completed - Deleted: ${cleanedCount}, Archived: ${archivedCount}, Orphaned: ${orphanedCount}`);
      
      return { 
        success: true, 
        cleanedCount, 
        archivedCount, 
        orphanedCount 
      };
      
    } catch (error) {
      logger.error('❌ STORAGE: Failed to cleanup old recordings:', error);
      return { success: false, error: error.message };
    }
  }
  
  async cleanupOrphanedFiles() {
    logger.debug('🔍 STORAGE: Checking for orphaned files...');
    
    try {
      let orphanedCount = 0;
      
      // Get all recordings from database
      const recordings = await this.allAsync('SELECT id, file_path FROM recordings');
      const recordingPaths = new Set(recordings.map(r => r.file_path).filter(Boolean));
      
      // Check each storage directory
      for (const [dirName, dirPath] of Object.entries(this.storagePaths)) {
        if (dirName === 'temp' || dirName === 'metadata') continue; // Skip temp and metadata dirs
        
        try {
          const files = await readdir(dirPath);
          
          for (const file of files) {
            if (file === '.gitkeep') continue;
            
            const filePath = path.join(dirPath, file);
            
            // Check if file is referenced in database
            if (!recordingPaths.has(filePath)) {
              // Check if file is old enough to be considered orphaned (1 hour)
              const fileStats = await stat(filePath);
              const fileAge = Date.now() - fileStats.mtime.getTime();
              
              if (fileAge > 60 * 60 * 1000) { // 1 hour
                logger.debug(`🗑️ STORAGE: Removing orphaned file: ${filePath}`);
                await unlink(filePath);
                orphanedCount++;
              }
            }
          }
          
        } catch (error) {
          logger.error(`❌ STORAGE: Error checking directory ${dirName}:`, error);
        }
      }
      
      return orphanedCount;
      
    } catch (error) {
      logger.error('❌ STORAGE: Failed to cleanup orphaned files:', error);
      return 0;
    }
  }
  
  async getStorageStatistics() {
    logger.debug('📊 STORAGE: Calculating storage statistics...');
    
    try {
      const stats = {
        directories: {},
        totalFiles: 0,
        totalSize: 0,
        recordingsByStatus: {},
        oldestRecording: null,
        newestRecording: null
      };
      
      // Calculate directory statistics
      for (const [dirName, dirPath] of Object.entries(this.storagePaths)) {
        const dirStats = await this.getDirectoryStats(dirPath);
        stats.directories[dirName] = dirStats;
        stats.totalFiles += dirStats.fileCount;
        stats.totalSize += dirStats.totalSize;
      }
      
      // Get recording statistics from database
      const recordingStats = await this.allAsync(`
        SELECT 
          status, 
          COUNT(*) as count,
          SUM(file_size) as total_size,
          MIN(created_at) as oldest,
          MAX(created_at) as newest
        FROM recordings 
        GROUP BY status
      `);
      
      for (const stat of recordingStats) {
        stats.recordingsByStatus[stat.status] = {
          count: stat.count,
          totalSize: stat.total_size || 0
        };
      }
      
      // Get oldest and newest recordings
      const dateStats = await this.getAsync(`
        SELECT 
          MIN(created_at) as oldest,
          MAX(created_at) as newest
        FROM recordings
      `);
      
      if (dateStats) {
        stats.oldestRecording = dateStats.oldest;
        stats.newestRecording = dateStats.newest;
      }
      
      return stats;
      
    } catch (error) {
      logger.error('❌ STORAGE: Failed to calculate storage statistics:', error);
      return null;
    }
  }
  
  async getDirectoryStats(dirPath) {
    try {
      const files = await readdir(dirPath);
      let fileCount = 0;
      let totalSize = 0;
      
      for (const file of files) {
        if (file === '.gitkeep') continue;
        
        try {
          const filePath = path.join(dirPath, file);
          const fileStats = await stat(filePath);
          
          if (fileStats.isFile()) {
            fileCount++;
            totalSize += fileStats.size;
          }
        } catch (error) {
          // Skip files that can't be accessed
          logger.warn(`⚠️ STORAGE: Cannot access file ${file}:`, error.message);
        }
      }
      
      return {
        fileCount,
        totalSize,
        formattedSize: this.formatFileSize(totalSize)
      };
      
    } catch (error) {
      logger.error(`❌ STORAGE: Failed to get directory stats for ${dirPath}:`, error);
      return { fileCount: 0, totalSize: 0, formattedSize: '0 B' };
    }
  }
  
  async saveRecordingMetadata(recordingId, metadata) {
    try {
      const metadataPath = path.join(this.storagePaths.metadata, `${recordingId}.json`);
      const metadataContent = JSON.stringify(metadata, null, 2);
      fs.writeFileSync(metadataPath, metadataContent);
      
      logger.debug(`💾 STORAGE: Saved metadata for recording ${recordingId}`);
      return { success: true, path: metadataPath };
      
    } catch (error) {
      logger.error(`❌ STORAGE: Failed to save metadata for ${recordingId}:`, error);
      return { success: false, error: error.message };
    }
  }
  
  async loadRecordingMetadata(recordingId) {
    try {
      const metadataPath = path.join(this.storagePaths.metadata, `${recordingId}.json`);
      
      if (!fs.existsSync(metadataPath)) {
        return { success: false, error: 'Metadata file not found' };
      }
      
      const metadataContent = fs.readFileSync(metadataPath, 'utf8');
      const metadata = JSON.parse(metadataContent);
      
      return { success: true, metadata };
      
    } catch (error) {
      logger.error(`❌ STORAGE: Failed to load metadata for ${recordingId}:`, error);
      return { success: false, error: error.message };
    }
  }
  
  startPeriodicCleanup() {
    // Run cleanup every 6 hours
    setInterval(() => {
      if (this.config.autoCleanupEnabled) {
        this.cleanupOldRecordings().catch(error => {
          logger.error('❌ STORAGE: Periodic cleanup failed:', error);
        });
      }
    }, 6 * 60 * 60 * 1000);
    
    logger.debug('⏰ STORAGE: Periodic cleanup scheduled every 6 hours');
  }
  
  async getRecording(recordingId) {
    try {
      const query = 'SELECT * FROM recordings WHERE id = ?';
      return await this.getAsync(query, [recordingId]);
    } catch (error) {
      logger.error(`❌ STORAGE: Failed to get recording ${recordingId}:`, error);
      return null;
    }
  }
  
  async updateRecordingFilePath(recordingId, filePath, status) {
    try {
      const query = `
        UPDATE recordings 
        SET file_path = ?, status = ?, updated_at = datetime('now')
        WHERE id = ?
      `;
      
      await this.runAsync(query, [filePath, status, recordingId]);
    } catch (error) {
      logger.error(`❌ STORAGE: Failed to update recording file path:`, error);
    }
  }
  
  async removeRecordingFromDatabase(recordingId) {
    try {
      await this.runAsync('DELETE FROM recordings WHERE id = ?', [recordingId]);
    } catch (error) {
      logger.error(`❌ STORAGE: Failed to remove recording from database:`, error);
    }
  }
  
  async logStorageEvent(recordingId, eventType, eventData, userId = 'system') {
    try {
      const query = `
        INSERT INTO recording_events (
          recording_id, event_type, event_data, user_id, timestamp
        ) VALUES (?, ?, ?, ?, datetime('now'))
      `;
      
      await this.runAsync(query, [
        recordingId,
        eventType,
        JSON.stringify(eventData),
        userId
      ]);
      
    } catch (error) {
      logger.error('❌ STORAGE: Failed to log storage event:', error);
    }
  }
  
  formatFileSize(bytes) {
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    if (bytes === 0) return '0 B';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
  }
  
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    logger.debug('⚙️ STORAGE: Configuration updated:', this.config);
  }
  
  getConfig() {
    return { ...this.config };
  }
}

module.exports = RecordingStorageService;
