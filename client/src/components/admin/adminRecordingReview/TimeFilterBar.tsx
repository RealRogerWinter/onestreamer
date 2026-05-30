import React from 'react';
import { TimelineData, TimeFilterState } from './types';

interface TimeFilterBarProps {
  timeFilter: TimeFilterState;
  setTimeFilter: React.Dispatch<React.SetStateAction<TimeFilterState>>;
  filteredTimeline: TimelineData | null;
  timeline: TimelineData | null;
}

// The collapsible time-filter bar (preset buttons + custom date inputs +
// filter summary). DOM is a verbatim move from AdminRecordingReview.
const TimeFilterBar: React.FC<TimeFilterBarProps> = ({
  timeFilter,
  setTimeFilter,
  filteredTimeline,
  timeline,
}) => {
  return (
    <div className="time-filter-bar">
      <div className="filter-presets">
        <button
          className={`preset-btn ${timeFilter.preset === 'all' ? 'active' : ''}`}
          onClick={() => setTimeFilter({ preset: 'all', customStart: null, customEnd: null })}
        >
          All Data
        </button>
        <button
          className={`preset-btn ${timeFilter.preset === 'last_hour' ? 'active' : ''}`}
          onClick={() => setTimeFilter({ preset: 'last_hour', customStart: null, customEnd: null })}
        >
          Last Hour
        </button>
        <button
          className={`preset-btn ${timeFilter.preset === 'last_6_hours' ? 'active' : ''}`}
          onClick={() => setTimeFilter({ preset: 'last_6_hours', customStart: null, customEnd: null })}
        >
          Last 6 Hours
        </button>
        <button
          className={`preset-btn ${timeFilter.preset === 'last_24_hours' ? 'active' : ''}`}
          onClick={() => setTimeFilter({ preset: 'last_24_hours', customStart: null, customEnd: null })}
        >
          Last 24 Hours
        </button>
        <button
          className={`preset-btn ${timeFilter.preset === 'today' ? 'active' : ''}`}
          onClick={() => setTimeFilter({ preset: 'today', customStart: null, customEnd: null })}
        >
          Today
        </button>
        <button
          className={`preset-btn ${timeFilter.preset === 'yesterday' ? 'active' : ''}`}
          onClick={() => setTimeFilter({ preset: 'yesterday', customStart: null, customEnd: null })}
        >
          Yesterday
        </button>
        <button
          className={`preset-btn ${timeFilter.preset === 'custom' ? 'active' : ''}`}
          onClick={() => setTimeFilter(prev => ({ ...prev, preset: 'custom' }))}
        >
          Custom
        </button>
      </div>

      {/* Custom date/time inputs */}
      {timeFilter.preset === 'custom' && (
        <div className="custom-filter">
          <div className="custom-input-group">
            <label>From:</label>
            <input
              type="datetime-local"
              value={timeFilter.customStart ? new Date(timeFilter.customStart).toISOString().slice(0, 16) : ''}
              onChange={(e) => {
                const val = e.target.value ? new Date(e.target.value).getTime() : null;
                setTimeFilter(prev => ({ ...prev, customStart: val }));
              }}
            />
          </div>
          <div className="custom-input-group">
            <label>To:</label>
            <input
              type="datetime-local"
              value={timeFilter.customEnd ? new Date(timeFilter.customEnd).toISOString().slice(0, 16) : ''}
              onChange={(e) => {
                const val = e.target.value ? new Date(e.target.value).getTime() : null;
                setTimeFilter(prev => ({ ...prev, customEnd: val }));
              }}
            />
          </div>
          <button
            className="clear-custom-btn"
            onClick={() => setTimeFilter({ preset: 'all', customStart: null, customEnd: null })}
          >
            Clear
          </button>
        </div>
      )}

      {/* Filter summary */}
      {filteredTimeline && timeFilter.preset !== 'all' && (
        <div className="filter-summary">
          Showing {filteredTimeline.events.length} events
          {timeline && ` (of ${timeline.events.length} total)`}
        </div>
      )}
    </div>
  );
};

export default TimeFilterBar;
