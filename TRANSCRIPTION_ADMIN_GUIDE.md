# Transcription Admin Panel Guide

## Access the Admin Panel

### Main Dashboard
Navigate to: `http://localhost:8080/admin-dashboard.html`
- Central hub for all admin functions
- Quick stats overview
- Links to all admin panels

### Transcription Manager
Direct access: `http://localhost:8080/transcription-admin.html`

## Features

### 1. Real-Time Transcription Control
- **Enable/Disable Service**: Toggle transcription on/off globally
- **Model Selection**: Choose between tiny, base, small, medium, or large Whisper models
- **Language Settings**: Auto-detect or specify target language
- **Active Streamer Selection**: Pick which stream to transcribe

### 2. Live Transcription Display
- **Real-time Updates**: See transcription chunks as they're processed
- **Chunk Information**: Timestamp and chunk number for each segment
- **Word Count**: Track total words transcribed
- **Export Options**: 
  - Copy to clipboard
  - Export as text file
  - Clear display

### 3. Transcription History
- **Browse Past Transcriptions**: View all completed and active sessions
- **Session Details**:
  - Session ID
  - Streamer name
  - Start time and duration
  - Total word count
  - Language and status
- **View Full Transcripts**: Click "View" to see complete text
- **Search & Filter**: 
  - Search by text
  - Filter by date
  - Filter by status
- **Bulk Actions**:
  - Export all transcriptions
  - Delete old transcriptions (30+ days)

### 4. Statistics Dashboard
- **Active Sessions**: Current transcription count
- **Words Today**: Total words transcribed
- **Current Model**: Active Whisper model
- **Language**: Current language setting

## Usage Instructions

### Starting a Transcription

1. **Ensure a stream is active**
   - Check the "Active Streamer" dropdown
   - If empty, start a stream first

2. **Configure settings**
   - Select desired Whisper model
   - Choose language (or auto-detect)
   - Enable transcription service

3. **Start transcription**
   - Select the streamer from dropdown
   - Click "Start Transcription"
   - Monitor live display for real-time text

### Stopping a Transcription

1. Click "Stop Transcription" button
2. Transcription will be saved to database
3. View in history section

### Managing Settings

1. **Change Model**:
   - Select new model from dropdown
   - Click "Apply Settings"
   - Note: Larger models = better accuracy but higher CPU usage

2. **Change Language**:
   - Select target language
   - Click "Apply Settings"
   - Use "auto" for automatic detection

### Viewing History

1. **Browse transcriptions**:
   - Scroll through table
   - Use pagination for older entries

2. **View full transcript**:
   - Click "View" button
   - Modal shows complete text
   - Options to copy or download

3. **Search transcriptions**:
   - Enter search terms
   - Select date range
   - Filter by status

## API Integration

The admin panel uses these endpoints:

### Configuration
- `POST /admin/transcription/config` - Update settings
- `GET /admin/transcription/status` - Get current status

### Control
- `POST /admin/transcription/start` - Start transcription
- `POST /admin/transcription/stop/:sessionId` - Stop transcription

### Data
- `GET /api/transcription/:sessionId` - Get specific transcript
- `GET /api/transcriptions/history` - Get transcription history
- `GET /api/transcriptions/active` - Get active sessions

### Maintenance
- `DELETE /admin/transcriptions/old` - Delete old transcriptions

## WebSocket Events

The panel listens for real-time updates:

- `transcription-started` - New session started
- `transcription-update` - New text chunk available
- `transcription-stopped` - Session ended
- `stream-started` - New stream available
- `stream-ended` - Stream stopped

## Performance Considerations

### Model Selection Guide
| Model  | Size    | Speed | Accuracy | Use Case |
|--------|---------|-------|----------|----------|
| Tiny   | 39 MB   | Fast  | Basic    | Testing/Low CPU |
| Base   | 142 MB  | Good  | Good     | Recommended |
| Small  | 466 MB  | OK    | Better   | Quality focus |
| Medium | 1.5 GB  | Slow  | High     | Accuracy priority |
| Large  | 2.9 GB  | Slowest | Best   | Maximum quality |

### Resource Usage
- CPU: 1-2 cores per active transcription
- RAM: 200-500MB per session
- Network: Minimal (WebSocket updates only)

## Troubleshooting

### No Active Streamer
- Ensure a stream is running
- Check MediaSoup connection
- Verify streamer has audio enabled

### No Transcription Output
- Check Whisper model is downloaded
- Verify FFmpeg is installed
- Check audio is being received
- Review server logs for errors

### Poor Transcription Quality
- Try a larger model
- Ensure good audio quality
- Check language settings match audio
- Reduce background noise

### High CPU Usage
- Switch to smaller model
- Increase chunk duration in settings
- Limit concurrent transcriptions

## Security Notes

- Admin panel requires authentication (admin key)
- Transcripts are stored locally
- No external API calls (privacy-focused)
- Access logs are maintained

## Quick Tips

1. **Best Performance**: Use base model with English language
2. **Best Quality**: Use large model with specific language
3. **Storage**: Regularly clean old transcriptions to save space
4. **Export**: Download important transcripts for backup
5. **Monitor**: Watch CPU usage during transcription

## Support

For issues:
1. Check server console for errors
2. Verify Whisper setup completed successfully
3. Test with smaller audio chunks
4. Review TRANSCRIPTION_GUIDE.md for setup details