import { Socket } from 'socket.io-client';

export interface DesktopHeaderV2Props {
  // Stream status
  viewerCount: number;
  hasActiveStream: boolean;
  streamDuration: number;
  streamStartTime: number | null;
  streamerDisplayName?: string | null;

  // Random rotation info
  isRandomRotation?: boolean;
  randomRotationPlatform?: string | null;
  randomRotationStreamerUrl?: string | null;
  randomRotationStreamerUsername?: string | null;
  randomRotationGame?: string | null;
  randomRotationViewers?: number | null;
  randomRotationStartedAt?: number | null;

  // Rotation timing (for countdown)
  nextRotationAt?: number | null;
  currentRotationDuration?: number | null;
  isRotationLocked?: boolean;
  lockedRemainingMs?: number | null;

  // Auth
  isAuthenticated: boolean;
  currentUser: any;
  userPoints: number;
  isAdmin: boolean;
  isModerator?: boolean;

  // Theatre Mode
  isTheatreMode?: boolean;
  showInventory?: boolean;
  theatreDropdownOpen?: boolean;

  // Actions
  onLogin: () => void;
  onSignup: () => void;
  onLogout: () => void;
  onProfileSettings: () => void;
  onAdminPanel: () => void;
  onUserProfileUpdate: (profile: any) => void;
  onInventoryToggle?: () => void;
  onTheatreDropdownToggle?: () => void;
  onShowAbout?: () => void;
  onShowTerms?: () => void;
  onShowPrivacy?: () => void;
  onShowTutorial?: () => void;
  onShowBugReport?: () => void;

  // Sound volume
  soundVolume?: number;
  onSoundVolumeChange?: (volume: number) => void;

  // Socket
  socket?: Socket | null;
}

export const formatDuration = (milliseconds: number): string => {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}:${(minutes % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
  }
  return `${minutes}:${(seconds % 60).toString().padStart(2, '0')}`;
};

export const formatTime = (date: Date): string => {
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
};

export const formatCountdown = (ms: number): string => {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};
