const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const logger = require('../bootstrap/logger').child({ svc: 'RecordingService' });

const RecordingMediaPipeline = require('./recording/RecordingMediaPipeline');
const RecordingPersistence = require('./recording/RecordingPersistence');

class RecordingService {
  constructor(database, mediasoupService, storageService) {
    this.database = database;
    this.db = database.db;
    this.runAsync = database.runAsync;
    this.getAsync = database.getAsync;
    this.allAsync = database.allAsync;
    this.mediasoupService = mediasoupService;
    this.storageService = storageService;
    this.activeRecordings = new Map();
    this.continuousRecordingState = {
      enabled: false,
      quality: '720p',
      sessionId: null,
      currentRecording: null,
      streamSwitches: 0
    };
    
    // Storage paths
    this.storagePaths = {
      active: path.join(__dirname, '..', '..', 'recordings', 'active'),
      processing: path.join(__dirname, '..', '..', 'recordings', 'processing'),
      completed: path.join(__dirname, '..', '..', 'recordings', 'completed'),
      archived: path.join(__dirname, '..', '..', 'recordings', 'archived'),
      thumbnails: path.join(__dirname, '..', '..', 'recordings', 'thumbnails'),
      metadata: path.join(__dirname, '..', '..', 'recordings', 'metadata'),
      temp: path.join(__dirname, '..', '..', 'recordings', 'temp'),
      backups: path.join(__dirname, '..', '..', 'recordings', 'backups')
    };
    
    this.qualityProfiles = {
      '480p': {
        videoBitrate: '800k',
        audioBitrate: '96k',
        resolution: '854x480',
        fps: 30
      },
      '720p': {
        videoBitrate: '1800k',
        audioBitrate: '128k',
        resolution: '1280x720',
        fps: 30
      },
      '1080p': {
        videoBitrate: '3500k',
        audioBitrate: '192k',
        resolution: '1920x1080',
        fps: 30
      }
    };
    
    // Cohesive collaborators (state stays on this service via `owner`).
    this.mediaPipeline = new RecordingMediaPipeline(this);
    this.persistence = new RecordingPersistence(this);

    logger.debug('📁 RECORDING: Initializing recording directories...');
    this.initializeDirectories();
    this.setupStreamSwitchListeners();
    logger.debug('🎯 RECORDING: Setting up stream switch listeners');
  }
  
