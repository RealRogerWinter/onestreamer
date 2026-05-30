export interface ProfileSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  onProfileUpdate?: () => void;
}

export interface UserData {
  username: string;
  email: string;
  isVerified?: boolean;
  is_verified?: boolean;
  canChangeUsername?: boolean;
  avatar_url?: string;
  description?: string;
}

export interface UserStats {
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

export interface ProfileFormData {
  username: string;
  email: string;
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}
