import React, { useState } from 'react';

interface ClipCardProps {
  clip: {
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
  };
}

const ClipCard: React.FC<ClipCardProps> = ({ clip }) => {
  const [imageError, setImageError] = useState(false);

  const formatDuration = (ms: number): string => {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const formatTimeAgo = (dateString: string): string => {
    // Parse SQLite datetime format (YYYY-MM-DD HH:MM:SS) - convert space to T and add Z for UTC
    const isoDate = dateString.includes('T') ? dateString : dateString.replace(' ', 'T') + 'Z';
    const date = new Date(isoDate);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSeconds = Math.floor(diffMs / 1000);
    const diffMinutes = Math.floor(diffSeconds / 60);
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);
    const diffWeeks = Math.floor(diffDays / 7);
    const diffMonths = Math.floor(diffDays / 30);

    if (diffMinutes < 1) return 'Just now';
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    if (diffWeeks < 4) return `${diffWeeks}w ago`;
    return `${diffMonths}mo ago`;
  };

  const formatViews = (count: number): string => {
    if (count >= 1000000) {
      return `${(count / 1000000).toFixed(1)}M`;
    }
    if (count >= 1000) {
      return `${(count / 1000).toFixed(1)}K`;
    }
    return count.toString();
  };

  const thumbnailUrl = clip.thumbnail_path
    ? `/api/clips/${clip.clip_id}/thumbnail`
    : null;

  return (
    <a href={`/clips/${clip.clip_id}`} className="clip-card">
      <div className="clip-thumbnail">
        {thumbnailUrl && !imageError ? (
          <img
            src={thumbnailUrl}
            alt={clip.title}
            onError={() => setImageError(true)}
            loading="lazy"
          />
        ) : (
          <div className="clip-thumbnail-placeholder">
            <span>🎬</span>
          </div>
        )}
        <span className="clip-duration">{formatDuration(clip.duration_ms)}</span>
      </div>
      <div className="clip-info">
        <h3>{clip.title}</h3>
        <div className="clip-meta">
          {clip.creator_username && (
            <span>@{clip.creator_username}</span>
          )}
          <span>{formatViews(clip.view_count)} views</span>
          <span>{formatTimeAgo(clip.created_at)}</span>
        </div>
      </div>
    </a>
  );
};

export default ClipCard;
