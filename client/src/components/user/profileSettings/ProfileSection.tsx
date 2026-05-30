import React from 'react';
import { UserData } from './types';

interface ProfileSectionProps {
  userData: UserData | null;
  avatarPreview: string | null;
  uploadingAvatar: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  handleAvatarChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleAvatarDelete: () => void;
  description: string;
  setDescription: (value: string) => void;
  loading: boolean;
  handleSaveDescription: () => void;
}

const ProfileSection: React.FC<ProfileSectionProps> = ({
  userData,
  avatarPreview,
  uploadingAvatar,
  fileInputRef,
  handleAvatarChange,
  handleAvatarDelete,
  description,
  setDescription,
  loading,
  handleSaveDescription,
}) => {
  return (
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
  );
};

export default ProfileSection;
