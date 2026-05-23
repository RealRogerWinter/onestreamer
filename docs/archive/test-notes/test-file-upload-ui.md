> Archived 2026-05-23 — historical note, not maintained. See /docs/ for current state.

# Video File Upload UI Test Guide

## Quick UI Test Steps

1. **Start the Server**
   ```bash
   npm start
   ```

2. **Open Admin Panel**
   - Go to http://localhost:3000
   - Press `Ctrl+Shift+A` to open admin panel
   - Login with admin key: `***REMOVED-ADMIN-KEY***`

3. **Test File Upload UI**
   - Click on "🤖 ViewBot" tab
   - Click "➕ Create Bot"
   - Change "Content Type" to "Video File"
   - You should now see:
     - **📁 Choose Video File** button (blue button)
     - **Text input** for manual file path entry
     - **File selection area** with both options

4. **Test File Selection**
   - Click "📁 Choose Video File"
   - Browser file picker should open
   - Only video files should be selectable (`video/*` filter)
   - Select any video file (.mp4, .avi, .mov, etc.)

5. **Expected Behavior**
   - After selection, button shows "⏳ Uploading..."
   - File uploads to server (check network tab for upload progress)
   - On success: File path fills in automatically
   - Green "Selected" box appears below showing filename
   - Text input shows full server file path

6. **Test Manual Path Entry**
   - You can also type a file path directly in the text input
   - This bypasses upload and uses existing server files

7. **Create ViewBot with Video**
   - Set desired resolution and frame rate
   - Click "🎬 Create & Start Streaming"
   - ViewBot should start streaming your video file
   - Check browser for video content (should see your video looping)

## Expected UI Features

### File Input Section
```
Video File:
[📁 Choose Video File]  <- Blue upload button
[Or enter file path manually...]  <- Text input for manual entry
📹 Selected: myvideo.mp4  <- Green confirmation box (appears after upload)
```

### Upload States
- **Normal**: Blue button with "📁 Choose Video File"
- **Uploading**: Orange button with "⏳ Uploading..."
- **Completed**: File path shows in text input, green selected box appears

### File Validation
- Only video files accepted (`video/*` MIME type)
- 500MB file size limit
- Security validation on server side

## Backend Endpoints Added

1. **POST /admin/upload-video**
   - Handles multipart file upload
   - Validates video file type and size
   - Stores in `server/uploads/` directory
   - Returns file path for ViewBot configuration

2. **GET /admin/uploaded-videos**
   - Lists all uploaded video files
   - Shows file metadata (size, dates)

3. **DELETE /admin/uploaded-videos/:filename**
   - Removes uploaded video files
   - Security checks for path traversal

## FFmpeg Integration

ViewBot now supports video file input in RTP streaming:
- **Video stream**: Loops video file infinitely with `-stream_loop -1`
- **Audio stream**: Extracts audio from video file
- **Scaling**: Resizes video to match ViewBot resolution settings
- **Format**: Converts to VP8/Opus for WebRTC compatibility

## Test Results Verification

✅ **UI Components**: File picker, upload button, path input  
✅ **File Upload**: Multipart upload with progress indication  
✅ **Backend Storage**: Files saved to server/uploads/  
✅ **FFmpeg Integration**: Video file streaming via RTP  
✅ **ViewBot Creation**: Video file ViewBots work like test patterns  
✅ **Stream Display**: Viewers see actual video content  