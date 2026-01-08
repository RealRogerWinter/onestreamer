# OneStreamer Clips System Implementation Plan

## Executive Summary

This document outlines a comprehensive plan for implementing a clips system for OneStreamer that:
1. Allows users to create 30-second to 2-minute clips from streams
2. Enables posting clips with titles
3. Provides a browsable gallery at `onestreamer.live/clips/`
4. Supports browser-based clip playback
5. Enables shareable links to individual clips

The implementation leverages existing infrastructure while adapting for LiveKit compatibility.

---

## Current State Analysis

### Existing Recording System
- **RecordingService** (`server/services/RecordingService.js`): Uses MediaSoup PlainTransport to consume streams
- **Storage**: Recordings stored in `/root/onestreamer/recordings/` with subdirectories (active, completed, archived, etc.)
- **Format**: WebM files using VP8 video + Opus audio codecs
- **Database**: `recordings` table exists with metadata support

### LiveKit Integration
- **LiveKitService** (`server/services/LiveKitService.js`): Provides MediaSoup-compatible API wrapper
- **Configuration**: `server/config/webrtc.config.js` contains LiveKit host, API key, and secret
- **LiveKit Server**: Running locally at `http://127.0.0.1:7882`
- **Current Status**: No Egress/recording integration for LiveKit streams

### Key Challenge
The existing RecordingService creates MediaSoup PlainTransports and consumers - this architecture doesn't work with LiveKit. For LiveKit compatibility, we need to use **LiveKit's Egress API** for recording.

---

## Implementation Architecture

### High-Level Flow
```
┌─────────────────┐     ┌───────────────────┐     ┌──────────────────┐
│  LiveKit Room   │────>│  LiveKit Egress   │────>│  Recordings Dir  │
│  (Live Stream)  │     │  (Room Composite) │     │  /recordings/    │
└─────────────────┘     └───────────────────┘     └──────────────────┘
                                                          │
                                                          ▼
┌─────────────────┐     ┌───────────────────┐     ┌──────────────────┐
│  User Creates   │────>│  ClipProcessor    │────>│  Clips Directory │
│  Clip (UI)      │     │  (FFmpeg Trim)    │     │  /clips/         │
└─────────────────┘     └───────────────────┘     └──────────────────┘
                                                          │
                                                          ▼
┌─────────────────┐     ┌───────────────────┐     ┌──────────────────┐
│  Clips Gallery  │<────│  Clips API        │<────│  SQLite Database │
│  /clips/        │     │  /api/clips/      │     │  (clips table)   │
└─────────────────┘     └───────────────────┘     └──────────────────┘
```

---

## Phase 1: LiveKit Recording Integration

### 1.1 Create LiveKitEgressService
**File**: `server/services/LiveKitEgressService.js`

```javascript
// Service responsibilities:
// - Start room composite egress when stream begins
// - Stop egress when stream ends
// - Track egress status and file paths
// - Support continuous recording mode
```

**Key Methods**:
- `startRecording(options)` - Start egress recording
- `stopRecording(egressId)` - Stop egress recording
- `getEgressStatus(egressId)` - Get recording status
- `listActiveEgresses()` - List all active recordings

**LiveKit Egress Configuration**:
```javascript
{
  roomCompositeOptions: {
    layout: 'single-speaker',
    videoOnly: false,
    fileOutputs: [{
      filepath: '/recordings/active/{room_name}_{time}.mp4',
      disableManifest: true
    }]
  }
}
```

### 1.2 Adapt RecordingService for Dual Backend
**File**: `server/services/RecordingService.js`

Modify to support both backends:
```javascript
async startRecording(streamerId, quality, mode) {
  const backend = webrtcConfig.backend;

  if (backend === 'livekit') {
    return this.egressService.startRecording({
      roomName: webrtcConfig.livekit.roomName,
      quality,
      mode
    });
  } else {
    // Existing MediaSoup recording logic
    return this.startMediasoupRecording(streamerId, quality, mode);
  }
}
```

### 1.3 Install LiveKit Egress Dependencies
```bash
npm install @livekit/livekit-server-sdk  # Already installed, verify version
```

---

## Phase 2: Database Schema

### 2.1 Create Clips Table
**File**: `server/database/database.js` (add to initializeDatabase)

