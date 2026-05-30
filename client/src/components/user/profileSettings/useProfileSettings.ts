import { useState, useEffect, useRef } from 'react';
import authService from '../../../services/AuthService';
import { ProfileSettingsProps, UserData, UserStats, ProfileFormData } from './types';

/**
 * Owns all state + side-effects for ProfileSettings. Extracted verbatim from
 * the original component so the rendered DOM and observable behavior are
 * unchanged. The parent component is a thin orchestrator over this hook.
 */
export function useProfileSettings({
  isOpen,
  onProfileUpdate,
}: Pick<ProfileSettingsProps, 'isOpen' | 'onProfileUpdate'>) {
  const [userData, setUserData] = useState<UserData | null>(null);
  const [userStats, setUserStats] = useState<UserStats | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [editingUsername, setEditingUsername] = useState(false);
  const [formData, setFormData] = useState<ProfileFormData>({
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
      const uploadData = new FormData();
      uploadData.append('avatar', file);

      const response = await authService.uploadAvatar(uploadData);

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

  return {
    // state
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
    // handlers
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
  };
}

export const formatTime = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
};
