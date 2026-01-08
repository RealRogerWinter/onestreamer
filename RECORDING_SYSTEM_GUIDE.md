# OneStreamer Recording System Guide

## Overview

The OneStreamer Recording System is a comprehensive solution for recording live MediaSoup streams, compressing them, and managing the recorded files. The system integrates seamlessly with the existing OneStreamer architecture and provides a professional-grade recording experience.

## Features

### 🎬 Core Recording
- **MediaSoup Integration**: Uses PlainTransport for efficient stream consumption
- **Multiple Quality Profiles**: 480p, 720p, and 1080p recording options
- **Real-time Recording**: Live stream capture with minimal latency
- **Concurrent Recording Support**: Record up to 3 streams simultaneously
- **WebM Format**: Optimal format for web compatibility and MediaSoup integration

### 🗜️ Compression Pipeline
- **Post-processing Compression**: Automatic compression after recording ends
- **Multiple Compression Profiles**: High quality, balanced, small size, web optimized
- **Background Processing**: Non-blocking compression queue system
- **Hardware Acceleration**: Support for GPU encoding (NVENC, Quick Sync)
- **Retry Mechanism**: Automatic retry for failed compressions

### 📁 File Management
- **Organized Storage**: Structured directory system for different recording states
- **Automatic Cleanup**: Configurable retention policies and auto-deletion
- **Metadata Tracking**: Comprehensive recording information and audit trails
- **Thumbnail Generation**: Preview images for recordings
- **Storage Monitoring**: Real-time storage usage and statistics

### 🎛️ Admin Interface
- **Recording Controls**: Start/stop recording with quality selection
- **Real-time Monitoring**: Live recording status and progress tracking
- **Recording History**: Searchable and filterable recording archive
- **System Status**: Overview of active recordings and system health
- **File Operations**: Download, delete, and manage recordings

## Architecture

### Core Components

1. **RecordingService** - Main orchestrator for recording operations
2. **MediaSoupRecorder** - Handles MediaSoup-specific recording logic
3. **FileCompressionService** - Manages post-recording compression
4. **RecordingStorageService** - Handles file storage and organization
5. **AdminRecordingInterface** - Admin panel integration

### Database Schema

```sql
-- Main recordings table
recordings (
  id, stream_id, streamer_id, start_time, end_time, duration,
  file_path, file_size, quality_profile, format, status,
  compression_status, thumbnail_path, metadata_json, created_at
)

-- Recording events for audit trail
recording_events (
  id, recording_id, event_type, event_data, user_id, timestamp
)

-- System settings
recording_settings (
  key, value, description, updated_at
)
```

### Directory Structure

```
recordings/
├── active/           # Currently recording files
├── processing/       # Files being compressed
├── completed/        # Ready for download
├── archived/         # Long-term storage
├── thumbnails/       # Preview images
├── metadata/         # Recording metadata files
├── temp/             # Temporary files (SDP, etc.)
└── backups/          # Backup storage
```

## Usage Guide

### Starting a Recording

1. **Access Admin Panel**: Press `Ctrl+Shift+A` to open the admin panel
2. **Navigate to Recordings**: Click the "📹 Recordings" tab
3. **Enter Streamer ID**: Input the ID of the streamer to record
4. **Select Quality**: Choose recording quality (480p, 720p, 1080p)
5. **Start Recording**: Click "🎬 Start Recording"

### Monitoring Active Recordings

- **Active Recordings Section**: Shows all currently recording streams
- **Real-time Status**: Recording duration, quality, and streamer info
- **Stop Recording**: Click "🛑 Stop" to end recording

### Managing Recorded Files

- **Recording History**: Browse all recordings with filters and search
- **Download**: Click "📥" to download completed recordings
- **Delete**: Click "🗑️" to permanently delete recordings
- **Status Filtering**: Filter by recording status (completed, processing, etc.)

### System Monitoring

- **System Status Cards**: Overview of active recordings, compression queue, and storage
- **Storage Statistics**: Real-time disk usage and file counts
- **Compression Queue**: Monitor background processing tasks

## API Endpoints

### Recording Control
- `POST /admin/recordings/start` - Start new recording
- `POST /admin/recordings/stop/:recordingId` - Stop active recording
- `GET /admin/recordings/status/:recordingId` - Get recording status

### Recording Management  
- `GET /admin/recordings/list` - List all recordings
- `GET /admin/recordings/download/:recordingId` - Download recording
- `DELETE /admin/recordings/:recordingId` - Delete recording