```sql
CREATE TABLE IF NOT EXISTS clips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clip_id TEXT UNIQUE NOT NULL,
    recording_id TEXT,                    -- Source recording (optional)
    user_id INTEGER NOT NULL,             -- Creator of the clip
    streamer_user_id INTEGER,             -- Who was streaming
    title TEXT NOT NULL,
    description TEXT,
    start_time_ms INTEGER NOT NULL,       -- Start offset in source
    end_time_ms INTEGER NOT NULL,         -- End offset in source
    duration_ms INTEGER NOT NULL,         -- Clip duration
    file_path TEXT,                       -- Path to clip file
    thumbnail_path TEXT,                  -- Path to thumbnail
    status TEXT DEFAULT 'processing',     -- processing, ready, failed
    view_count INTEGER DEFAULT 0,
    is_public BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id),
    FOREIGN KEY (streamer_user_id) REFERENCES users (id),
    FOREIGN KEY (recording_id) REFERENCES recordings (recording_id)
);

CREATE TABLE IF NOT EXISTS clip_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clip_id TEXT NOT NULL,
    user_id INTEGER,                      -- NULL for anonymous views
    ip_address TEXT,
    viewed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (clip_id) REFERENCES clips (clip_id),
    FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE INDEX IF NOT EXISTS idx_clips_user ON clips(user_id);
CREATE INDEX IF NOT EXISTS idx_clips_status ON clips(status);
CREATE INDEX IF NOT EXISTS idx_clips_public ON clips(is_public);
CREATE INDEX IF NOT EXISTS idx_clips_created ON clips(created_at);
CREATE INDEX IF NOT EXISTS idx_clip_views_clip ON clip_views(clip_id);
```

---

## Phase 3: Backend Services

### 3.1 ClipService
**File**: `server/services/ClipService.js`

```javascript
class ClipService {
  constructor(database, clipProcessor, storageService) {
    this.database = database;
    this.clipProcessor = clipProcessor;
    this.storageService = storageService;
  }

  // Create a clip from a recording
  async createClip(userId, recordingId, startMs, endMs, title, description) {
    // Validate duration (30s - 2min)
    const duration = endMs - startMs;
    if (duration < 30000 || duration > 120000) {
      throw new Error('Clip duration must be between 30 seconds and 2 minutes');
    }

    // Generate clip ID and paths
    const clipId = uuid();
    const clipPath = this.getClipPath(clipId);

    // Insert pending clip record
    await this.insertClipRecord(clipId, userId, recordingId, startMs, endMs, title, description);

    // Queue clip processing
    await this.clipProcessor.queueClip(clipId, recordingId, startMs, endMs);

    return { clipId, status: 'processing' };
  }

  // Create clip from live "clipping moment" (last N seconds)
  async createLiveClip(userId, durationSeconds, title, description) {
    // Get current recording
    const activeRecording = await this.recordingService.getCurrentRecording();
    if (!activeRecording) {
      throw new Error('No active recording to clip from');
    }

    const endMs = Date.now() - activeRecording.startTime;
    const startMs = Math.max(0, endMs - (durationSeconds * 1000));

    return this.createClip(userId, activeRecording.id, startMs, endMs, title, description);
  }

  // Get clip details
  async getClip(clipId) {}

  // List clips (paginated)
  async listClips(options = {}) {}

  // Get user's clips
  async getUserClips(userId, options = {}) {}

  // Delete clip
  async deleteClip(clipId, userId) {}

  // Update clip metadata
  async updateClip(clipId, userId, updates) {}

  // Increment view count
  async recordView(clipId, userId, ipAddress) {}
}
```

### 3.2 ClipProcessorService
**File**: `server/services/ClipProcessorService.js`

