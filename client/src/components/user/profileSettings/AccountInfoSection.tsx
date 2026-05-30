import React from 'react';
import { UserData, ProfileFormData } from './types';

interface AccountInfoSectionProps {
  userData: UserData | null;
  editMode: boolean;
  editingUsername: boolean;
  setEditingUsername: (value: boolean) => void;
  newUsername: string;
  setNewUsername: (value: string) => void;
  loading: boolean;
  setError: (value: string | null) => void;
  handleUsernameChange: () => void;
  formData: ProfileFormData;
  handleInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  resendingVerification: boolean;
  handleResendVerification: () => void;
}

const AccountInfoSection: React.FC<AccountInfoSectionProps> = ({
  userData,
  editMode,
  editingUsername,
  setEditingUsername,
  newUsername,
  setNewUsername,
  loading,
  setError,
  handleUsernameChange,
  formData,
  handleInputChange,
  resendingVerification,
  handleResendVerification,
}) => {
  return (
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
  );
};

export default AccountInfoSection;
