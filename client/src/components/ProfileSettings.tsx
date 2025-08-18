import React, { useState, useEffect } from 'react';
import authService from '../services/AuthService';
import './ProfileSettings.css';

interface ProfileSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  onProfileUpdate?: () => void;
}

interface UserData {
  username: string;
  email: string;
  isVerified?: boolean;
  is_verified?: boolean;
}

interface UserStats {
  points?: number;
  total_stream_time?: number;
  total_view_time?: number;
  stream_count?: number;
  chat_message_count?: number;
  totalStreamTime?: number;
  totalViewTime?: number;
  streamCount?: number;
  chatMessageCount?: number;
}

const ProfileSettings: React.FC<ProfileSettingsProps> = ({ isOpen, onClose, onProfileUpdate }) => {
  const [userData, setUserData] = useState<UserData | null>(null);
  const [userStats, setUserStats] = useState<UserStats | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [formData, setFormData] = useState({
    username: '',
    email: '',
    currentPassword: '',
    newPassword: '',
    confirmPassword: ''
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      loadUserProfile();
    }
  }, [isOpen]);

  const loadUserProfile = async () => {
    try {
      const profile = await authService.getProfile();
      if (profile) {
        setUserData(profile.user);
        setUserStats(profile.stats);
        setFormData({
          username: profile.user.username,
          email: profile.user.email,
          currentPassword: '',
          newPassword: '',
          confirmPassword: ''
        });
      }
    } catch (error) {
      console.error('Failed to load profile:', error);
      setError('Failed to load profile data');
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value
    });
    setError(null);
    setSuccess(null);
  };

  const handleSave = async () => {
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const updateData: any = {};
      
      if (formData.email !== userData?.email) {
        updateData.email = formData.email;
      }
      
      if (formData.newPassword) {
        if (formData.newPassword !== formData.confirmPassword) {
          setError('New passwords do not match');
          setLoading(false);
          return;
        }
        if (!formData.currentPassword) {
          setError('Current password is required to change password');
          setLoading(false);
          return;
        }
        updateData.currentPassword = formData.currentPassword;
        updateData.newPassword = formData.newPassword;
      }

      if (Object.keys(updateData).length === 0) {
        setEditMode(false);
        setLoading(false);
        return;
      }

      const response = await authService.updateProfile(updateData);
      
      if (response.success) {
        setSuccess('Profile updated successfully');
        setEditMode(false);
        await loadUserProfile();
        if (onProfileUpdate) {
          onProfileUpdate();
        }
        
        setFormData(prev => ({
          ...prev,
          currentPassword: '',
          newPassword: '',
          confirmPassword: ''
        }));
      }
    } catch (error: any) {
      setError(error.message || 'Failed to update profile');
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    setEditMode(false);
    setError(null);
    setSuccess(null);
    if (userData) {
      setFormData({
        username: userData.username,
        email: userData.email,
        currentPassword: '',
        newPassword: '',
        confirmPassword: ''
      });
    }
  };

  const formatTime = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  };

  if (!isOpen) return null;

  return (
    <div className="profile-settings-overlay" onClick={onClose}>
      <div className="profile-settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="profile-settings-header">
          <h2>Profile Settings</h2>
          <button className="close-button" onClick={onClose}>×</button>
        </div>

        <div className="profile-settings-content">
          {error && (
            <div className="alert alert-error">
              {error}
            </div>
          )}
          
          {success && (
            <div className="alert alert-success">
              {success}
            </div>
          )}

          <div className="profile-section">
            <h3>Account Information</h3>
            <div className="profile-field">
              <label>Username</label>
              <span className="field-value">{userData?.username}</span>
            </div>

            <div className="profile-field">
              <label>Email</label>
              {editMode ? (
                <input
                  type="email"
                  name="email"
                  value={formData.email}
                  onChange={handleInputChange}
                  disabled={loading}
                />
              ) : (
                <div className="field-value-with-status">
                  <span className="field-value">{userData?.email}</span>
                  {userData && !(userData.isVerified || userData.is_verified) && (
                    <span className="verification-warning">⚠️ Not verified</span>
                  )}
                </div>
              )}
            </div>

            {editMode && (
              <>
                <div className="password-section">
                  <h4>Change Password</h4>
                  <div className="profile-field">
                    <label>Current Password</label>
                    <input
                      type="password"
                      name="currentPassword"
                      value={formData.currentPassword}
                      onChange={handleInputChange}
                      disabled={loading}
                      placeholder="Enter current password"
                    />
                  </div>
                  <div className="profile-field">
                    <label>New Password</label>
                    <input
                      type="password"
                      name="newPassword"
                      value={formData.newPassword}
                      onChange={handleInputChange}
                      disabled={loading}
                      placeholder="Enter new password"
                    />
                  </div>
                  <div className="profile-field">
                    <label>Confirm New Password</label>
                    <input
                      type="password"
                      name="confirmPassword"
                      value={formData.confirmPassword}
                      onChange={handleInputChange}
                      disabled={loading}
                      placeholder="Confirm new password"
                    />
                  </div>
                </div>
              </>
            )}
          </div>

          {userStats && (
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
          )}

          <div className="profile-actions">
            {editMode ? (
              <>
                <button 
                  className="btn btn-primary"
                  onClick={handleSave}
                  disabled={loading}
                >
                  {loading ? 'Saving...' : 'Save Changes'}
                </button>
                <button 
                  className="btn btn-secondary"
                  onClick={handleCancel}
                  disabled={loading}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button 
                className="btn btn-primary"
                onClick={() => setEditMode(true)}
              >
                Edit Profile
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ProfileSettings;