```javascript
class ClipProcessorService {
  constructor(database, storageService) {
    this.database = database;
    this.storageService = storageService;
    this.processingQueue = [];
    this.isProcessing = false;
    this.maxConcurrent = 2;
    this.activeJobs = 0;
  }

  async queueClip(clipId, recordingId, startMs, endMs) {
    this.processingQueue.push({ clipId, recordingId, startMs, endMs });
    this.processNext();
  }

  async processNext() {
    if (this.activeJobs >= this.maxConcurrent || this.processingQueue.length === 0) {
      return;
    }

    const job = this.processingQueue.shift();
    this.activeJobs++;

    try {
      await this.processClip(job);
    } catch (error) {
      console.error(`Clip processing failed for ${job.clipId}:`, error);
      await this.markClipFailed(job.clipId, error.message);
    } finally {
      this.activeJobs--;
      this.processNext();
    }
  }

  async processClip({ clipId, recordingId, startMs, endMs }) {
    // Get recording file path
    const recording = await this.getRecording(recordingId);

    // Generate output paths
    const clipPath = path.join(this.storagePaths.clips, `${clipId}.mp4`);
    const thumbnailPath = path.join(this.storagePaths.thumbnails, `${clipId}.jpg`);

    // Extract clip using FFmpeg
    await this.extractClip(recording.file_path, clipPath, startMs, endMs);

    // Generate thumbnail
    await this.generateThumbnail(clipPath, thumbnailPath);

    // Get file size
    const stats = fs.statSync(clipPath);

    // Update clip record
    await this.updateClipRecord(clipId, {
      file_path: clipPath,
      thumbnail_path: thumbnailPath,
      file_size: stats.size,
      status: 'ready'
    });
  }

  async extractClip(inputPath, outputPath, startMs, endMs) {
    return new Promise((resolve, reject) => {
      const startTime = startMs / 1000;
      const duration = (endMs - startMs) / 1000;

      const ffmpegArgs = [
        '-ss', startTime.toString(),
        '-i', inputPath,
        '-t', duration.toString(),
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',  // Enable streaming
        '-y',
        outputPath
      ];

      const ffmpeg = spawn('ffmpeg', ffmpegArgs);
      // ... handle process events
    });
  }

  async generateThumbnail(videoPath, thumbnailPath) {
    return new Promise((resolve, reject) => {
      const ffmpegArgs = [
        '-i', videoPath,
        '-ss', '1',              // 1 second into video
        '-vframes', '1',         // Single frame
        '-vf', 'scale=480:-1',   // Width 480, maintain aspect ratio
        '-y',
        thumbnailPath
      ];

      const ffmpeg = spawn('ffmpeg', ffmpegArgs);
      // ... handle process events
    });
  }
}
```

### 3.3 ClipStorageService
**File**: `server/services/ClipStorageService.js`

```javascript
class ClipStorageService {
  constructor() {
    this.basePath = path.join(__dirname, '..', '..', 'clips');
    this.storagePaths = {
      clips: path.join(this.basePath, 'videos'),
      thumbnails: path.join(this.basePath, 'thumbnails'),
      temp: path.join(this.basePath, 'temp')
    };
  }

  initialize() {
    Object.values(this.storagePaths).forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  getClipPath(clipId) {
    return path.join(this.storagePaths.clips, `${clipId}.mp4`);
  }

  getThumbnailPath(clipId) {
    return path.join(this.storagePaths.thumbnails, `${clipId}.jpg`);
  }

  async deleteClip(clipId) {
    const clipPath = this.getClipPath(clipId);
    const thumbPath = this.getThumbnailPath(clipId);

    if (fs.existsSync(clipPath)) fs.unlinkSync(clipPath);
    if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
  }
}
```

---

## Phase 4: API Routes

### 4.1 Clips API Routes
**File**: `server/routes/clips.js`

