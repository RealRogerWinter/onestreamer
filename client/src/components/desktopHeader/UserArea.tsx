import React from 'react';
import UserProfile from '../user/UserProfile';
import PointsDisplay from './PointsDisplay';
import TheatreActions from './TheatreActions';
import { DesktopHeaderV2Props } from './types';

type UserAreaProps = Pick<
  DesktopHeaderV2Props,
  | 'isAuthenticated'
  | 'currentUser'
  | 'userPoints'
  | 'isAdmin'
  | 'isModerator'
  | 'isTheatreMode'
  | 'theatreDropdownOpen'
  | 'onLogin'
  | 'onSignup'
  | 'onLogout'
  | 'onProfileSettings'
  | 'onAdminPanel'
  | 'onUserProfileUpdate'
  | 'onInventoryToggle'
  | 'onTheatreDropdownToggle'
  | 'onShowAbout'
  | 'onShowTerms'
  | 'onShowPrivacy'
  | 'onShowTutorial'
  | 'onShowBugReport'
  | 'soundVolume'
  | 'onSoundVolumeChange'
  | 'socket'
> & {
  showInventoryHint: boolean;
  onCloseInventoryHint: () => void;
};

const UserArea: React.FC<UserAreaProps> = ({
  isAuthenticated,
  currentUser,
  userPoints,
  isAdmin,
  isModerator = false,
  isTheatreMode = false,
  theatreDropdownOpen = false,
  onLogin,
  onSignup,
  onLogout,
  onProfileSettings,
  onAdminPanel,
  onUserProfileUpdate,
  onInventoryToggle,
  onTheatreDropdownToggle,
  onShowAbout,
  onShowTerms,
  onShowPrivacy,
  onShowTutorial,
  onShowBugReport,
  soundVolume = 0.8,
  onSoundVolumeChange,
  socket,
  showInventoryHint,
  onCloseInventoryHint,
}) => {
  const theatreActionProps = {
    theatreDropdownOpen,
    soundVolume,
    onSoundVolumeChange,
    onInventoryToggle,
    onTheatreDropdownToggle,
    onShowAbout,
    onShowTerms,
    onShowPrivacy,
    onShowTutorial,
    onShowBugReport,
  };

  return (
    <div className="header-v2-right">
      {isAuthenticated ? (
        <div className="user-area-modern">
          {/* Admin/Moderator Button - Moved to the left */}
          {(isAdmin || isModerator) && (
            <button
              className="admin-btn-modern"
              onClick={onAdminPanel}
              title={`${isAdmin ? 'Admin' : 'Moderator'} Panel (Ctrl+Shift+A)`}
            >
              <div className="admin-btn-bg"></div>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 15a3 3 0 100-6 3 3 0 000 6z"/>
                <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/>
              </svg>
            </button>
          )}

          {/* Divider for admins/moderators */}
          {(isAdmin || isModerator) && <div className="header-divider-vertical"></div>}

          {/* Theatre Mode Buttons - Inventory and Dropdown */}
          {isTheatreMode && <TheatreActions {...theatreActionProps} />}

          {/* Points Display with Animation Target */}
          <PointsDisplay userPoints={userPoints} />

          {/* User Profile */}
          <UserProfile
            socket={socket}
            currentUser={currentUser}
            onLogout={onLogout}
            onOpenProfileSettings={onProfileSettings}
            onUserProfileUpdate={onUserProfileUpdate}
          />
        </div>
      ) : (
        <div className="auth-area-modern">
          {/* Theatre Mode Buttons - Also visible for non-authenticated users */}
          {isTheatreMode && (
            <TheatreActions
              {...theatreActionProps}
              withInventoryHint
              showInventoryHint={showInventoryHint}
              onCloseInventoryHint={onCloseInventoryHint}
            />
          )}

          <button className="auth-btn-modern signin" onClick={onLogin}>
            <span>Sign In</span>
          </button>
          <button className="auth-btn-modern signup" onClick={onSignup}>
            <div className="signup-gradient"></div>
            <span>Get Started</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M5 12h14M12 5l7 7-7 7"/>
            </svg>
          </button>
        </div>
      )}
    </div>
  );
};

export default UserArea;
