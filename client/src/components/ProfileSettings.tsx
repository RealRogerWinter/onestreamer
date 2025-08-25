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
  canChangeUsername?: boolean;
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
  const [editingUsername, setEditingUsername] = useState(false);
  const [formData, setFormData] = useState({
    username: '',
    email: '',
    currentPassword: '',
    newPassword: '',
    confirmPassword: ''
  });
  const [newUsername, setNewUsername] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [resendingVerification, setResendingVerification] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deletionRequested, setDeletionRequested] = useState(false);

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

  const handleUsernameChange = async () => {
    if (!newUsername || newUsername === userData?.username) {
      setEditingUsername(false);
      return;
    }

    // Validate username
    if (newUsername.length < 3 || newUsername.length > 20) {
      setError('Username must be between 3 and 20 characters');
      return;
    }

    if (!/^[a-zA-Z0-9_]+$/.test(newUsername)) {
      setError('Username can only contain letters, numbers, and underscores');
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await authService.changeUsername(newUsername);
      
      if (response.success) {
        setSuccess('Username changed successfully! This was your one-time username change.');
        setEditingUsername(false);
        await loadUserProfile();
        if (onProfileUpdate) {
          onProfileUpdate();
        }
      }
    } catch (error: any) {
      setError(error.message || 'Failed to change username');
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

  const handleResendVerification = async () => {
    setResendingVerification(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await authService.resendVerificationEmail();
      
      if (response.success) {
        setSuccess(response.message || 'Verification email has been resent. Please check your email.');
      }
    } catch (error: any) {
      setError(error.message || 'Failed to resend verification email');
    } finally {
      setResendingVerification(false);
    }
  };

  const formatTime = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  };

  const handleDeleteAccountRequest = async () => {
    const isVerified = userData?.isVerified || userData?.is_verified;
    
    if (!isVerified) {
      setError('Your email must be verified to delete your account. Please verify your email first or contact an administrator for assistance.');
      setShowDeleteModal(false);
      return;
    }

    if (deleteConfirmText !== 'DELETE MY ACCOUNT') {
      setError('Please type "DELETE MY ACCOUNT" exactly to confirm');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await authService.requestAccountDeletion();
      
      if (response.success) {
        setSuccess('A confirmation email has been sent. Please check your email to confirm account deletion.');
        setShowDeleteModal(false);
        setDeleteConfirmText('');
        setDeletionRequested(true);
      }
    } catch (error: any) {
      setError(error.message || 'Failed to request account deletion');
    } finally {
      setLoading(false);
    }
  };

  const handleCancelDeletion = () => {
    setShowDeleteModal(false);
    setDeleteConfirmText('');
    setError(null);
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
              {editingUsername ? (
                <div className="username-edit-container">
                  <input
                    type="text"
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                    placeholder="Enter new username"
                    disabled={loading}
                    maxLength={20}
                  />
                  <div className="username-edit-buttons">
                    <button 
                      className="btn-save-username"
                      onClick={handleUsernameChange}
                      disabled={loading}
                    >
                      Save
                    </button>
                    <button 
                      className="btn-cancel-username"
                      onClick={() => {
                        setEditingUsername(false);
                        setNewUsername(userData?.username || '');
                        setError(null);
                      }}
                      disabled={loading}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="field-value-with-action">
                  <span className="field-value">{userData?.username}</span>
                  {userData?.canChangeUsername && (
                    <button 
                      className="btn-change-username"
                      onClick={() => {
                        setEditingUsername(true);
                        setNewUsername(userData?.username || '');
                      }}
                      title="You can change your username once (OAuth users only)"
                    >
                      Change (One-time)
                    </button>
                  )}
                </div>
              )}
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
                    <>
                      <span className="verification-warning">⚠️ Not verified</span>
                      <button 
                        className="btn-resend-verification"
                        onClick={handleResendVerification}
                        disabled={resendingVerification}
                        title="Resend verification email"
                      >
                        {resendingVerification ? 'Sending...' : 'Resend Verification'}
                      </button>
                    </>
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

          <div className="profile-section danger-zone">
            <h3>Danger Zone</h3>
            <div className="danger-zone-content">
              <div className="danger-zone-item">
                <div className="danger-zone-info">
                  <h4>Delete Account</h4>
                  <p>Once you delete your account, there is a 15-day grace period before your data is permanently removed. You can restore your account within this period by logging in.</p>
                </div>
                <button 
                  className="btn btn-danger"
                  onClick={() => setShowDeleteModal(true)}
                  disabled={deletionRequested}
                >
                  {deletionRequested ? 'Deletion Requested' : 'Delete Account'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {showDeleteModal && (
        <div className="delete-modal-overlay" onClick={handleCancelDeletion}>
          <div className="delete-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Delete Account</h3>
            
            {(userData?.isVerified || userData?.is_verified) ? (
              <>
                <div className="delete-modal-warning">
                  <p><strong>Warning:</strong> This action will delete your account and all associated data.</p>
                  <ul>
                    <li>Your account will be flagged for deletion immediately</li>
                    <li>You will receive an email to confirm this action</li>
                    <li>After confirmation, you have 15 days to restore your account</li>
                    <li>After 15 days, all your data will be permanently deleted</li>
                  </ul>
                </div>

                <div className="delete-confirmation-input">
                  <label>Type <strong>DELETE MY ACCOUNT</strong> to confirm:</label>
                  <input
                    type="text"
                    value={deleteConfirmText}
                    onChange={(e) => setDeleteConfirmText(e.target.value)}
                    placeholder="Type here to confirm"
                    disabled={loading}
                  />
                </div>

                {error && (
                  <div className="alert alert-error">
                    {error}
                  </div>
                )}

                <div className="delete-modal-actions">
                  <button 
                    className="btn btn-danger"
                    onClick={handleDeleteAccountRequest}
                    disabled={loading || deleteConfirmText !== 'DELETE MY ACCOUNT'}
                  >
                    {loading ? 'Processing...' : 'Request Deletion'}
                  </button>
                  <button 
                    className="btn btn-secondary"
                    onClick={handleCancelDeletion}
                    disabled={loading}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <div className="delete-modal-unverified">
                <p>Your email address must be verified before you can delete your account.</p>
                <p>Please verify your email first or contact an administrator at support@onestreamer.live for assistance with account deletion.</p>
                <div className="delete-modal-actions">
                  <button 
                    className="btn btn-secondary"
                    onClick={handleCancelDeletion}
                  >
                    Close
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default ProfileSettings;