```javascript
const express = require('express');
const router = express.Router();
const { authenticateToken, optionalAuth } = require('../middleware/auth');

// Public endpoints (no auth required)

// GET /api/clips - List all public clips (paginated)
router.get('/', optionalAuth, async (req, res) => {
  const { page = 1, limit = 20, sort = 'recent' } = req.query;
  const clips = await clipService.listClips({ page, limit, sort, publicOnly: true });
  res.json({ success: true, clips, page, limit });
});

// GET /api/clips/:clipId - Get single clip details
router.get('/:clipId', optionalAuth, async (req, res) => {
  const clip = await clipService.getClip(req.params.clipId);
  if (!clip || (!clip.is_public && clip.user_id !== req.user?.id)) {
    return res.status(404).json({ error: 'Clip not found' });
  }

  // Record view
  await clipService.recordView(req.params.clipId, req.user?.id, req.ip);

  res.json({ success: true, clip });
});

// GET /api/clips/:clipId/stream - Stream clip video
router.get('/:clipId/stream', optionalAuth, async (req, res) => {
  const clip = await clipService.getClip(req.params.clipId);
  // ... stream video with range support (similar to recordings)
});

// GET /api/clips/:clipId/thumbnail - Get clip thumbnail
router.get('/:clipId/thumbnail', async (req, res) => {
  const clip = await clipService.getClip(req.params.clipId);
  res.sendFile(clip.thumbnail_path);
});

// Authenticated endpoints

// POST /api/clips - Create a new clip
router.post('/', authenticateToken, async (req, res) => {
  const { recordingId, startMs, endMs, title, description } = req.body;

  // Validate
  if (!title || title.length > 100) {
    return res.status(400).json({ error: 'Title required (max 100 chars)' });
  }

  const result = await clipService.createClip(
    req.user.id, recordingId, startMs, endMs, title, description
  );

  res.json({ success: true, ...result });
});

// POST /api/clips/live - Create clip from live stream (last N seconds)
router.post('/live', authenticateToken, async (req, res) => {
  const { duration = 30, title, description } = req.body;

  if (duration < 30 || duration > 120) {
    return res.status(400).json({ error: 'Duration must be 30-120 seconds' });
  }

  const result = await clipService.createLiveClip(
    req.user.id, duration, title, description
  );

  res.json({ success: true, ...result });
});

// GET /api/clips/user/:userId - Get user's clips
router.get('/user/:userId', optionalAuth, async (req, res) => {
  const clips = await clipService.getUserClips(req.params.userId, {
    publicOnly: req.user?.id !== parseInt(req.params.userId)
  });
  res.json({ success: true, clips });
});

// GET /api/clips/my - Get current user's clips
router.get('/my', authenticateToken, async (req, res) => {
  const clips = await clipService.getUserClips(req.user.id, { publicOnly: false });
  res.json({ success: true, clips });
});

// PATCH /api/clips/:clipId - Update clip metadata
router.patch('/:clipId', authenticateToken, async (req, res) => {
  const { title, description, is_public } = req.body;
  await clipService.updateClip(req.params.clipId, req.user.id, { title, description, is_public });
  res.json({ success: true });
});

// DELETE /api/clips/:clipId - Delete a clip
router.delete('/:clipId', authenticateToken, async (req, res) => {
  await clipService.deleteClip(req.params.clipId, req.user.id);
  res.json({ success: true });
});

module.exports = router;
```

### 4.2 Register Routes in Server
**File**: `server/index.js`

Add to route initialization:
```javascript
const clipsRoutes = require('./routes/clips');
app.use('/api/clips', clipsRoutes);
```

---

## Phase 5: Frontend Implementation

### 5.1 Clips Gallery Page
**File**: `client/src/components/ClipsGallery.tsx`

```tsx
interface Clip {
  clip_id: string;
  title: string;
  description?: string;
  duration_ms: number;
  view_count: number;
  thumbnail_path: string;
  username: string;
  created_at: string;
}

const ClipsGallery: React.FC = () => {
  const [clips, setClips] = useState<Clip[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState<'recent' | 'views'>('recent');

  useEffect(() => {
    fetchClips();
  }, [page, sortBy]);

  const fetchClips = async () => {
    const response = await fetch(`/api/clips?page=${page}&sort=${sortBy}`);
    const data = await response.json();
    setClips(data.clips);
    setLoading(false);
  };

  return (
    <div className="clips-gallery">
      <h1>Clips</h1>

      <div className="clips-controls">
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
          <option value="recent">Most Recent</option>
          <option value="views">Most Viewed</option>
        </select>
      </div>

      <div className="clips-grid">
        {clips.map(clip => (
          <ClipCard key={clip.clip_id} clip={clip} />
        ))}
      </div>

      <Pagination page={page} onPageChange={setPage} />
    </div>
  );
};
```

### 5.2 Clip Card Component
**File**: `client/src/components/ClipCard.tsx`

```tsx
const ClipCard: React.FC<{ clip: Clip }> = ({ clip }) => {
  const formatDuration = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <Link to={`/clips/${clip.clip_id}`} className="clip-card">
      <div className="clip-thumbnail">
        <img src={`/api/clips/${clip.clip_id}/thumbnail`} alt={clip.title} />
        <span className="clip-duration">{formatDuration(clip.duration_ms)}</span>
      </div>
      <div className="clip-info">
        <h3>{clip.title}</h3>
        <p className="clip-meta">
          <span>{clip.username}</span>
          <span>{clip.view_count} views</span>
          <span>{formatTimeAgo(clip.created_at)}</span>
        </p>
      </div>
    </Link>
  );
};
```

### 5.3 Clip Player Page
**File**: `client/src/components/ClipPlayer.tsx`

