import React from 'react';
import { PlaybackInfo, TimeFilterState, ViewMode } from './types';

interface ReviewHeaderBarProps {
  playbackInfo: PlaybackInfo | null;
  formatDate: (ms: number) => string;
  showTimeFilter: boolean;
  setShowTimeFilter: React.Dispatch<React.SetStateAction<boolean>>;
  timeFilter: TimeFilterState;
  filterDescription: string;
  showStreamers: boolean;
  setShowStreamers: React.Dispatch<React.SetStateAction<boolean>>;
  showChat: boolean;
  setShowChat: React.Dispatch<React.SetStateAction<boolean>>;
  viewMode: ViewMode;
  setViewMode: React.Dispatch<React.SetStateAction<ViewMode>>;
  onRefresh: () => void;
}

// The top header bar (title + recording info + view/filter toggles + refresh).
// DOM is a verbatim move from AdminRecordingReview.
const ReviewHeaderBar: React.FC<ReviewHeaderBarProps> = ({
  playbackInfo,
  formatDate,
  showTimeFilter,
  setShowTimeFilter,
  timeFilter,
  filterDescription,
  showStreamers,
  setShowStreamers,
  showChat,
  setShowChat,
  viewMode,
  setViewMode,
  onRefresh,
}) => {
  return (
    <div className="review-header-bar">
      <div className="header-left">
        <h2>Recording Review</h2>
        {playbackInfo && (
          <span className="recording-info">
            {formatDate(playbackInfo.earliestRecording)} - {formatDate(playbackInfo.latestRecording)}
            {' | '}
            {playbackInfo.totalChatMessages} chat messages
          </span>
        )}
      </div>
      <div className="header-right">
        <button
          className={`header-btn ${showTimeFilter ? 'active' : ''} ${timeFilter.preset !== 'all' ? 'filter-active' : ''}`}
          onClick={() => setShowTimeFilter(!showTimeFilter)}
        >
          {filterDescription}
        </button>
        <button
          className={`header-btn ${showStreamers ? 'active' : ''}`}
          onClick={() => setShowStreamers(!showStreamers)}
        >
          {showStreamers ? 'Hide Streamers' : 'Streamers'}
        </button>
        <button
          className={`header-btn ${showChat ? 'active' : ''}`}
          onClick={() => setShowChat(!showChat)}
        >
          {showChat ? 'Hide Chat' : 'Show Chat'}
        </button>
        <button
          className={`header-btn ${viewMode === 'settings' ? 'active' : ''}`}
          onClick={() => setViewMode(viewMode === 'settings' ? 'player' : 'settings')}
        >
          Settings
        </button>
        <button className="header-btn" onClick={onRefresh}>
          Refresh
        </button>
      </div>
    </div>
  );
};

export default ReviewHeaderBar;
