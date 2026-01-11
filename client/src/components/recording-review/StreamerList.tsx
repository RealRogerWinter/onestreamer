import React, { useMemo, useState } from 'react';

interface StreamEvent {
  id: string;
  type: string;
  name: string;
  platform: string;
  sourceUrl: string | null;
  startTime: number;
  endTime: number;
  duration: number;
  isActive: boolean;
  color: string;
}

interface TimelineData {
  startTime: number;
  endTime: number;
  events: StreamEvent[];
  recordings: any[];
}

interface StreamerListProps {
  timeline: TimelineData | null;
  currentTimeMs: number;
  recordingStartTime: number;
  currentStreamerId?: string;  // ID of the currently playing streamer (from parent)
  onSeek: (timeMs: number) => void;
  formatDuration: (ms: number) => string;
}

type PlatformFilter = 'all' | 'twitch' | 'kick' | 'onestreamer';

const StreamerList: React.FC<StreamerListProps> = ({
  timeline,
  currentTimeMs,
  recordingStartTime,
  currentStreamerId,
  onSeek,
  formatDuration
}) => {
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>('all');

  // Normalize platform name for filtering
  const normalizePlatform = (platform: string, type: string, sourceUrl: string | null): string => {
    const p = platform?.toLowerCase() || '';

    // Real streamers are "onestreamer"
    if (type === 'real_streamer') return 'onestreamer';

    // Check if it's a Kick IVS URL
    if (sourceUrl && sourceUrl.includes('playback.live-video.net')) {
      return 'kick';
    }

    if (p.includes('twitch')) return 'twitch';
    if (p.includes('kick')) return 'kick';
    if (p === 'direct') return 'onestreamer';

    return p || 'unknown';
  };

  // Process events to get unique streamers with their segments
  const streamers = useMemo(() => {
    if (!timeline?.events) return [];

    // Sort events by start time
    const sortedEvents = [...timeline.events].sort((a, b) => a.startTime - b.startTime);

    return sortedEvents.map(event => {
      // Calculate relative start time from recording start
      const relativeStartMs = event.startTime - recordingStartTime;

      // Cap endTime to timeline.endTime to avoid huge durations from active streams
      // (Server sets endTime = Date.now() for active streams which creates multi-hour durations)
      const cappedEndTime = Math.min(event.endTime, timeline.endTime);
      const relativeEndMs = cappedEndTime - recordingStartTime;

      // Calculate actual segment duration (capped)
      const actualDuration = cappedEndTime - event.startTime;

      // Normalize platform for filtering
      const normalizedPlatform = normalizePlatform(event.platform, event.type, event.sourceUrl);

      return {
        ...event,
        normalizedPlatform,
        relativeStartMs: Math.max(0, relativeStartMs),
        relativeEndMs: relativeEndMs,
        // Use capped duration instead of server-provided duration
        duration: actualDuration,
        displayTime: new Date(event.startTime).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit'
        })
      };
    });
  }, [timeline, recordingStartTime]);

  // Filter streamers by platform
  const filteredStreamers = useMemo(() => {
    if (platformFilter === 'all') return streamers;
    return streamers.filter(s => s.normalizedPlatform === platformFilter);
  }, [streamers, platformFilter]);

  // Count streamers by platform
  const platformCounts = useMemo(() => {
    const counts = { all: 0, twitch: 0, kick: 0, onestreamer: 0 };
    streamers.forEach(s => {
      counts.all++;
      if (s.normalizedPlatform === 'twitch') counts.twitch++;
      else if (s.normalizedPlatform === 'kick') counts.kick++;
      else if (s.normalizedPlatform === 'onestreamer') counts.onestreamer++;
    });
    return counts;
  }, [streamers]);

  // Note: currentStreamerId is now passed from parent as the single source of truth

  const handleClick = (relativeStartMs: number) => {
    onSeek(relativeStartMs);
  };

  const getPlatformIcon = (platform: string, normalizedPlatform: string) => {
    switch (normalizedPlatform) {
      case 'twitch': return '🟣';
      case 'kick': return '🟢';
      case 'onestreamer': return '📺';
      default: return '📺';
    }
  };

  const getTypeColor = (type: string, normalizedPlatform: string) => {
    // Use platform-based colors for better distinction
    switch (normalizedPlatform) {
      case 'twitch': return '#9146FF';
      case 'kick': return '#53FC18';
      case 'onestreamer': return '#4CAF50';
      default: return '#888';
    }
  };

  // Get display name - clean it up
  const getDisplayName = (event: StreamEvent & { normalizedPlatform: string }) => {
    let name = event.name || 'Unknown';

    // Remove (Admin), (Chat Vote) suffixes
    name = name.replace(/\s*\([^)]+\)\s*$/, '').trim();

    // If name is still generic, try to extract from URL
    if (name === 'Unknown' || name === 'unknown' || name === 'Kick') {
      if (event.sourceUrl) {
        // Try twitch.tv/username
        const twitchMatch = event.sourceUrl.match(/twitch\.tv\/([^/?]+)/i);
        if (twitchMatch) {
          name = twitchMatch[1];
        }
        // For Kick IVS URLs, we can't extract the name
      }
    }

    return name;
  };

  if (!streamers.length) {
    return (
      <div className="streamer-list empty">
        <div className="empty-message">No streamers recorded yet</div>
      </div>
    );
  }

  return (
    <div className="streamer-list">
      <div className="streamer-list-header">
        <h4>Streamers</h4>
        <span className="streamer-count">{filteredStreamers.length} segments</span>
      </div>

      {/* Platform filters */}
      <div className="streamer-filters">
        <button
          className={`filter-btn ${platformFilter === 'all' ? 'active' : ''}`}
          onClick={() => setPlatformFilter('all')}
        >
          All ({platformCounts.all})
        </button>
        {platformCounts.twitch > 0 && (
          <button
            className={`filter-btn twitch ${platformFilter === 'twitch' ? 'active' : ''}`}
            onClick={() => setPlatformFilter('twitch')}
          >
            🟣 Twitch ({platformCounts.twitch})
          </button>
        )}
        {platformCounts.kick > 0 && (
          <button
            className={`filter-btn kick ${platformFilter === 'kick' ? 'active' : ''}`}
            onClick={() => setPlatformFilter('kick')}
          >
            🟢 Kick ({platformCounts.kick})
          </button>
        )}
        {platformCounts.onestreamer > 0 && (
          <button
            className={`filter-btn onestreamer ${platformFilter === 'onestreamer' ? 'active' : ''}`}
            onClick={() => setPlatformFilter('onestreamer')}
          >
            📺 Live ({platformCounts.onestreamer})
          </button>
        )}
      </div>

      <div className="streamer-list-content">
        {filteredStreamers.map((streamer) => {
          const isCurrentlyPlaying = currentStreamerId === streamer.id;
          const isPast = currentTimeMs > streamer.relativeEndMs;
          const displayName = getDisplayName(streamer);

          return (
            <div
              key={streamer.id}
              className={`streamer-item ${isCurrentlyPlaying ? 'active' : ''} ${isPast ? 'past' : ''}`}
              onClick={() => handleClick(streamer.relativeStartMs)}
              title={`Jump to ${displayName} at ${formatDuration(streamer.relativeStartMs)}`}
            >
              <div className="streamer-icon" style={{ backgroundColor: getTypeColor(streamer.type, streamer.normalizedPlatform) }}>
                {getPlatformIcon(streamer.platform, streamer.normalizedPlatform)}
              </div>
              <div className="streamer-info">
                <div className="streamer-name">
                  {displayName}
                  {streamer.isActive && <span className="live-badge">LIVE</span>}
                </div>
                <div className="streamer-meta">
                  <span className="streamer-time">{streamer.displayTime}</span>
                  <span className="streamer-duration">{formatDuration(streamer.duration)}</span>
                </div>
              </div>
              <div className="streamer-seek">
                <span className="seek-time">{formatDuration(streamer.relativeStartMs)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default StreamerList;
