import React from 'react';
import './DesktopHeaderV2.css';
import { DesktopHeaderV2Props } from './desktopHeader/types';
import { useHeaderChrome } from './desktopHeader/useHeaderChrome';
import BrandLogo from './desktopHeader/BrandLogo';
import StreamStats from './desktopHeader/StreamStats';
import UserArea from './desktopHeader/UserArea';

const DesktopHeaderV2: React.FC<DesktopHeaderV2Props> = ({
  viewerCount,
  hasActiveStream,
  streamDuration,
  streamStartTime,
  streamerDisplayName,
  isRandomRotation = false,
  randomRotationPlatform,
  randomRotationStreamerUrl,
  randomRotationStreamerUsername,
  randomRotationGame,
  randomRotationViewers,
  randomRotationStartedAt,
  nextRotationAt,
  currentRotationDuration,
  isRotationLocked = false,
  lockedRemainingMs,
  isAuthenticated,
  currentUser,
  userPoints,
  isAdmin,
  isModerator = false,
  isTheatreMode = false,
  showInventory = false,
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
  socket
}) => {
  const { currentTime, isScrolled, showInventoryHint, setShowInventoryHint } =
    useHeaderChrome(isAuthenticated, isTheatreMode);

  return (
    <header className={`desktop-header-v2 ${isScrolled ? 'scrolled' : ''}`}>
      {/* Animated background gradient */}
      <div className="header-background">
        <div className="gradient-mesh"></div>
        <div className="noise-overlay"></div>
      </div>

      <div className="header-v2-container">
        {/* Left Section - Modern Logo */}
        <BrandLogo />

        {/* Center Section - Dynamic Stream Stats */}
        <StreamStats
          viewerCount={viewerCount}
          hasActiveStream={hasActiveStream}
          streamDuration={streamDuration}
          streamStartTime={streamStartTime}
          streamerDisplayName={streamerDisplayName}
          isRandomRotation={isRandomRotation}
          randomRotationPlatform={randomRotationPlatform}
          randomRotationStreamerUrl={randomRotationStreamerUrl}
          randomRotationStreamerUsername={randomRotationStreamerUsername}
          randomRotationGame={randomRotationGame}
          randomRotationViewers={randomRotationViewers}
          nextRotationAt={nextRotationAt}
          currentRotationDuration={currentRotationDuration}
          isRotationLocked={isRotationLocked}
          lockedRemainingMs={lockedRemainingMs}
          currentTime={currentTime}
        />

        {/* Right Section - User Area */}
        <UserArea
          isAuthenticated={isAuthenticated}
          currentUser={currentUser}
          userPoints={userPoints}
          isAdmin={isAdmin}
          isModerator={isModerator}
          isTheatreMode={isTheatreMode}
          theatreDropdownOpen={theatreDropdownOpen}
          onLogin={onLogin}
          onSignup={onSignup}
          onLogout={onLogout}
          onProfileSettings={onProfileSettings}
          onAdminPanel={onAdminPanel}
          onUserProfileUpdate={onUserProfileUpdate}
          onInventoryToggle={onInventoryToggle}
          onTheatreDropdownToggle={onTheatreDropdownToggle}
          onShowAbout={onShowAbout}
          onShowTerms={onShowTerms}
          onShowPrivacy={onShowPrivacy}
          onShowTutorial={onShowTutorial}
          onShowBugReport={onShowBugReport}
          soundVolume={soundVolume}
          onSoundVolumeChange={onSoundVolumeChange}
          socket={socket}
          showInventoryHint={showInventoryHint}
          onCloseInventoryHint={() => setShowInventoryHint(false)}
        />
      </div>
    </header>
  );
};

export default DesktopHeaderV2;
