import React, { useState, useEffect, useRef } from 'react';
import authService from '../services/AuthService';
import io, { Socket } from 'socket.io-client';
import './Auth.css';

interface UserProfileProps {
  socket?: Socket | null;
  onLogout?: () => void;
  onOpenProfileSettings?: () => void;
  onUserProfileUpdate?: (profile: { points: number; updateType?: string; pointsEarned?: number }) => void;
  currentUser?: any;
}

interface UserStats {
  total_stream_time?: number;
  total_view_time?: number;
  points?: number;
  stream_count?: number;
  chat_message_count?: number;
  totalStreamTime?: number;
  totalViewTime?: number;
  streamCount?: number;
  chatMessageCount?: number;
}

const UserProfile: React.FC<UserProfileProps> = ({ socket, onLogout, onOpenProfileSettings, onUserProfileUpdate, currentUser }) => {
  const [showDropdown, setShowDropdown] = useState(false);
  const initialUser = currentUser || authService.getUser();
  const [user, setUser] = useState(initialUser);
  const [stats, setStats] = useState<UserStats | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadUserData();

    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // Update user when currentUser prop changes
  useEffect(() => {
    if (currentUser) {
      setUser(currentUser);
    }
  }, [currentUser]);

  // Setup socket event listeners when socket is available
  useEffect(() => {
    if (socket && user) {
      console.log('📊 UserProfile: Setting up real-time stats listeners');
      
      // Listen for real-time time updates
      const handleTimeUpdate = (data: any) => {
        console.log('📊 UserProfile: Received real-time stats update:', JSON.stringify(data, null, 2));
        console.log('📊 UserProfile: Details - Chat:', data.chatMessageCount, 'Points:', data.points, 'UpdateType:', data.updateType, 'PointSource:', data.pointSource, 'SessionType:', data.sessionType, 'CurrentSessionTime:', data.currentSessionTime);
        
        // Update stats with real-time data
        setStats((prevStats: UserStats | null) => {
          const newStats = {
            ...prevStats,
            total_stream_time: data.totalStreamTime,
            total_view_time: data.totalViewTime,
            chat_message_count: data.chatMessageCount,
            points: data.points
          };
          
          // Update parent component with new profile data and specific update info
          if (onUserProfileUpdate && typeof newStats.points === 'number') {
            onUserProfileUpdate({ 
              points: newStats.points, 
              updateType: data.updateType,
              pointsEarned: data.pointsEarned,
              pointSource: data.pointSource,
              sessionType: data.sessionType,
              currentSessionTime: data.currentSessionTime
            } as any);
          }
          
          return newStats;
        });
      };

      socket.on('time-stats-update', handleTimeUpdate);
      
      return () => {
        socket.off('time-stats-update', handleTimeUpdate);
      };
    }
  }, [socket, user]);

  const loadUserData = async () => {
    try {
      const profile = await authService.getProfile();
      if (profile) {
        setUser(profile.user);
        setStats(profile.stats);
        
        // Update parent component with profile data
        if (onUserProfileUpdate && profile.stats && typeof profile.stats.points === 'number') {
          onUserProfileUpdate({ points: profile.stats.points });
        }
      }
    } catch (error) {
      console.error('Failed to load user profile:', error);
    }
  };


  const handleLogout = async () => {
    await authService.logout();
    setShowDropdown(false);
    if (onLogout) {
      onLogout();
    }
  };

  const formatTime = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;
    
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  // If no user data yet, show a loading state or placeholder
  if (!user) {
    // If we have currentUser prop, use it as fallback
    if (currentUser && currentUser.username) {
      const initials = currentUser.username.substring(0, 2).toUpperCase();
      return (
        <div className="user-profile" ref={dropdownRef}>
          <button 
            className="user-profile-button"
            onClick={() => setShowDropdown(!showDropdown)}
          >
            <div className="user-avatar">
              {initials}
            </div>
            <span>{currentUser.username}</span>
          </button>
        </div>
      );
    }
    // Otherwise return null
    return null;
  }

  const initials = user.username.substring(0, 2).toUpperCase();

  return (
    <div className="user-profile" ref={dropdownRef}>
      <button 
        className="user-profile-button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          console.log('UserProfile button clicked! Current dropdown state:', showDropdown);
          setShowDropdown(!showDropdown);
        }}
        type="button"
      >
        <div className="user-avatar">
          {initials}
        </div>
        <span>{user.username}</span>
      </button>

      {showDropdown && (
        <div className="user-profile-dropdown">
          <div className="user-profile-info">
            <h4>{user.username}</h4>
            <p>{user.email}</p>
            {!user.isVerified && (
              <p style={{ color: '#f90', fontSize: '12px', marginTop: '8px' }}>
                ⚠️ Email not verified
              </p>
            )}
          </div>

          {stats && (
            <div className="user-profile-stats">
              <h5>Statistics</h5>
              <div className="stat-item">
                <span className="stat-label">Points:</span>
                <span className="stat-value points-value">{stats.points || 0}</span>
              </div>
              <div className="stat-item">
                <span className="stat-label">Stream Time:</span>
                <span className="stat-value">{formatTime((stats.total_stream_time || stats.totalStreamTime) || 0)}</span>
              </div>
              <div className="stat-item">
                <span className="stat-label">View Time:</span>
                <span className="stat-value">{formatTime((stats.total_view_time || stats.totalViewTime) || 0)}</span>
              </div>
              <div className="stat-item">
                <span className="stat-label">Streams:</span>
                <span className="stat-value">{(stats.stream_count || stats.streamCount) || 0}</span>
              </div>
              <div className="stat-item">
                <span className="stat-label">Chat Messages:</span>
                <span className="stat-value">{(stats.chat_message_count || stats.chatMessageCount) || 0}</span>
              </div>
            </div>
          )}

          <div className="user-profile-actions">
            <button 
              className="profile-action-button"
              onClick={() => {
                setShowDropdown(false);
                if (onOpenProfileSettings) {
                  onOpenProfileSettings();
                }
              }}
            >
              Profile Settings
            </button>
            <button 
              className="profile-action-button danger"
              onClick={handleLogout}
            >
              Sign Out
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default UserProfile;