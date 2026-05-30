import React, { useState, useMemo } from 'react';
import PlaybackTimeline from '../recording-review/PlaybackTimeline';
import SyncedChatReplay from '../recording-review/SyncedChatReplay';
import StreamerList from '../recording-review/StreamerList';
import ReviewSettings from '../recording-review/ReviewSettings';
import {
  TimelineData,
  ViewMode,
  TimeFilterState,
  getPresetTimeRange,
  formatDuration,
  formatDate,
  formatTime,
  getPlatformIcon,
  getDisplayName,
} from './adminRecordingReview/types';
import { useRecordingReviewData } from './adminRecordingReview/useRecordingReviewData';
import { useHlsPlayer } from './adminRecordingReview/useHlsPlayer';
import ReviewHeaderBar from './adminRecordingReview/ReviewHeaderBar';
import TimeFilterBar from './adminRecordingReview/TimeFilterBar';
import NowPlayingBar from './adminRecordingReview/NowPlayingBar';
import './AdminRecordingReview.css';

interface AdminRecordingReviewProps {
  makeApiCall: (endpoint: string, options?: RequestInit) => Promise<any>;
  addLog: (message: string) => void;
}

const AdminRecordingReview: React.FC<AdminRecordingReviewProps> = ({ makeApiCall, addLog }) => {
  // Data layer (playback info + timeline, loading/error/refresh)
  const {
    playbackInfo,
    timeline,
    hasRecordings,
    loading,
    error,
    setError,
    initialLoadComplete,
    fetchData,
  } = useRecordingReviewData(makeApiCall);

  // HLS playback pipeline (video wiring, seek/skip, keyboard shortcuts)
  const {
    videoRefCallback,
    currentTimeMs,
    videoDurationMs,
    isPlaying,
    handleSeek,
    handleSkip,
  } = useHlsPlayer(playbackInfo);

  const [viewMode, setViewMode] = useState<ViewMode>('player');
  const [showChat, setShowChat] = useState(true);
  const [showStreamers, setShowStreamers] = useState(true);

  // Time filter state
  const [timeFilter, setTimeFilter] = useState<TimeFilterState>({
    preset: 'all',
    customStart: null,
    customEnd: null
  });
  const [showTimeFilter, setShowTimeFilter] = useState(false);

  // Use timeline.startTime as the single source of truth for the reference point
  // This is the time the first event/recording started
  const recordingStartTime = useMemo(() => {
    // Prefer timeline.startTime as it represents when actual content starts
    // Fall back to playbackInfo.earliestRecording if timeline not available
    return timeline?.startTime || playbackInfo?.earliestRecording || 0;
  }, [timeline, playbackInfo]);

  // Filtered timeline based on time filter
  const filteredTimeline = useMemo((): TimelineData | null => {
    if (!timeline) return null;

    // Get filter time range
    let filterStart: number | null = null;
    let filterEnd: number | null = null;

    if (timeFilter.preset === 'custom') {
      filterStart = timeFilter.customStart;
      filterEnd = timeFilter.customEnd;
    } else {
      const presetRange = getPresetTimeRange(timeFilter.preset);
      filterStart = presetRange.start;
      filterEnd = presetRange.end;
    }

    // If no filter, return original timeline
    if (filterStart === null && filterEnd === null) {
      return timeline;
    }

    // Filter events that overlap with the time range
    const filteredEvents = timeline.events.filter(event => {
      const eventStart = event.startTime;
      const eventEnd = event.endTime;

      // Check if event overlaps with filter range
      if (filterStart !== null && filterEnd !== null) {
        return eventEnd >= filterStart && eventStart <= filterEnd;
      } else if (filterStart !== null) {
        return eventEnd >= filterStart;
      } else if (filterEnd !== null) {
        return eventStart <= filterEnd;
      }
      return true;
    });

    // Calculate new timeline boundaries
    const newStartTime = filterStart !== null
      ? Math.max(timeline.startTime, filterStart)
      : timeline.startTime;
    const newEndTime = filterEnd !== null
      ? Math.min(timeline.endTime, filterEnd)
      : timeline.endTime;

    return {
      ...timeline,
      startTime: newStartTime,
      endTime: newEndTime,
      events: filteredEvents
    };
  }, [timeline, timeFilter]);

  // Get current filter description for display
  const filterDescription = useMemo(() => {
    switch (timeFilter.preset) {
      case 'all': return 'All Data';
      case 'today': return 'Today';
      case 'yesterday': return 'Yesterday';
      case 'last_hour': return 'Last Hour';
      case 'last_6_hours': return 'Last 6 Hours';
      case 'last_24_hours': return 'Last 24 Hours';
      case 'custom': return 'Custom Range';
      default: return 'All Data';
    }
  }, [timeFilter.preset]);

  // Compute the current streamer based on playhead position
  // This is the SINGLE source of truth - pass this to all child components
  const currentStreamer = useMemo(() => {
    if (!timeline?.events || !recordingStartTime) return null;

    // Convert current video time (relative) to absolute timestamp
    const absoluteTimeMs = recordingStartTime + currentTimeMs;

    // Find all events that contain the current playhead position
    // Then pick the most specific one (smallest duration) to handle overlapping events
    // This fixes issues where active streams have endTime = Date.now() which spans everything
    let bestMatch: typeof timeline.events[0] | null = null;
    let bestMatchDuration = Infinity;

    for (const event of timeline.events) {
      if (absoluteTimeMs >= event.startTime && absoluteTimeMs <= event.endTime) {
        const eventDuration = event.endTime - event.startTime;
        // Prefer events with smaller duration (more specific match)
        // Also prefer events that start closer to the current time
        if (eventDuration < bestMatchDuration) {
          bestMatch = event;
          bestMatchDuration = eventDuration;
        }
      }
    }

    if (!bestMatch) return null;

    const event = bestMatch;
    const relativeStartMs = event.startTime - recordingStartTime;
    const relativeEndMs = event.endTime - recordingStartTime;
    const segmentDurationMs = event.endTime - event.startTime;
    const progressWithinSegment = Math.min(1, Math.max(0, (currentTimeMs - relativeStartMs) / segmentDurationMs));

    return {
      ...event,
      id: event.id || `event-${event.startTime}`,
      displayName: getDisplayName(event.name, event.sourceUrl),
      platformIcon: getPlatformIcon(event.platform, event.sourceUrl),
      absoluteStartTime: event.startTime,
      absoluteEndTime: event.endTime,
      relativeStartMs,
      relativeEndMs,
      segmentDurationMs,
      progressWithinSegment
    };
  }, [timeline, recordingStartTime, currentTimeMs]);

  // Only show loading spinner on initial load, not refreshes
  if (loading && !initialLoadComplete) {
    return (
      <div className="admin-recording-review loading">
        <div className="loading-spinner">Loading recordings...</div>
      </div>
    );
  }

  return (
    <div className="admin-recording-review fullscreen-player">
      {/* Header bar */}
      <ReviewHeaderBar
        playbackInfo={playbackInfo}
        formatDate={formatDate}
        showTimeFilter={showTimeFilter}
        setShowTimeFilter={setShowTimeFilter}
        timeFilter={timeFilter}
        filterDescription={filterDescription}
        showStreamers={showStreamers}
        setShowStreamers={setShowStreamers}
        showChat={showChat}
        setShowChat={setShowChat}
        viewMode={viewMode}
        setViewMode={setViewMode}
        onRefresh={() => fetchData(true)}
      />

      {/* Time filter bar (collapsible) */}
      {showTimeFilter && (
        <TimeFilterBar
          timeFilter={timeFilter}
          setTimeFilter={setTimeFilter}
          filteredTimeline={filteredTimeline}
          timeline={timeline}
        />
      )}

      {error && (
        <div className="review-error">
          <span>{error}</span>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {viewMode === 'settings' ? (
        <div className="settings-container">
          <ReviewSettings
            makeApiCall={makeApiCall}
            addLog={addLog}
            onRefresh={() => fetchData(true)}
          />
        </div>
      ) : !hasRecordings ? (
        <div className="no-recordings">
          <div className="no-recordings-icon">📹</div>
          <h3>No Recordings Available</h3>
          <p>Recording data will appear here once streams are captured.</p>
          <button onClick={() => fetchData()}>Check Again</button>
        </div>
      ) : (
        <div className={`player-layout ${showStreamers ? 'with-streamers' : ''} ${showChat ? 'with-chat' : ''}`}>
          {/* Streamers sidebar */}
          {showStreamers && (
            <div className="streamer-sidebar">
              <StreamerList
                timeline={filteredTimeline}
                currentTimeMs={currentTimeMs}
                recordingStartTime={recordingStartTime}
                currentStreamerId={currentStreamer?.id}
                onSeek={handleSeek}
                formatDuration={formatDuration}
              />
            </div>
          )}

          {/* Main video area */}
          <div className="video-area">
            {/* Now Playing indicator */}
            {currentStreamer && (
              <NowPlayingBar
                currentStreamer={currentStreamer}
                formatTime={formatTime}
                formatDuration={formatDuration}
              />
            )}

            <div className="video-container">
              <video
                ref={videoRefCallback}
                controls
                autoPlay
                playsInline
              />
            </div>

            {/* Playback info bar */}
            <div className="playback-info-bar">
              <div className="skip-controls">
                <button
                  className="skip-btn"
                  onClick={() => handleSkip(-5)}
                  title="Skip back 5 seconds (←)"
                >
                  ⏪ 5s
                </button>
                <button
                  className="skip-btn"
                  onClick={() => handleSkip(5)}
                  title="Skip forward 5 seconds (→)"
                >
                  5s ⏩
                </button>
              </div>
              <div className="time-display">
                <span className="current-time">{formatDuration(currentTimeMs)}</span>
                <span className="separator">/</span>
                <span className="total-time">{formatDuration(playbackInfo?.totalDurationMs || 0)}</span>
              </div>
              <div className="playback-status">
                {isPlaying ? '▶ Playing' : '⏸ Paused'}
                <span className="keyboard-hint">(Space to toggle, ← → to skip)</span>
              </div>
            </div>

            {/* Timeline */}
            <PlaybackTimeline
              timeline={filteredTimeline}
              currentTimeMs={currentTimeMs}
              totalDurationMs={playbackInfo?.totalDurationMs || videoDurationMs || 0}
              recordingStartTime={recordingStartTime}
              onSeek={handleSeek}
              formatDuration={formatDuration}
            />
          </div>

          {/* Chat sidebar */}
          {showChat && (
            <div className="chat-sidebar">
              <SyncedChatReplay
                currentTimeMs={currentTimeMs}
                recordingStartTime={recordingStartTime}
                isPlaying={isPlaying}
                makeApiCall={makeApiCall}
                formatDuration={formatDuration}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default AdminRecordingReview;
