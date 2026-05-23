import React, { useState, useEffect, useRef } from 'react';
import authService from '../../services/AuthService';
import CookieConsentService from '../../services/CookieConsentService';
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
  avatar_url?: string;
  description?: string;
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
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [description, setDescription] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      loadUserProfile();
    }
  }, [isOpen]);

  useEffect(() => {
    // Clean up avatar preview URL when component unmounts
    return () => {
      if (avatarPreview && avatarPreview.startsWith('blob:')) {
        URL.revokeObjectURL(avatarPreview);
      }
    };
  }, [avatarPreview]);

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
        setDescription(profile.user.description || '');
        if (profile.user.avatar_url) {
          setAvatarPreview(profile.user.avatar_url);
        }
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

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file size (5MB max)
    if (file.size > 5 * 1024 * 1024) {
      setError('Avatar file size must be less than 5MB');
      return;
    }

    // Validate file type - only accept common image formats
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      setError('Please select a valid image file (JPG, PNG, GIF, or WebP)');
      return;
    }

    // Check file extension as additional validation
    const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const fileName = file.name.toLowerCase();
    const hasValidExtension = allowedExtensions.some(ext => fileName.endsWith(ext));
    if (!hasValidExtension) {
      setError('Invalid file extension. Allowed: JPG, PNG, GIF, WebP');
      return;
    }

    setAvatarFile(file);
    setError(null);
    
    // Create preview while uploading
    const reader = new FileReader();
    reader.onloadend = () => {
      setAvatarPreview(reader.result as string);
    };
    reader.readAsDataURL(file);

    // Automatically upload the file
    await uploadAvatar(file);
  };

  const uploadAvatar = async (file: File) => {
    setUploadingAvatar(true);
    setError(null);
    setSuccess(null);

    try {
      const formData = new FormData();
      formData.append('avatar', file);

      const response = await authService.uploadAvatar(formData);
      
      if (response.success) {
        setSuccess('Avatar uploaded successfully');
        setAvatarFile(null);
        // Update the preview with the server URL
        if (response.avatar_url) {
          setAvatarPreview(response.avatar_url);
        }
        await loadUserProfile();
        if (onProfileUpdate) {
          onProfileUpdate();
        }
      }
    } catch (error: any) {
      setError(error.message || 'Failed to upload avatar');
      // Reset preview on error
      if (userData?.avatar_url) {
        setAvatarPreview(userData.avatar_url);
      } else {
        setAvatarPreview(null);
      }
      setAvatarFile(null);
    } finally {
      setUploadingAvatar(false);
      // Clear file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // No longer needed - upload happens automatically

  const handleAvatarDelete = async () => {
    if (!window.confirm('Are you sure you want to remove your avatar?')) {
      return;
    }

    setUploadingAvatar(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await authService.deleteAvatar();
      
      if (response.success) {
        setSuccess('Avatar removed successfully');
        setAvatarPreview(null);
        await loadUserProfile();
        if (onProfileUpdate) {
          onProfileUpdate();
        }
      }
    } catch (error: any) {
      setError(error.message || 'Failed to remove avatar');
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleSaveDescription = async () => {
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await authService.updateProfile({ description });
      
      if (response.success) {
        setSuccess('Description updated successfully');
        if (onProfileUpdate) {
          onProfileUpdate();
        }
      }
    } catch (error: any) {
      setError(error.message || 'Failed to update description');
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
            <h3>Profile</h3>
            
            {/* Avatar Section */}
            <div className="profile-field avatar-section">
              <label>Avatar</label>
              <div className="avatar-container">
                <div className="avatar-preview">
                  {uploadingAvatar && (
                    <div className="avatar-upload-overlay">
                      <div className="upload-spinner"></div>
                    </div>
                  )}
                  {avatarPreview ? (
                    <img src={avatarPreview} alt="Avatar" />
                  ) : (
                    <div className="avatar-placeholder">
                      {userData?.username?.substring(0, 2).toUpperCase()}
                    </div>
                  )}
                </div>
                <div className="avatar-actions">
                  <input
                    type="file"
                    ref={fileInputRef}
                    accept="image/jpeg,image/jpg,image/png,image/gif,image/webp"
                    style={{ display: 'none' }}
                    onChange={handleAvatarChange}
                    disabled={uploadingAvatar}
                  />
                  <button
                    className="btn btn-secondary"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadingAvatar}
                  >
                    {uploadingAvatar ? 'Uploading...' : userData?.avatar_url ? 'Change Avatar' : 'Upload Avatar'}
                  </button>
                  {userData?.avatar_url && !uploadingAvatar && (
                    <button
                      className="btn btn-danger"
                      onClick={handleAvatarDelete}
                    >
                      Remove
                    </button>
                  )}
                </div>
                <div className="avatar-help-text">
                  <small>Recommended: 200x200px • Max size: 5MB</small>
                  <small>Formats: JPG, PNG, GIF, WebP</small>
                </div>
              </div>
            </div>

            {/* Description Section */}
            <div className="profile-field">
              <label>Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Tell others about yourself..."
                maxLength={500}
                rows={4}
                disabled={loading}
              />
              <div className="character-count">
                {description.length}/500 characters
              </div>
              {description !== (userData?.description || '') && (
                <button
                  className="btn btn-primary"
                  onClick={handleSaveDescription}
                  disabled={loading}
                  style={{ marginTop: '10px' }}
                >
                  {loading ? 'Saving...' : 'Save Description'}
                </button>
              )}
            </div>
          </div>

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

          <div className="profile-section privacy-section">
            <h3>Privacy Settings</h3>
            <div className="privacy-content">
              <div className="privacy-item">
                <div className="privacy-info">
                  <h4>Cookie Preferences</h4>
                  <p>Manage your cookie settings and control what data is collected about your browsing experience.</p>
                </div>
                <button 
                  className="btn btn-secondary"
                  onClick={() => CookieConsentService.showPreferences()}
                >
                  Manage Cookies
                </button>
              </div>
            </div>
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