```tsx
const ClipPlayer: React.FC = () => {
  const { clipId } = useParams<{ clipId: string }>();
  const [clip, setClip] = useState<Clip | null>(null);

  useEffect(() => {
    fetchClip();
  }, [clipId]);

  const fetchClip = async () => {
    const response = await fetch(`/api/clips/${clipId}`);
    const data = await response.json();
    setClip(data.clip);
  };

  const shareClip = () => {
    const url = `${window.location.origin}/clips/${clipId}`;
    navigator.clipboard.writeText(url);
    // Show toast notification
  };

  if (!clip) return <Loading />;

  return (
    <div className="clip-player-page">
      <div className="video-container">
        <video
          controls
          autoPlay
          src={`/api/clips/${clipId}/stream`}
        />
      </div>

      <div className="clip-details">
        <h1>{clip.title}</h1>
        <p>{clip.description}</p>

        <div className="clip-meta">
          <span>{clip.view_count} views</span>
          <span>Clipped by {clip.username}</span>
          <span>{formatDate(clip.created_at)}</span>
        </div>

        <div className="clip-actions">
          <button onClick={shareClip}>Share</button>
        </div>
      </div>
    </div>
  );
};
```

### 5.4 Clip Creation Modal
**File**: `client/src/components/ClipCreationModal.tsx`

```tsx
const ClipCreationModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [duration, setDuration] = useState(30);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);

  const createClip = async () => {
    setCreating(true);

    const response = await fetch('/api/clips/live', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authService.getToken()}`
      },
      body: JSON.stringify({ duration, title, description })
    });

    const data = await response.json();

    if (data.success) {
      // Show success toast
      onClose();
    } else {
      // Show error
    }

    setCreating(false);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="clip-modal" onClick={e => e.stopPropagation()}>
        <h2>Create Clip</h2>

        <div className="duration-selector">
          <label>Clip Duration</label>
          <div className="duration-buttons">
            {[30, 60, 90, 120].map(d => (
              <button
                key={d}
                className={duration === d ? 'active' : ''}
                onClick={() => setDuration(d)}
              >
                {d}s
              </button>
            ))}
          </div>
          <p>Clips the last {duration} seconds of the stream</p>
        </div>

        <div className="form-group">
          <label>Title (required)</label>
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            maxLength={100}
            placeholder="Give your clip a title"
          />
        </div>

        <div className="form-group">
          <label>Description (optional)</label>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            maxLength={500}
            placeholder="Add a description..."
          />
        </div>

        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button
            onClick={createClip}
            disabled={!title.trim() || creating}
            className="primary"
          >
            {creating ? 'Creating...' : 'Create Clip'}
          </button>
        </div>
      </div>
    </div>
  );
};
```

### 5.5 Add Clip Button to Stream UI
**File**: `client/src/components/TheatreControls.tsx` (or `StreamViewer.tsx`)

Add a clip button visible to authenticated users:
```tsx
{isAuthenticated && streamStatus.hasActiveStream && (
  <button
    className="clip-button"
    onClick={() => setShowClipModal(true)}
    title="Create Clip"
  >
    ✂️ Clip
  </button>
)}
```

### 5.6 Update App.tsx Routing

Add routes for clips:
```tsx
// In App.tsx or routing config
<Route path="/clips" element={<ClipsGallery />} />
<Route path="/clips/:clipId" element={<ClipPlayer />} />
```

---

## Phase 6: Nginx Configuration

### 6.1 Add Clips Routes
**File**: `/etc/nginx/sites-available/onestreamer.live`

Add these location blocks:
```nginx
# Clips API
location /api/clips/ {
    proxy_pass https://main_backend/api/clips/;
    proxy_ssl_verify off;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Authorization $http_authorization;

    # For video streaming
    proxy_buffering off;
    proxy_request_buffering off;
}

# Direct clip file serving (optional, for CDN optimization)
location /clips/static/ {
    alias /root/onestreamer/clips/videos/;
    expires 7d;
    add_header Cache-Control "public, immutable";
    add_header Accept-Ranges bytes;
}

# Clip thumbnails
location /clips/thumbnails/ {
    alias /root/onestreamer/clips/thumbnails/;
    expires 7d;
    add_header Cache-Control "public, immutable";
}

# Clips pages (SPA routing)
location /clips {
    root /var/www/html;
    try_files $uri /index.html;
}
```

---

## Phase 7: Socket.IO Events

### 7.1 Real-time Clip Notifications
Add to server Socket.IO handling:

```javascript
// When a clip is created
io.emit('clip-created', {
  clipId: clip.clip_id,
  title: clip.title,
  creatorUsername: user.username,
  thumbnailUrl: `/api/clips/${clip.clip_id}/thumbnail`
});

