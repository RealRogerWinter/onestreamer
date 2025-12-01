import React, { useState, useEffect, useRef } from 'react';
import ClipsHeader from './ClipsHeader';
import '../../styles/Clips.css';

interface Clip {
  clip_id: string;
  title: string;
  description?: string;
  duration_ms: number;
  view_count: number;
  thumbnail_path?: string;
  creator_username?: string;
  streamer_username?: string;
  created_at: string;
  status: string;
  is_public: boolean;
  user_id: number;
}

interface ClipResponse {
  success: boolean;
  clip: Clip;
}

interface ClipPlayerProps {
  clipId: string;
}

// Estimate processing time based on clip duration
const getProcessingEstimate = (durationMs: number, createdAt: string): { estimate: string; elapsed: number } => {
  const durationSeconds = durationMs / 1000;
  const estimatedSeconds = Math.ceil(durationSeconds * 1.2) + 10;
  // Parse SQLite datetime format (YYYY-MM-DD HH:MM:SS) - convert space to T and add Z for UTC
  const isoDate = createdAt.replace(' ', 'T') + 'Z';
  const elapsed = Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000);
  const remaining = Math.max(0, estimatedSeconds - elapsed);

  let estimate: string;
  if (remaining <= 0) {
    estimate = 'Almost done...';
  } else if (remaining < 60) {
    estimate = `~${remaining} seconds remaining`;
  } else {
    const minutes = Math.ceil(remaining / 60);
    estimate = `~${minutes} minute${minutes > 1 ? 's' : ''} remaining`;
  }

  return { estimate, elapsed };
};

const ClipPlayer: React.FC<ClipPlayerProps> = ({ clipId }) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  const [clip, setClip] = useState<Clip | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCopyToast, setShowCopyToast] = useState(false);
  const [processingTime, setProcessingTime] = useState<string>('');

  useEffect(() => {
    if (clipId) {
      fetchClip();
    }
  }, [clipId]);

  // Auto-refresh for processing clips
  useEffect(() => {
    if (clip?.status === 'processing') {
      // Update the processing estimate every second
      const estimateInterval = setInterval(() => {
        const { estimate } = getProcessingEstimate(clip.duration_ms, clip.created_at);
        setProcessingTime(estimate);
      }, 1000);

      // Check for completion every 5 seconds
      const refreshInterval = setInterval(() => {
        fetchClip(true); // silent refresh
      }, 5000);

      return () => {
        clearInterval(estimateInterval);
        clearInterval(refreshInterval);
      };
    }
  }, [clip?.status, clip?.duration_ms, clip?.created_at]);

  const fetchClip = async (silent = false) => {
    try {
      if (!silent) {
        setLoading(true);
        setError(null);
      }

      const response = await fetch(`/api/clips/${clipId}`);
      const data: ClipResponse = await response.json();

      if (data.success && data.clip) {
        setClip(data.clip);
        // Initialize processing time estimate
        if (data.clip.status === 'processing') {
          const { estimate } = getProcessingEstimate(data.clip.duration_ms, data.clip.created_at);
          setProcessingTime(estimate);
        }
      } else if (!silent) {
        setError('Clip not found');
      }
    } catch (err) {
      console.error('Error fetching clip:', err);
      if (!silent) {
        setError('Failed to load clip');
      }
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  };

  const formatDuration = (ms: number): string => {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const formatDate = (dateString: string): string => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const formatViews = (count: number): string => {
    if (count >= 1000000) {
      return `${(count / 1000000).toFixed(1)}M views`;
    }
    if (count >= 1000) {
      return `${(count / 1000).toFixed(1)}K views`;
    }
    return `${count} view${count !== 1 ? 's' : ''}`;
  };

  const shareClip = async () => {
    const url = `${window.location.origin}/clips/${clipId}`;

    try {
      if (navigator.share) {
        await navigator.share({
          title: clip?.title || 'Check out this clip',
          url: url
        });
      } else {
        await navigator.clipboard.writeText(url);
        setShowCopyToast(true);
        setTimeout(() => setShowCopyToast(false), 2000);
      }
    } catch (err) {
      // User cancelled or error
      console.log('Share cancelled or failed:', err);
    }
  };

  if (loading) {
    return (
      <>
        <ClipsHeader showBackToClips />
        <div className="clip-player-page">
          <div className="clip-player-container">
            <div className="clips-loading">
              <div className="clips-loading-spinner"></div>
              <p>Loading clip...</p>
            </div>
          </div>
        </div>
      </>
    );
  }

  if (error || !clip) {
    return (
      <>
        <ClipsHeader showBackToClips />
        <div className="clip-player-page">
          <div className="clip-player-container">
            <div className="clips-error">
              <p>{error || 'Clip not found'}</p>
              <a href="/clips" className="back-button">Browse Clips</a>
            </div>
          </div>
        </div>
      </>
    );
  }

  // Processing state view
  if (clip.status === 'processing') {
    return (
      <>
        <ClipsHeader showBackToClips />
        <div className="clip-player-page">
          <div className="clip-player-container">
            <div className="clip-processing-wrapper">
              <div className="clip-processing-content">
                <div className="processing-spinner"></div>
                <h2>Processing Clip</h2>
                <p className="clip-processing-title">"{clip.title}"</p>
                <p className="clip-processing-duration">
                  {formatDuration(clip.duration_ms)} clip
                </p>
                <p className="clip-processing-estimate">{processingTime}</p>
                <p className="clip-processing-note">
                  This page will automatically update when your clip is ready.
                </p>
              </div>
            </div>

            <div className="clip-details">
              <div className="clip-actions">
                <button className="clip-share-btn" onClick={shareClip}>
                  <span>Share Link</span>
                </button>
              </div>
              <p className="clip-share-note">
                You can share this link now - it will show the clip once processing is complete.
              </p>
            </div>
          </div>

          {showCopyToast && (
            <div className="copy-toast">
              Link copied to clipboard!
            </div>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <ClipsHeader showBackToClips />
      <div className="clip-player-page">
        <div className="clip-player-container">
          <div className="clip-video-wrapper">
          <video
            ref={videoRef}
            controls
            autoPlay
            playsInline
            src={`/api/clips/${clipId}/stream`}
            poster={clip.thumbnail_path ? `/api/clips/${clipId}/thumbnail` : undefined}
          >
            Your browser does not support the video tag.
          </video>
        </div>

        <div className="clip-details">
          <h1>{clip.title}</h1>

          {clip.description && (
            <p className="clip-description">{clip.description}</p>
          )}

          <div className="clip-stats">
            <span>{formatViews(clip.view_count)}</span>
            <span>{formatDuration(clip.duration_ms)}</span>
            {clip.creator_username && (
              <span>Clipped by @{clip.creator_username}</span>
            )}
            <span>{formatDate(clip.created_at)}</span>
          </div>

          <div className="clip-actions">
            <button className="clip-share-btn" onClick={shareClip}>
              <span>Share</span>
            </button>
          </div>
        </div>
      </div>

        {showCopyToast && (
          <div className="copy-toast">
            Link copied to clipboard!
          </div>
        )}
      </div>
    </>
  );
};

export default ClipPlayer;
