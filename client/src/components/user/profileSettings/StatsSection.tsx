import React from 'react';
import { UserStats } from './types';
import { formatTime } from './useProfileSettings';

interface StatsSectionProps {
  userStats: UserStats;
}

const StatsSection: React.FC<StatsSectionProps> = ({ userStats }) => {
  return (
    <div className="profile-section stats-section">
      <h3>Account Statistics</h3>
      <div className="stats-grid">
        <div className="stat-item">
          <label>Points</label>
          <span className="stat-value">{userStats.points || 0}</span>
        </div>
        <div className="stat-item">
          <label>Stream Time</label>
          <span className="stat-value">{formatTime((userStats.total_stream_time || userStats.totalStreamTime) || 0)}</span>
        </div>
        <div className="stat-item">
          <label>View Time</label>
          <span className="stat-value">{formatTime((userStats.total_view_time || userStats.totalViewTime) || 0)}</span>
        </div>
        <div className="stat-item">
          <label>Streams</label>
          <span className="stat-value">{(userStats.stream_count || userStats.streamCount) || 0}</span>
        </div>
        <div className="stat-item">
          <label>Chat Messages</label>
          <span className="stat-value">{(userStats.chat_message_count || userStats.chatMessageCount) || 0}</span>
        </div>
      </div>
    </div>
  );
};

export default StatsSection;
