const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const { spawn } = require('child_process');

const logger = require('../bootstrap/logger').child({ svc: 'RecordingService' });

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
    try {
      logger.debug(`📡 RECORDING: Creating plain transports for recording`);
      
      const router = this.mediasoupService.router;
      if (!router) {
        throw new Error('MediaSoup router not available');
      }
      
      const transports = new Map();
      const ffmpegPorts = {
        video: 5004,
        audio: 5006
      };
      
      // Create video transport
      try {
        const videoTransport = await router.createPlainTransport({
          listenIp: {
            ip: '127.0.0.1',
            announcedIp: null
        },
          rtcpMux: false,
          comedia: false
        });
        
        // Connect video transport to FFmpeg video port
        await videoTransport.connect({
          ip: '127.0.0.1',
          port: ffmpegPorts.video,
          rtcpPort: ffmpegPorts.video + 1
        });
        
        logger.debug(`📡 RECORDING: Video transport created and connected:`);
        logger.debug(`   Transport ID: ${videoTransport.id}`);
        logger.debug(`   Destination: 127.0.0.1:${ffmpegPorts.video}`);
        
        transports.set('video', videoTransport);
      } catch (error) {
        logger.error(`❌ RECORDING: Failed to create video transport:`, error);
      }
      
      // Create audio transport
      try {
        const audioTransport = await router.createPlainTransport({
          listenIp: {
            ip: '127.0.0.1',
            announcedIp: null
          },
          rtcpMux: false,
          comedia: false
        });
        
        // Connect audio transport to FFmpeg audio port
        await audioTransport.connect({
          ip: '127.0.0.1',
          port: ffmpegPorts.audio,
          rtcpPort: ffmpegPorts.audio + 1
        });
        
        logger.debug(`📡 RECORDING: Audio transport created and connected:`);
        logger.debug(`   Transport ID: ${audioTransport.id}`);
        logger.debug(`   Destination: 127.0.0.1:${ffmpegPorts.audio}`);
        
        transports.set('audio', audioTransport);
      } catch (error) {
        logger.error(`❌ RECORDING: Failed to create audio transport:`, error);
      }
      
      if (transports.size === 0) {
        return { success: false, error: 'Failed to create any transports' };
      }
      
      // Store FFmpeg ports for later use
      transports.ffmpegPorts = ffmpegPorts;
      
      return { success: true, transports };
      
    } catch (error) {
      logger.error(`❌ RECORDING: Failed to create plain transports:`, error);
      return { success: false, error: error.message };
    }
  }
  
  async createConsumers(recordingSession) {
    try {
      logger.debug(`👥 RECORDING: Creating consumers for recording ${recordingSession.id}`);
      
      const currentStreamer = this.mediasoupService.getCurrentStreamer();
      const producerMap = this.mediasoupService.producers.get(currentStreamer);
      
      if (!producerMap || producerMap.size === 0) {
        return { success: false, error: 'No producers available for recording' };
      }
      
      const transports = recordingSession.transports;
      const consumers = recordingSession.consumers;
      
      // Create consumer for each producer using the appropriate transport
      for (const [kind, producer] of producerMap) {
        try {
          const transport = transports.get(kind);
          if (!transport) {
            logger.error(`❌ RECORDING: No transport available for ${kind}`);
            continue;
          }
          
          logger.debug(`🎬 RECORDING: Creating ${kind} consumer from producer ${producer.id}`);
          
          // For plain transport, we need to provide basic RTP capabilities
          const rtpCapabilities = {
            codecs: [
              {
                kind: kind,
                mimeType: kind === 'video' ? 'video/VP8' : 'audio/opus',
                clockRate: kind === 'video' ? 90000 : 48000,
                channels: kind === 'audio' ? 2 : undefined,
                parameters: {},
                rtcpFeedback: kind === 'video' ? [
                  { type: 'nack' },
                  { type: 'nack', parameter: 'pli' },
                  { type: 'ccm', parameter: 'fir' },
                  { type: 'goog-remb' }
                ] : [
                  { type: 'transport-cc' }
                ]
              }
            ],
            headerExtensions: []
          };
          
          const consumer = await transport.consume({
            producerId: producer.id,
            rtpCapabilities: rtpCapabilities,
            paused: false
          });
          
          // Resume the consumer to start receiving media
          await consumer.resume();
          
          logger.debug(`📊 RECORDING: ${kind} consumer created:`, {
            id: consumer.id,
            kind: consumer.kind,
            paused: consumer.paused,
            rtpParameters: {
              codecs: consumer.rtpParameters.codecs,
              encodings: consumer.rtpParameters.encodings
            }
          });
          
          consumer.on('transportclose', () => {
            logger.debug(`🔒 RECORDING: Transport closed for ${kind} consumer in recording ${recordingSession.id}`);
          });
          
          consumer.on('producerclose', () => {
            logger.debug(`🔒 RECORDING: Producer closed for ${kind} in recording ${recordingSession.id}`);
          });
          
          consumer.on('producerpause', () => {
            logger.debug(`⏸️ RECORDING: Producer paused for ${kind} in recording ${recordingSession.id}`);
          });
          
          consumer.on('producerresume', () => {
            logger.debug(`▶️ RECORDING: Producer resumed for ${kind} in recording ${recordingSession.id}`);
          });
          
          consumers.set(kind, consumer);
          logger.debug(`✅ RECORDING: Created and resumed ${kind} consumer for recording ${recordingSession.id}`);
          
        } catch (error) {
          logger.error(`❌ RECORDING: Failed to create ${kind} consumer:`, error);
        }
      }
      
      if (consumers.size === 0) {
        return { success: false, error: 'Failed to create any consumers' };
      }
      
      logger.debug(`✅ RECORDING: Successfully created ${consumers.size} consumers for recording`);
      return { success: true };
      
    } catch (error) {
      logger.error('❌ RECORDING: Failed to create consumers:', error);
      return { success: false, error: error.message };
    }
  }
  
  async startFFmpegRecording(recordingSession) {
    try {
      logger.debug(`🎬 RECORDING: Starting FFmpeg for recording ${recordingSession.id}`);
      
      const profile = recordingSession.profile;
      const filePath = recordingSession.filePath;
      const transports = recordingSession.transports;
      const consumers = recordingSession.consumers;
      
      // Get the RTP parameters from consumers
      const videoConsumer = consumers.get('video');
      const audioConsumer = consumers.get('audio');
      
      if (!videoConsumer && !audioConsumer) {
        return { success: false, error: 'No consumers available for recording' };
      }
      
      // Get the FFmpeg listening ports from transports
      const ffmpegPorts = transports.ffmpegPorts || { video: 5004, audio: 5006 };
      
      logger.debug(`🔧 RECORDING: FFmpeg will listen on ports:`);
      logger.debug(`   Video: ${ffmpegPorts.video}`);
      logger.debug(`   Audio: ${ffmpegPorts.audio}`);
      
      // Build FFmpeg command with direct UDP inputs
      const ffmpegArgs = [];
      
      if (videoConsumer) {
        const videoRtpParams = videoConsumer.rtpParameters;
        const videoCodec = videoRtpParams.codecs[0];
        const payloadType = videoCodec.payloadType;
        const ssrc = videoRtpParams.encodings[0].ssrc;
        
        logger.debug(`📹 RECORDING: Video - Codec: ${videoCodec.mimeType}, PT: ${payloadType}, SSRC: ${ssrc}`);
        
        // Create SDP for video
        const videoSdp = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=FFmpeg
c=IN IP4 127.0.0.1
t=0 0
m=video ${ffmpegPorts.video} RTP/AVP ${payloadType}
a=rtpmap:${payloadType} ${videoCodec.mimeType.replace('video/', '').toUpperCase()}/${videoCodec.clockRate}
`;
        
        const videoSdpPath = path.join(this.storagePaths.temp, `video_${recordingSession.id}.sdp`);
        fs.writeFileSync(videoSdpPath, videoSdp);
        
        ffmpegArgs.push(
          '-protocol_whitelist', 'file,udp,rtp',
          '-f', 'sdp',
          '-i', videoSdpPath
        );
      }
      
      if (audioConsumer) {
        const audioRtpParams = audioConsumer.rtpParameters;
        const audioCodec = audioRtpParams.codecs[0];
        const payloadType = audioCodec.payloadType;
        const ssrc = audioRtpParams.encodings[0].ssrc;
        
        logger.debug(`🎵 RECORDING: Audio - Codec: ${audioCodec.mimeType}, PT: ${payloadType}, SSRC: ${ssrc}`);
        
        // Create separate SDP for audio
        const audioSdp = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=FFmpeg
c=IN IP4 127.0.0.1
t=0 0
m=audio ${ffmpegPorts.audio} RTP/AVP ${payloadType}
a=rtpmap:${payloadType} ${audioCodec.mimeType.includes('opus') ? `opus/${audioCodec.clockRate}/2` : `${audioCodec.mimeType.replace('audio/', '')}/${audioCodec.clockRate}`}
`;
        
        const audioSdpPath = path.join(this.storagePaths.temp, `audio_${recordingSession.id}.sdp`);
        fs.writeFileSync(audioSdpPath, audioSdp);
        
        ffmpegArgs.push(
          '-protocol_whitelist', 'file,udp,rtp',
          '-f', 'sdp',
          '-i', audioSdpPath
        );
      }
      
      // Add output options
      ffmpegArgs.push(
        '-c:v', 'libvpx',
        '-b:v', profile.videoBitrate,
        '-c:a', 'libopus', 
        '-b:a', profile.audioBitrate,
        '-f', 'webm',
        '-y',
        filePath
      );
      
      logger.debug(`🚀 RECORDING: Starting FFmpeg with args:`, ffmpegArgs.join(' '));
      
      const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
      
      ffmpegProcess.stdout.on('data', (data) => {
        logger.debug(`📹 FFmpeg stdout: ${data}`);
      });
      
      ffmpegProcess.stderr.on('data', (data) => {
        const message = data.toString();
        // Log all FFmpeg output for debugging
        logger.debug(`📹 FFmpeg: ${message}`);
      });
      
      ffmpegProcess.on('error', (error) => {
        logger.error(`❌ RECORDING: FFmpeg error for ${recordingSession.id}:`, error);
        recordingSession.status = 'failed';
      });
      
      ffmpegProcess.on('close', (code) => {
        logger.debug(`🏁 RECORDING: FFmpeg closed for ${recordingSession.id} with code ${code}`);
        // Cleanup SDP files
        const tempFiles = fs.readdirSync(this.storagePaths.temp);
        tempFiles.forEach(file => {
          if (file.includes(recordingSession.id)) {
            fs.unlinkSync(path.join(this.storagePaths.temp, file));
          }
        });
      });
      
      // Give FFmpeg time to start up
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      return { success: true, process: ffmpegProcess };
      
    } catch (error) {
      logger.error('❌ RECORDING: Failed to start FFmpeg:', error);
      return { success: false, error: error.message };
    }
  }
  
  async cleanupRecordingSession(recordingSession) {
    logger.debug(`🧹 RECORDING: Cleaning up recording session ${recordingSession.id}`);
    
    try {
      // Close consumers
      if (recordingSession.consumers) {
        for (const [kind, consumer] of recordingSession.consumers) {
          if (!consumer.closed) {
            consumer.close();
          }
        }
        recordingSession.consumers.clear();
      }
      
      // Close transports
      if (recordingSession.transports) {
        for (const [kind, transport] of recordingSession.transports) {
          if (!transport.closed) {
            transport.close();
          }
        }
        recordingSession.transports.clear();
      }
      
    } catch (error) {
      logger.error('❌ RECORDING: Error during cleanup:', error);
    }
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
    try {
      const sql = `
        INSERT INTO recordings (
          id, stream_id, streamer_id, start_time, file_path, 
          quality_profile, format, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      
      await this.runAsync(sql, [
        recordingSession.id,
        recordingSession.id, // Using recording ID as stream ID for now
        recordingSession.streamerId,
        recordingSession.startTime.toISOString(),
        recordingSession.filePath,
        recordingSession.quality,
        'webm',
        recordingSession.status,
        new Date().toISOString()
      ]);
      
    } catch (error) {
      logger.error('❌ RECORDING: Failed to save to database:', error);
    }
  }
  
  async updateRecordingInDatabase(recordingSession) {
    try {
      const fileSize = fs.existsSync(recordingSession.filePath) 
        ? fs.statSync(recordingSession.filePath).size 
        : 0;
      
      const duration = recordingSession.endTime 
        ? Math.floor((recordingSession.endTime - recordingSession.startTime) / 1000)
        : 0;
      
      const sql = `
        UPDATE recordings 
        SET end_time = ?, duration = ?, file_size = ?, status = ?
        WHERE id = ?
      `;
      
      await this.runAsync(sql, [
        recordingSession.endTime?.toISOString(),
        duration,
        fileSize,
        recordingSession.status,
        recordingSession.id
      ]);
      
    } catch (error) {
      logger.error('❌ RECORDING: Failed to update database:', error);
    }
  }
  
  async logRecordingEvent(recordingId, eventType, metadata = {}) {
    try {
      const sql = `
        INSERT INTO recording_events (
          recording_id, event_type, metadata, timestamp
        ) VALUES (?, ?, ?, ?)
      `;
      
      await this.runAsync(sql, [
        recordingId,
        eventType,
        JSON.stringify(metadata),
        new Date().toISOString()
      ]);
      
    } catch (error) {
      logger.error('❌ RECORDING: Failed to log event:', error);
    }
  }
  
  async getRecordingsList(limit = 50, offset = 0, status = null) {
    try {
      let sql = `
        SELECT * FROM recordings 
        ${status ? 'WHERE status = ?' : ''}
        ORDER BY created_at DESC 
        LIMIT ? OFFSET ?
      `;
      
      const params = status ? [status, limit, offset] : [limit, offset];
      const recordings = await this.allAsync(sql, params);
      
      return recordings;
      
    } catch (error) {
      logger.error('❌ RECORDING: Failed to get recordings list:', error);
      return [];
    }
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
