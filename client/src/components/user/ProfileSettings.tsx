import React from 'react';
import './ProfileSettings.css';
import { ProfileSettingsProps } from './profileSettings/types';
import { useProfileSettings } from './profileSettings/useProfileSettings';
import ProfileSection from './profileSettings/ProfileSection';
import AccountInfoSection from './profileSettings/AccountInfoSection';
import StatsSection from './profileSettings/StatsSection';
import PrivacySection from './profileSettings/PrivacySection';
import DangerZoneSection from './profileSettings/DangerZoneSection';
import DeleteAccountModal from './profileSettings/DeleteAccountModal';

const ProfileSettings: React.FC<ProfileSettingsProps> = ({ isOpen, onClose, onProfileUpdate }) => {
  const {
    userData,
    userStats,
    editMode,
    setEditMode,
    editingUsername,
    setEditingUsername,
    formData,
    newUsername,
    setNewUsername,
    loading,
    error,
    success,
    setError,
    resendingVerification,
    showDeleteModal,
    setShowDeleteModal,
    deleteConfirmText,
    setDeleteConfirmText,
    deletionRequested,
    avatarPreview,
    uploadingAvatar,
    description,
    setDescription,
    fileInputRef,
    handleInputChange,
    handleSave,
    handleUsernameChange,
    handleAvatarChange,
    handleAvatarDelete,
    handleSaveDescription,
    handleCancel,
    handleResendVerification,
    handleDeleteAccountRequest,
    handleCancelDeletion,
  } = useProfileSettings({ isOpen, onProfileUpdate });

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

          <ProfileSection
            userData={userData}
            avatarPreview={avatarPreview}
            uploadingAvatar={uploadingAvatar}
            fileInputRef={fileInputRef}
            handleAvatarChange={handleAvatarChange}
            handleAvatarDelete={handleAvatarDelete}
            description={description}
            setDescription={setDescription}
            loading={loading}
            handleSaveDescription={handleSaveDescription}
          />

          <AccountInfoSection
            userData={userData}
            editMode={editMode}
            editingUsername={editingUsername}
            setEditingUsername={setEditingUsername}
            newUsername={newUsername}
            setNewUsername={setNewUsername}
            loading={loading}
            setError={setError}
            handleUsernameChange={handleUsernameChange}
            formData={formData}
            handleInputChange={handleInputChange}
            resendingVerification={resendingVerification}
            handleResendVerification={handleResendVerification}
          />

          {userStats && <StatsSection userStats={userStats} />}

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

          <PrivacySection />

          <DangerZoneSection
            deletionRequested={deletionRequested}
            setShowDeleteModal={setShowDeleteModal}
          />
        </div>
      </div>

      {showDeleteModal && (
        <DeleteAccountModal
          userData={userData}
          deleteConfirmText={deleteConfirmText}
          setDeleteConfirmText={setDeleteConfirmText}
          loading={loading}
          error={error}
          handleDeleteAccountRequest={handleDeleteAccountRequest}
          handleCancelDeletion={handleCancelDeletion}
        />
      )}
    </div>
  );
};

export default ProfileSettings;