// When clip processing completes
io.emit('clip-ready', {
  clipId: clip.clip_id,
  status: 'ready'
});

// When clip processing fails
socket.emit('clip-failed', {
  clipId: clip.clip_id,
  error: 'Processing failed'
});
```

---

## Phase 8: Storage & Cleanup

### 8.1 Directory Structure
```
/root/onestreamer/
├── recordings/          # Existing recordings
│   ├── active/
│   ├── completed/
│   └── ...
└── clips/               # New clips storage
    ├── videos/          # MP4 clip files
    ├── thumbnails/      # JPEG thumbnails
    └── temp/            # Processing temp files
```

### 8.2 Cleanup Policy
Add to existing cleanup service or create new:
- Auto-delete clips older than 90 days (configurable)
- Delete orphaned thumbnails
- Delete temp files older than 24 hours
- Monitor disk usage and alert at 80%

---

## Implementation Order

### Week 1: Foundation
1. Database schema (clips table, indexes)
2. ClipStorageService (directory management)
3. ClipService (basic CRUD operations)
4. API routes (basic endpoints)

### Week 2: Processing
5. ClipProcessorService (FFmpeg integration)
6. LiveKitEgressService (if needed for LiveKit recording)
7. Thumbnail generation
8. Queue management

### Week 3: Frontend Core
9. ClipsGallery component
10. ClipCard component
11. ClipPlayer component
12. Routing setup

### Week 4: Creation & Polish
13. ClipCreationModal
14. Clip button in stream UI
15. Socket.IO events
16. Nginx configuration
17. Error handling & edge cases

### Week 5: Testing & Refinement
18. End-to-end testing
19. Performance optimization
20. Mobile responsiveness
21. Documentation

---

## Technical Considerations

### Video Format
- **Input**: WebM (VP8/Opus) from recordings
- **Output**: MP4 (H.264/AAC) for clips
- **Rationale**: MP4 has better browser support and seeking performance

### Clip Duration Limits
- **Minimum**: 30 seconds (prevent spam)
- **Maximum**: 2 minutes (storage management)
- **Default**: 30 seconds

### Authentication
- Viewing clips: Public (no auth required)
- Creating clips: Authenticated users only
- Editing/deleting clips: Owner or admin only

### Rate Limiting
- Clip creation: 10 clips per hour per user
- API requests: Standard rate limiting

### SEO & Sharing
- Open Graph meta tags for clip pages
- Twitter Card support
- Direct shareable URLs: `onestreamer.live/clips/{clipId}`

---

## Alternative Approaches Considered

### Option A: Client-side Recording
- Have the client record and upload clips
- **Rejected**: Unreliable, requires client to be present for entire clip duration

### Option B: HLS/DASH Segments
- Use segment-based streaming and clip from segments
- **Rejected**: Added complexity, current setup uses WebM not segmented

### Option C: MediaRecorder on Playback
- Record from video element during playback
- **Rejected**: Quality loss, requires re-watching content

### Chosen Approach: Server-side FFmpeg Trimming
- **Selected**: Reliable, maintains quality, works with existing recordings
- Uses existing FFmpeg infrastructure
- Async processing doesn't block UI

---

## Dependencies

### Existing (No Changes)
- FFmpeg (already installed)
- SQLite (already in use)
- Express.js (already in use)
- Socket.IO (already in use)

### New
- @livekit/livekit-server-sdk (for Egress, if LiveKit recording needed)
- uuid (already installed)

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| LiveKit recording not working | Fallback to MediaSoup recording when not using LiveKit |
| Disk space exhaustion | Implement aggressive cleanup, monitoring, alerts |
| Long processing times | Queue system, background processing, progress indicators |
| Video seeking issues | MP4 with faststart flag, proper moov atom placement |
| Concurrent clip creation | Queue system with configurable concurrency |

---

## Success Metrics

1. Users can create clips within 30 seconds
2. Clips process in under 2 minutes
3. Clip playback works on all major browsers
4. Share links work on social media platforms
5. Gallery loads in under 2 seconds

---

## Future Enhancements (Out of Scope)

- Clip editor (trim, add text overlay)
- Clip categories/tags
- Featured clips section
- Clip reactions/likes
- Clip compilation playlists
- CDN integration for clip delivery
- Clip embedding for external sites
