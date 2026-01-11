import React, { useState, useEffect, useRef, useCallback } from 'react';
import Hls from 'hls.js';
import SessionChatReplay from './SessionChatReplay';
import ClipCreator from './ClipCreator';
import authService from '../../services/AuthService';

interface RecordingSession {
  sessionId: string;
  streamerIdentity: string;
  streamerUsername: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  status: string;
  segmentCount: number;
  chatMessageCount: number;
  fileSizeBytes: number;
  hasB2Upload: boolean;
}

interface SessionPlayerProps {
  session: RecordingSession;
  makeApiCall: (endpoint: string, options?: RequestInit) => Promise<any>;
  addLog: (message: string) => void;
  onBack: () => void;
  formatDuration: (ms: number) => string;
}

interface VideoInfo {
  source: string;
  url: string;
  format?: string;
  expiresAt?: string;
}

const SessionPlayer: React.FC<SessionPlayerProps> = ({
  session,
  makeApiCall,
  addLog,
  onBack,
  formatDuration
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [showChat, setShowChat] = useState(true);
  const [showClipCreator, setShowClipCreator] = useState(false);
  const [clipMarkIn, setClipMarkIn] = useState<number | null>(null);
  const [clipMarkOut, setClipMarkOut] = useState<number | null>(null);

  const fetchVideoUrl = useCallback(async () => {
    try {
      setLoading(true);
      const response = await makeApiCall(`/admin/review/sessions/${session.sessionId}/video`);

      if (response.success) {
        setVideoInfo(response);
        setError(null);
      } else {
        setError(response.error || 'Failed to get video URL');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to get video URL');
    } finally {
      setLoading(false);
    }
  }, [makeApiCall, session.sessionId]);

  useEffect(() => {
    fetchVideoUrl();
  }, [fetchVideoUrl]);

  // Initialize HLS.js for HLS streams
  const hlsRef = useRef<Hls | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoInfo) return;

    // Cleanup previous HLS instance
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    const isHls = videoInfo.url.includes('.m3u8') || videoInfo.format === 'hls';

    if (isHls && Hls.isSupported()) {
      const token = authService.getToken();
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        xhrSetup: (xhr: XMLHttpRequest, url: string) => {
          // Add auth header to all HLS requests
          xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        }
      });
      hlsRef.current = hls;

      // Build full URL for the stream
      const baseUrl = process.env.REACT_APP_SERVER_URL || '';
      const fullUrl = videoInfo.url.startsWith('/') ? `${baseUrl}${videoInfo.url}` : videoInfo.url;

      hls.loadSource(fullUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_event: string, data: { fatal: boolean; details: string }) => {
        console.error('HLS error:', data);
        if (data.fatal) {
          setError(`HLS Error: ${data.details}`);
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS support (Safari)
      video.src = videoInfo.url;
    } else if (!isHls) {
      // Regular video file
      video.src = videoInfo.url;
    }

    const handleTimeUpdate = () => {
      setCurrentTimeMs(Math.floor(video.currentTime * 1000));
    };

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);

    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);

    return () => {
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [videoInfo]);

  const handleMarkIn = () => {
    setClipMarkIn(currentTimeMs);
    addLog(`Marked clip start at ${formatDuration(currentTimeMs)}`);
  };

  const handleMarkOut = () => {
    setClipMarkOut(currentTimeMs);
    addLog(`Marked clip end at ${formatDuration(currentTimeMs)}`);
    setShowClipCreator(true);
  };

  const handleClearMarks = () => {
    setClipMarkIn(null);
    setClipMarkOut(null);
    setShowClipCreator(false);
  };

  const handleSeek = (timeMs: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = timeMs / 1000;
      setCurrentTimeMs(timeMs);
    }
  };

  const handleClipCreated = () => {
    handleClearMarks();
    addLog('Clip created successfully');
  };

  return (
    <div className="session-player">
      <div className="player-header">
        <button className="back-btn" onClick={onBack}>
          &larr; Back to Sessions
        </button>
        <div className="session-info">
          <h3>{session.streamerUsername || session.streamerIdentity || 'Recording'}</h3>
          <span className="session-date">
            {new Date(session.startTime).toLocaleString()}
          </span>
          <span className="session-duration">
            Duration: {formatDuration(session.durationMs)}
          </span>
        </div>
        <div className="player-controls">
          <button
            className={`toggle-btn ${showChat ? 'active' : ''}`}
            onClick={() => setShowChat(!showChat)}
          >
            {showChat ? 'Hide Chat' : 'Show Chat'}
          </button>
        </div>
      </div>

      <div className={`player-content ${showChat ? 'with-chat' : ''}`}>
        <div className="video-section">
          {loading ? (
            <div className="video-loading">Loading video...</div>
          ) : error ? (
            <div className="video-error">
              <p>{error}</p>
              <button onClick={fetchVideoUrl}>Retry</button>
            </div>
          ) : videoInfo ? (
            <div className="video-container">
              <video
                ref={videoRef}
                controls
                preload="metadata"
                style={{ width: '100%', maxHeight: '70vh' }}
              />
              <div className="video-overlay-info">
                <span className="source-badge">{videoInfo.source}</span>
                {videoInfo.expiresAt && (
                  <span className="expires-badge">
                    URL expires: {new Date(videoInfo.expiresAt).toLocaleTimeString()}
                  </span>
                )}
              </div>
            </div>
          ) : null}

          <div className="clip-controls">
            <div className="playback-info">
              <span className="current-time">
                {formatDuration(currentTimeMs)} / {formatDuration(session.durationMs)}
              </span>
            </div>
            <div className="mark-controls">
              <button className="mark-btn mark-in" onClick={handleMarkIn}>
                Mark In
                {clipMarkIn !== null && (
                  <span className="mark-time">{formatDuration(clipMarkIn)}</span>
                )}
              </button>
              <button
                className="mark-btn mark-out"
                onClick={handleMarkOut}
                disabled={clipMarkIn === null}
              >
                Mark Out
                {clipMarkOut !== null && (
                  <span className="mark-time">{formatDuration(clipMarkOut)}</span>
                )}
              </button>
              {(clipMarkIn !== null || clipMarkOut !== null) && (
                <button className="clear-marks-btn" onClick={handleClearMarks}>
                  Clear
                </button>
              )}
            </div>
          </div>

          {showClipCreator && clipMarkIn !== null && clipMarkOut !== null && (
            <ClipCreator
              sessionId={session.sessionId}
              startMs={clipMarkIn}
              endMs={clipMarkOut}
              makeApiCall={makeApiCall}
              onClose={() => setShowClipCreator(false)}
              onCreated={handleClipCreated}
              formatDuration={formatDuration}
            />
          )}
        </div>

        {showChat && (
          <div className="chat-section">
            <SessionChatReplay
              sessionId={session.sessionId}
              currentTimeMs={currentTimeMs}
              durationMs={session.durationMs}
              isPlaying={isPlaying}
              makeApiCall={makeApiCall}
              onSeek={handleSeek}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default SessionPlayer;