  initializeDirectories() {
    Object.values(this.storagePaths).forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        logger.debug(`📁 RECORDING: Created directory: ${dir}`);
      }
    });
  }
  
  setupStreamSwitchListeners() {
    // Stream switch detection will be handled through the main server hooks
    // MediaSoup service doesn't directly emit events
  }
  
  async handleStreamStart(streamerId) {
    logger.debug(`🎬 RECORDING: Stream started for ${streamerId}`);
    
    if (this.continuousRecordingState.enabled) {
      logger.debug(`🔄 RECORDING: Continuous recording is enabled, handling stream switch`);
      
      // If there's an active recording, it means we're switching streams
      if (this.continuousRecordingState.currentRecording) {
        logger.debug(`🔄 RECORDING: Stream switch detected from previous to ${streamerId}`);
        this.continuousRecordingState.streamSwitches++;
        
        // Stop the current recording segment
        await this.stopRecording(this.continuousRecordingState.currentRecording);
      }
      
      // Start a new recording segment for the new stream (producers are ready)
      logger.debug(`🎬 RECORDING: Starting continuous recording segment for ${streamerId}`);
      const result = await this.startRecording(streamerId, this.continuousRecordingState.quality, 'continuous');
      
      if (result.success) {
        this.continuousRecordingState.currentRecording = result.recordingId;
        logger.debug(`✅ RECORDING: Continuous recording segment started: ${result.recordingId}`);
      } else {
        logger.error(`❌ RECORDING: Failed to start continuous recording segment: ${result.error}`);
        // Retry after a delay
        setTimeout(async () => {
          logger.debug(`🔄 RECORDING: Retrying continuous recording start for ${streamerId}`);
          const retryResult = await this.startRecording(streamerId, this.continuousRecordingState.quality, 'continuous');
          if (retryResult.success) {
            this.continuousRecordingState.currentRecording = retryResult.recordingId;
            logger.debug(`✅ RECORDING: Continuous recording started on retry: ${retryResult.recordingId}`);
          }
        }, 3000);
      }
    } else {
      logger.debug(`⏸️ RECORDING: Continuous recording not enabled, skipping stream start for ${streamerId}`);
    }
  }
  
  async handleStreamEnd(streamerId) {
    logger.debug(`🔚 RECORDING: Stream ended for ${streamerId}`);
    
    if (this.continuousRecordingState.enabled && this.continuousRecordingState.currentRecording) {
      logger.debug(`🔄 RECORDING: Stream ended for ${streamerId}, stopping recording segment`);
      await this.stopRecording(this.continuousRecordingState.currentRecording);
      this.continuousRecordingState.currentRecording = null;
    }
  }
  
  async startRecording(streamerId, quality = '720p', mode = 'manual') {
    logger.debug(`🎬 RECORDING: Starting recording for streamer: ${streamerId}`);
    const recordingId = uuidv4();
    
    try {
      // Verify stream is active
      logger.debug(`🔍 RECORDING: Checking stream status for recording:`);
      const currentStreamer = this.mediasoupService.getCurrentStreamer();
      if (!currentStreamer || currentStreamer !== streamerId) {
        logger.debug(`❌ RECORDING: Streamer mismatch - requested: ${streamerId}, current: ${currentStreamer}`);
        return { success: false, error: 'Streamer is not currently streaming' };
      }
      
      // Check if producers exist
      const producerMap = this.mediasoupService.producers.get(currentStreamer);
      if (!producerMap || producerMap.size === 0) {
        logger.debug(`❌ RECORDING: No producers available for ${streamerId}`);
        return { success: false, error: 'No producers available for recording' };
      }
      
      logger.debug(`✅ RECORDING: Found ${producerMap.size} producers for ${streamerId}`);
      
      // Create recording session
      const recordingSession = {
        id: recordingId,
        streamerId: streamerId,
        quality: quality,
        profile: this.qualityProfiles[quality],
        startTime: new Date(),
        status: 'initializing',
        transports: new Map(),  // Will hold video and audio transports
        consumers: new Map(),
        ffmpegProcess: null,
        filePath: null
      };
      
      // Generate file path
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const fileName = `recording_${streamerId}_${timestamp}_${quality}.webm`;
      recordingSession.filePath = path.join(this.storagePaths.active, fileName);
      
      // Create separate MediaSoup plain transports for audio and video
      const transportsResult = await this.createPlainTransports();
      if (!transportsResult.success) {
        return { success: false, error: transportsResult.error };
      }
      
      recordingSession.transports = transportsResult.transports;
      recordingSession.status = 'connecting';
      
      // Create consumers for existing producers
      const consumersResult = await this.createConsumers(recordingSession);
      if (!consumersResult.success) {
        await this.cleanupRecordingSession(recordingSession);
        return { success: false, error: consumersResult.error };
      }
      
      // Start FFmpeg recording process with RTP input
      const ffmpegResult = await this.startFFmpegRecording(recordingSession);
      if (!ffmpegResult.success) {
        await this.cleanupRecordingSession(recordingSession);
        return { success: false, error: ffmpegResult.error };
      }
      
      recordingSession.ffmpegProcess = ffmpegResult.process;
      recordingSession.status = 'recording';
      
      // Store recording session
      this.activeRecordings.set(recordingId, recordingSession);
      
      // Save to database
      await this.saveRecordingToDatabase(recordingSession);
      
      // Log recording event
      await this.logRecordingEvent(recordingId, 'started', { 
        streamerId, 
        quality, 
        filePath: recordingSession.filePath 
      });
      
      logger.debug(`✅ RECORDING: Started recording ${recordingId} for ${streamerId}`);
      
      return {
        success: true,
        recordingId: recordingId,
        filePath: recordingSession.filePath,
        quality: quality,
        startTime: recordingSession.startTime
      };
      
    } catch (error) {
      logger.error('❌ RECORDING: Failed to start recording:', error);
      return { success: false, error: error.message };
    }
  }
  
  async stopRecording(recordingId, userId = 'system') {
    logger.debug(`🛑 RECORDING: Stopping recording: ${recordingId}`);
    
    try {
      const recordingSession = this.activeRecordings.get(recordingId);
      if (!recordingSession) {
        return { success: false, error: 'Recording not found' };
      }
      
      recordingSession.status = 'stopping';
      recordingSession.endTime = new Date();
      
      // Stop FFmpeg process gracefully
      if (recordingSession.ffmpegProcess) {
        try {
          recordingSession.ffmpegProcess.stdin.write('q'); // Send quit command
        } catch(e) {
          // stdin might be closed
        }
        recordingSession.ffmpegProcess.kill('SIGTERM');
        
        // Wait a moment for graceful shutdown
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
      // Cleanup MediaSoup resources
      await this.cleanupRecordingSession(recordingSession);
      
      // Move file to completed directory
      if (fs.existsSync(recordingSession.filePath)) {
        const completedPath = recordingSession.filePath.replace('\\active\\', '\\completed\\').replace('/active/', '/completed/');
        const completedDir = path.dirname(completedPath);
        
        // Ensure completed directory exists
        if (!fs.existsSync(completedDir)) {
          fs.mkdirSync(completedDir, { recursive: true });
        }
        
        fs.renameSync(recordingSession.filePath, completedPath);
        recordingSession.filePath = completedPath;
        logger.debug(`📁 RECORDING: Moved to completed: ${completedPath}`);
      }
      
      recordingSession.status = 'completed';
      
      // Update database
      await this.updateRecordingInDatabase(recordingSession);
      
      // Log recording event
      await this.logRecordingEvent(recordingId, 'stopped', { 
        userId,
        duration: recordingSession.endTime - recordingSession.startTime,
        filePath: recordingSession.filePath
      });
      
      // Remove from active recordings
      this.activeRecordings.delete(recordingId);
      
      // Trigger post-processing (compression)
      this.triggerPostProcessing(recordingSession);
      
      logger.debug(`✅ RECORDING: Stopped recording ${recordingId}`);
      
      return {
        success: true,
        recordingId: recordingId,
        duration: recordingSession.endTime - recordingSession.startTime,
        filePath: recordingSession.filePath
      };
      
    } catch (error) {
      logger.error('❌ RECORDING: Failed to stop recording:', error);
      return { success: false, error: error.message };
    }
  }
  
  async createPlainTransports() {
    return this.mediaPipeline.createPlainTransports();
  }

  async createConsumers(recordingSession) {
    return this.mediaPipeline.createConsumers(recordingSession);
  }

  async startFFmpegRecording(recordingSession) {
    return this.mediaPipeline.startFFmpegRecording(recordingSession);
  }

  async cleanupRecordingSession(recordingSession) {
    return this.mediaPipeline.cleanupRecordingSession(recordingSession);
  }

  // Continuous recording methods
  async enableContinuousRecording(quality = '720p') {
    logger.debug(`🔄 RECORDING: Enabling continuous recording mode (${quality})`);
    
    this.continuousRecordingState.enabled = true;
    this.continuousRecordingState.quality = quality;
    this.continuousRecordingState.sessionId = uuidv4();
    this.continuousRecordingState.streamSwitches = 0;
    
    // If there's already an active stream, start recording immediately
    const currentStreamer = this.mediasoupService?.getCurrentStreamer();
    if (currentStreamer) {
      logger.debug(`🔍 RECORDING: Checking for active stream to record:`);
      logger.debug(`   Current streamer: ${currentStreamer}`);
      logger.debug(`   Has producers: ${this.mediasoupService.producers.has(currentStreamer)}`);
      
      if (this.mediasoupService.producers.has(currentStreamer)) {
        logger.debug(`🎬 RECORDING: Active stream detected for ${currentStreamer}, starting continuous recording`);
        await this.handleStreamStart(currentStreamer);
      }
    }
    
    return {
      success: true,
      sessionId: this.continuousRecordingState.sessionId,
      quality: quality
    };
  }
  
  async disableContinuousRecording() {
    logger.debug(`🛑 RECORDING: Disabling continuous recording mode`);
    
    // Stop current recording if active
    if (this.continuousRecordingState.currentRecording) {
      await this.stopRecording(this.continuousRecordingState.currentRecording);
    }
    
    this.continuousRecordingState.enabled = false;
    this.continuousRecordingState.sessionId = null;
    this.continuousRecordingState.currentRecording = null;
    
    return { success: true };
  }
  
  getContinuousRecordingStatus() {
    const currentStreamer = this.mediasoupService?.getCurrentStreamer();
    return {
      ...this.continuousRecordingState,
      isRecording: !!this.continuousRecordingState.currentRecording && !!currentStreamer
    };
  }
  
  // Database methods
  async saveRecordingToDatabase(recordingSession) {
    return this.persistence.saveRecordingToDatabase(recordingSession);
  }

  async updateRecordingInDatabase(recordingSession) {
    return this.persistence.updateRecordingInDatabase(recordingSession);
  }

  async logRecordingEvent(recordingId, eventType, metadata = {}) {
    return this.persistence.logRecordingEvent(recordingId, eventType, metadata);
  }

  async getRecordingsList(limit = 50, offset = 0, status = null) {
    return this.persistence.getRecordingsList(limit, offset, status);
  }

  async getActiveRecordings() {
    const activeRecordings = [];
    
    for (const [id, session] of this.activeRecordings) {
      activeRecordings.push({
        id: id,
        streamerId: session.streamerId,
        quality: session.quality,
        startTime: session.startTime,
        status: session.status,
        progress: session.lastProgress
      });
    }
    
    return activeRecordings;
  }
  
  async getSystemStatus() {
    const status = {
      activeRecordings: this.activeRecordings.size,
      maxConcurrentRecordings: 5,
      qualityProfiles: Object.keys(this.qualityProfiles)
    };
    
    return status;
  }
  
  triggerPostProcessing(recordingSession) {
    logger.debug(`🔄 RECORDING: Triggering post-processing for ${recordingSession.id}`);
    // This would trigger compression service if needed
    // For now, recordings go directly to completed folder
  }
}

module.exports = RecordingService;
