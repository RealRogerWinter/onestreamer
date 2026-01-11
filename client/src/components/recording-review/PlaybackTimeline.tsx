import React, { useRef, useEffect, useState, useCallback } from 'react';

interface StreamEvent {
  id: string;
  type: 'real_streamer' | 'url_stream' | 'viewbot';
  name: string;
  startTime: number;
  endTime: number;
  duration: number | null;
  isActive: boolean;
  color: string;
  platform?: string;
  sourceUrl?: string;
  userId?: number;
}

interface Recording {
  sessionId: string;
  startTime: number;
  endTime: number;
  hasVideo: boolean;
  status: string;
}

interface TimelineData {
  startTime: number;
  endTime: number;
  events: StreamEvent[];
  recordings: Recording[];
}

interface PlaybackTimelineProps {
  timeline: TimelineData | null;
  currentTimeMs: number;
  totalDurationMs: number;
  recordingStartTime: number;
  onSeek: (timeMs: number) => void;
  formatDuration: (ms: number) => string;
}

const PlaybackTimeline: React.FC<PlaybackTimelineProps> = ({
  timeline,
  currentTimeMs,
  totalDurationMs,
  recordingStartTime,
  onSeek,
  formatDuration
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [hoveredEvent, setHoveredEvent] = useState<StreamEvent | null>(null);
  const [hoverPosition, setHoverPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);

  // Zoom state
  const [zoomLevel, setZoomLevel] = useState(1); // 1 = 100%, 2 = 200%, etc.
  const [scrollPosition, setScrollPosition] = useState(0); // Scroll position as percentage of total width

  const MIN_ZOOM = 1;
  const MAX_ZOOM = 20;
  const ZOOM_STEP = 0.5;

  // Calculate the visible window as a percentage of total duration
  const visiblePercent = 100 / zoomLevel;

  // Calculate position percentage for a given timestamp
  const getPositionPercent = useCallback((timestamp: number) => {
    if (!timeline || totalDurationMs <= 0) return 0;
    const relativeMs = timestamp - timeline.startTime;
    return (relativeMs / totalDurationMs) * 100;
  }, [timeline, totalDurationMs]);

  // Calculate width percentage for a duration
  const getWidthPercent = useCallback((startTime: number, endTime: number) => {
    if (!timeline || totalDurationMs <= 0) return 0;
    const durationMs = endTime - startTime;
    return (durationMs / totalDurationMs) * 100;
  }, [timeline, totalDurationMs]);

  // Handle click/drag on timeline (accounting for zoom and scroll)
  const handleTimelineClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const clickPercentInView = x / rect.width;

    // Convert click position to actual timeline position
    // scrollPosition is the left edge of the visible window as percentage
    const actualPercent = scrollPosition + (clickPercentInView * visiblePercent);
    const seekMs = (actualPercent / 100) * totalDurationMs;

    console.log('Timeline click:', {
      clickPercentInView: clickPercentInView.toFixed(2),
      scrollPosition,
      visiblePercent,
      actualPercent: actualPercent.toFixed(2),
      seekMs,
      zoomLevel
    });

    onSeek(Math.max(0, Math.min(seekMs, totalDurationMs)));
  }, [totalDurationMs, onSeek, scrollPosition, visiblePercent, zoomLevel]);

  // Handle mouse move for scrubbing
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    handleTimelineClick(e);
  }, [isDragging, handleTimelineClick]);

  // Handle zoom
  const handleZoom = useCallback((delta: number, centerPercent?: number) => {
    setZoomLevel(prev => {
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev + delta));

      if (centerPercent !== undefined && newZoom !== prev) {
        // Adjust scroll to keep the center point in the same position
        const newVisiblePercent = 100 / newZoom;
        const oldVisiblePercent = 100 / prev;

        // Where was the center point relative to the left edge of visible area?
        const centerOffset = centerPercent - scrollPosition;
        const centerRatio = centerOffset / oldVisiblePercent;

        // Keep that ratio the same in the new view
        const newScrollPosition = centerPercent - (centerRatio * newVisiblePercent);

        setScrollPosition(Math.max(0, Math.min(100 - newVisiblePercent, newScrollPosition)));
      }

      return newZoom;
    });
  }, [scrollPosition]);

  // Zoom to fit current playhead in view
  const centerOnPlayhead = useCallback(() => {
    if (totalDurationMs <= 0) return;
    const playheadPercent = (currentTimeMs / totalDurationMs) * 100;
    const newScrollPosition = Math.max(0, Math.min(100 - visiblePercent, playheadPercent - visiblePercent / 2));
    setScrollPosition(newScrollPosition);
  }, [currentTimeMs, totalDurationMs, visiblePercent]);

  // Handle mouse wheel for zoom (scroll to zoom, Shift+scroll to pan)
  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();

    if (e.shiftKey && zoomLevel > 1) {
      // Shift+scroll to pan horizontally when zoomed in
      const scrollDelta = (e.deltaY / 300) * visiblePercent;
      setScrollPosition(prev =>
        Math.max(0, Math.min(100 - visiblePercent, prev + scrollDelta))
      );
    } else {
      // Regular scroll to zoom
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      // Calculate where the mouse is pointing as percentage of total timeline
      const x = e.clientX - rect.left;
      const clickPercentInView = x / rect.width;
      const centerPercent = scrollPosition + (clickPercentInView * visiblePercent);

      // Zoom in or out based on wheel direction
      const delta = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
      handleZoom(delta, centerPercent);
    }
  }, [handleZoom, scrollPosition, visiblePercent, zoomLevel]);

  // Keep playhead visible when it moves
  useEffect(() => {
    if (zoomLevel <= 1) return;

    const playheadPercent = (currentTimeMs / totalDurationMs) * 100;
    const visibleStart = scrollPosition;
    const visibleEnd = scrollPosition + visiblePercent;

    // If playhead is outside visible area, scroll to show it
    if (playheadPercent < visibleStart || playheadPercent > visibleEnd) {
      // Don't auto-scroll while dragging
      if (!isDragging) {
        const newScrollPosition = Math.max(0, Math.min(100 - visiblePercent, playheadPercent - visiblePercent * 0.3));
        setScrollPosition(newScrollPosition);
      }
    }
  }, [currentTimeMs, totalDurationMs, zoomLevel, visiblePercent, scrollPosition, isDragging]);

  // Reset scroll when zooming out to 1x
  useEffect(() => {
    if (zoomLevel === 1) {
      setScrollPosition(0);
    }
  }, [zoomLevel]);

  // Format time for display
  const formatTime = (ms: number) => {
    const date = new Date(ms);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const formatDate = (ms: number) => {
    const date = new Date(ms);
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  // Current position on timeline (as percentage of video duration)
  const currentPositionPercent = totalDurationMs > 0 ? (currentTimeMs / totalDurationMs) * 100 : 0;

  // Convert position to view coordinates (accounting for zoom and scroll)
  const getViewPosition = useCallback((positionPercent: number) => {
    // Map timeline position to visible window
    const relativeToScroll = positionPercent - scrollPosition;
    return (relativeToScroll / visiblePercent) * 100;
  }, [scrollPosition, visiblePercent]);

  // Check if a position is visible in current view
  const isInView = useCallback((positionPercent: number) => {
    return positionPercent >= scrollPosition && positionPercent <= scrollPosition + visiblePercent;
  }, [scrollPosition, visiblePercent]);

  // Generate time markers based on zoom level
  const getTimeMarkers = () => {
    if (!timeline || totalDurationMs <= 0) return [];

    const markers = [];

    // Adjust marker interval based on zoom level
    let intervalMs: number;
    const effectiveDuration = totalDurationMs / zoomLevel;

    if (effectiveDuration < 2 * 60 * 1000) {
      intervalMs = 15 * 1000; // 15 seconds
    } else if (effectiveDuration < 10 * 60 * 1000) {
      intervalMs = 60 * 1000; // 1 minute
    } else if (effectiveDuration < 30 * 60 * 1000) {
      intervalMs = 5 * 60 * 1000; // 5 minutes
    } else if (effectiveDuration < 60 * 60 * 1000) {
      intervalMs = 10 * 60 * 1000; // 10 minutes
    } else if (effectiveDuration < 3 * 60 * 60 * 1000) {
      intervalMs = 15 * 60 * 1000; // 15 minutes
    } else {
      intervalMs = 30 * 60 * 1000; // 30 minutes
    }

    // Calculate visible range in ms
    const visibleStartMs = (scrollPosition / 100) * totalDurationMs;
    const visibleEndMs = ((scrollPosition + visiblePercent) / 100) * totalDurationMs;

    // Start from the first marker before the visible area
    const firstMarker = Math.floor(visibleStartMs / intervalMs) * intervalMs;

    for (let elapsedMs = firstMarker; elapsedMs <= visibleEndMs + intervalMs; elapsedMs += intervalMs) {
      if (elapsedMs < 0 || elapsedMs > totalDurationMs) continue;

      const positionPercent = (elapsedMs / totalDurationMs) * 100;
      const viewPosition = getViewPosition(positionPercent);

      if (viewPosition >= -10 && viewPosition <= 110) {
        markers.push({
          time: timeline.startTime + elapsedMs,
          elapsedMs: elapsedMs,
          label: formatDuration(elapsedMs),
          date: formatDate(timeline.startTime + elapsedMs),
          position: viewPosition
        });
      }
    }

    return markers;
  };

  const timeMarkers = getTimeMarkers();
  const playheadViewPosition = getViewPosition(currentPositionPercent);

  return (
    <div className="playback-timeline">
      {/* Zoom controls */}
      <div className="timeline-zoom-controls">
        <button
          className="zoom-btn"
          onClick={() => handleZoom(-ZOOM_STEP)}
          disabled={zoomLevel <= MIN_ZOOM}
          title="Zoom out"
        >
          −
        </button>
        <span className="zoom-level" title="Click to reset">
          <button className="zoom-reset" onClick={() => setZoomLevel(1)}>
            {Math.round(zoomLevel * 100)}%
          </button>
        </span>
        <button
          className="zoom-btn"
          onClick={() => handleZoom(ZOOM_STEP)}
          disabled={zoomLevel >= MAX_ZOOM}
          title="Zoom in"
        >
          +
        </button>
        {zoomLevel > 1 && (
          <button
            className="zoom-btn center-btn"
            onClick={centerOnPlayhead}
            title="Center on playhead"
          >
            ⊙
          </button>
        )}
      </div>

      {/* Time markers - shows elapsed video time */}
      <div className="timeline-markers">
        {timeMarkers.map((marker, i) => (
          <div
            key={`${marker.elapsedMs}-${i}`}
            className="hour-marker"
            style={{ left: `${marker.position}%` }}
          >
            <span className="marker-time">{marker.label}</span>
            {marker.elapsedMs === 0 ? (
              <span className="marker-date">{formatDate(marker.time)}</span>
            ) : null}
          </div>
        ))}
      </div>

      {/* Main timeline track */}
      <div
        ref={containerRef}
        className={`timeline-track ${zoomLevel > 1 ? 'zoomed' : ''}`}
        onClick={handleTimelineClick}
        onMouseDown={() => setIsDragging(true)}
        onMouseUp={() => setIsDragging(false)}
        onMouseLeave={() => setIsDragging(false)}
        onMouseMove={handleMouseMove}
        onWheel={handleWheel}
      >
        {/* Recording availability background */}
        {timeline?.recordings.map((rec, i) => {
          const leftPercent = getPositionPercent(rec.startTime);
          const widthPercent = getWidthPercent(rec.startTime, rec.endTime);
          const viewLeft = getViewPosition(leftPercent);
          const viewWidth = (widthPercent / visiblePercent) * 100;

          // Skip if completely outside view
          if (viewLeft + viewWidth < -5 || viewLeft > 105) return null;

          return (
            <div
              key={`rec-${i}`}
              className={`recording-block ${rec.status}`}
              style={{
                left: `${viewLeft}%`,
                width: `${viewWidth}%`
              }}
              title={`Recording: ${rec.sessionId}`}
            />
          );
        })}

        {/* Stream event blocks */}
        {timeline?.events.map((event, i) => {
          // Clip event to visible timeline range
          const clippedStart = Math.max(event.startTime, timeline.startTime);
          const clippedEnd = Math.min(event.endTime, timeline.endTime);

          // Skip if event is completely outside timeline
          if (clippedStart >= clippedEnd) return null;

          const leftPercent = getPositionPercent(clippedStart);
          const widthPercent = getWidthPercent(clippedStart, clippedEnd);
          const viewLeft = getViewPosition(leftPercent);
          const viewWidth = (widthPercent / visiblePercent) * 100;

          // Skip if completely outside view
          if (viewLeft + viewWidth < -5 || viewLeft > 105) return null;

          // Calculate label positioning for zoomed view
          // When event extends past left edge, position label at left edge of visible area
          // When event extends past right edge, just let it clip
          const visibleLeft = Math.max(0, viewLeft);
          const visibleRight = Math.min(100, viewLeft + viewWidth);
          const visibleWidth = visibleRight - visibleLeft;

          // Calculate label offset from left of event block to center it in visible portion
          let labelOffset = 0;
          if (viewLeft < 0 && viewWidth > 0) {
            // Event starts before visible area - offset label to visible portion
            labelOffset = ((-viewLeft) / viewWidth) * 100;
          }

          // Clean up display name
          let displayName = event.name || 'Unknown';
          displayName = displayName.replace(/\s*\([^)]+\)\s*$/, '').trim();

          return (
            <div
              key={`event-${i}`}
              className={`stream-event ${event.type} ${event.isActive ? 'active' : ''}`}
              style={{
                left: `${viewLeft}%`,
                width: `${Math.max(2, viewWidth)}%`,
                backgroundColor: event.color
              }}
              onMouseEnter={(e) => {
                setHoveredEvent(event);
                // Get the timeline container's position to place tooltip above it
                const containerRect = containerRef.current?.getBoundingClientRect();
                const tooltipTop = containerRect ? containerRect.top - 10 : e.clientY - 150;
                setHoverPosition({ x: e.clientX, y: tooltipTop });
              }}
              onMouseLeave={() => setHoveredEvent(null)}
              onClick={(e) => {
                e.stopPropagation();
                // Calculate click position within this event element
                const rect = e.currentTarget.getBoundingClientRect();
                const clickX = e.clientX - rect.left;
                const clickPercent = clickX / rect.width;

                // Calculate seek position based on where in the event segment was clicked
                const eventDurationMs = clippedEnd - clippedStart;
                const offsetWithinEvent = eventDurationMs * clickPercent;
                const seekMs = (clippedStart - timeline.startTime) + offsetWithinEvent;

                onSeek(Math.max(0, seekMs));
              }}
            >
              <span
                className="event-label"
                style={labelOffset > 0 ? { marginLeft: `${labelOffset}%` } : undefined}
              >
                {displayName}
              </span>
            </div>
          );
        })}

        {/* Current position indicator */}
        {playheadViewPosition >= -2 && playheadViewPosition <= 102 && (
          <div
            className="playhead"
            style={{ left: `${playheadViewPosition}%` }}
          >
            <div className="playhead-line" />
            <div className="playhead-time">
              {formatDuration(currentTimeMs)}
            </div>
          </div>
        )}
      </div>

      {/* Minimap when zoomed */}
      {zoomLevel > 1 && (
        <div className="timeline-minimap">
          <div className="minimap-track">
            {/* Show events as tiny blocks */}
            {timeline?.events.map((event, i) => {
              const leftPercent = getPositionPercent(event.startTime);
              const widthPercent = getWidthPercent(event.startTime, event.endTime);
              return (
                <div
                  key={`mini-${i}`}
                  className="minimap-event"
                  style={{
                    left: `${leftPercent}%`,
                    width: `${Math.max(0.5, widthPercent)}%`,
                    backgroundColor: event.color
                  }}
                />
              );
            })}
            {/* Visible window indicator */}
            <div
              className="minimap-viewport"
              style={{
                left: `${scrollPosition}%`,
                width: `${visiblePercent}%`
              }}
            />
            {/* Playhead on minimap */}
            <div
              className="minimap-playhead"
              style={{ left: `${currentPositionPercent}%` }}
            />
          </div>
        </div>
      )}

      {/* Event tooltip */}
      {hoveredEvent && (
        <div
          className="event-tooltip"
          style={{
            left: `${hoverPosition.x}px`,
            top: `${hoverPosition.y}px`
          }}
        >
          <div className="tooltip-header">
            <span
              className="tooltip-type"
              style={{ backgroundColor: hoveredEvent.color }}
            >
              {hoveredEvent.type === 'url_stream' ? `URL Relay (${hoveredEvent.platform || 'unknown'})` : hoveredEvent.type.replace('_', ' ')}
            </span>
          </div>
          <div className="tooltip-name">{hoveredEvent.name}</div>
          {hoveredEvent.sourceUrl && (
            <div className="tooltip-url">{hoveredEvent.sourceUrl.substring(0, 50)}...</div>
          )}
          <div className="tooltip-time">
            {formatTime(hoveredEvent.startTime)} - {formatTime(hoveredEvent.endTime)}
          </div>
          <div className="tooltip-duration">
            Duration: {formatDuration(hoveredEvent.duration || 0)}
          </div>
          {hoveredEvent.isActive && (
            <div className="tooltip-active">Currently Live</div>
          )}
        </div>
      )}

      {/* Legend */}
      <div className="timeline-legend">
        <div className="legend-item">
          <span className="legend-color" style={{ backgroundColor: '#4CAF50' }} />
          <span>Real Streamer</span>
        </div>
        <div className="legend-item">
          <span className="legend-color" style={{ backgroundColor: '#2196F3' }} />
          <span>URL Relay</span>
        </div>
        <div className="legend-item">
          <span className="legend-color" style={{ backgroundColor: '#FF9800' }} />
          <span>ViewBot</span>
        </div>
        <div className="zoom-hint">
          Scroll to zoom, Shift+Scroll to pan
        </div>
      </div>
    </div>
  );
};

export default PlaybackTimeline;