### System Management
- `GET /admin/recordings/active` - Get active recordings
- `GET /admin/recordings/system-status` - Get system status
- `POST /admin/recordings/cleanup` - Run manual cleanup
- `POST /admin/recordings/settings` - Update system settings

## Configuration

### Recording Settings

```javascript
const recordingConfig = {
  maxConcurrentRecordings: 3,      // Maximum simultaneous recordings
  maxRecordingDuration: 3600000,   // 1 hour maximum duration
  diskSpaceThreshold: 0.85,        // Stop at 85% disk usage
  compressionQueueLimit: 10,       // Maximum compression queue size
  defaultQuality: '720p'           // Default recording quality
};
```

### Quality Profiles

```javascript
const qualityProfiles = {
  '1080p': { width: 1920, height: 1080, videoBitrate: '3000k', audioBitrate: '192k' },
  '720p':  { width: 1280, height: 720,  videoBitrate: '1800k', audioBitrate: '128k' },
  '480p':  { width: 854,  height: 480,  videoBitrate: '1000k', audioBitrate: '96k' }
};
```

### Storage Policies

```javascript
const storageConfig = {
  retentionDays: 30,              // Keep recordings for 30 days
  autoCleanupEnabled: true,       // Enable automatic cleanup
  archiveThresholdDays: 7,        // Archive after 7 days
  thumbnailRetentionDays: 60      // Keep thumbnails for 60 days
};
```

## Error Handling

### Recording Failures
- **Transport Disconnection**: Automatic reconnection attempts
- **FFmpeg Crashes**: Process restart with state recovery
- **Disk Space Issues**: Automatic cleanup and alerts
- **MediaSoup Errors**: Graceful fallback and error reporting

### Compression Failures
- **Retry Logic**: Up to 3 automatic retries for failed compressions
- **Fallback Compression**: Lower quality if high quality fails
- **Queue Management**: Automatic requeuing of failed tasks

### Recovery Procedures
- **Database Consistency**: Automatic verification and repair
- **File Integrity**: Checksum validation for recorded files
- **Orphaned File Cleanup**: Regular cleanup of unreferenced files

## Performance Optimization

### Resource Management
- **Concurrent Limits**: Configurable limits prevent system overload
- **Memory Management**: Streaming operations to minimize memory usage
- **Process Monitoring**: Automatic cleanup of zombie processes

### Storage Optimization
- **Tiered Storage**: Hot/warm/cold storage based on access patterns
- **Compression Scheduling**: Off-peak compression for better performance
- **Space Monitoring**: Proactive cleanup before disk full

### Network Optimization
- **Local RTP**: Recording uses local RTP for minimal network impact
- **Bandwidth Adaptation**: Quality adjustment based on system load

## Troubleshooting

### Common Issues

1. **Recording Won't Start**
   - Check if streamer is currently streaming
   - Verify MediaSoup service is running
   - Ensure disk space is available
   - Check concurrent recording limits

2. **Poor Recording Quality**
   - Verify source stream quality
   - Check system CPU/memory usage
   - Review quality profile settings
   - Ensure sufficient bitrate allocation

3. **Compression Failures**
   - Verify FFmpeg installation
   - Check available disk space
   - Review compression queue status
   - Check file permissions

4. **Files Not Downloading**
   - Verify file exists in completed directory
   - Check file permissions
   - Ensure web server can access files
   - Review download logs

### Logs and Monitoring

- **Server Logs**: Check `server.log` for recording system messages
- **Admin Panel Logs**: Real-time logs in admin panel "📝 Logs" tab
- **Database Events**: Query `recording_events` table for audit trail
- **File System**: Check recording directories for file status

## Future Enhancements

### Planned Features
- **Cloud Storage Integration**: Automatic upload to AWS S3, Google Cloud
- **Live Transcoding**: Real-time quality adaptation during recording
- **Advanced Analytics**: Recording statistics and usage metrics
- **Multi-Format Export**: Support for MP4, HLS, and DASH formats
- **Collaborative Features**: User permissions and shared recordings

### Integration Options
- **CDN Distribution**: Automatic distribution to content delivery networks
- **Streaming Platforms**: Direct integration with YouTube, Twitch, etc.
- **Video Processing**: AI-powered highlights and content analysis
- **Backup Services**: Automated backup to external storage providers

## Support

For technical support or feature requests:
1. Check the admin panel logs for specific error messages
2. Review this documentation for common solutions
3. Run the test script: `node test-recording-system.js`
4. Check the OneStreamer server logs for detailed error information

---

**System Status**: ✅ Ready for Production Use
**Last Updated**: 2025-08-10
**Version**: 1.0.0