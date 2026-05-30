import React from 'react';
import EmojiPicker from '../EmojiPicker';
import ChatSettings from '../ChatSettings';
import { UserInfo, ChatUserSettings } from './types';

export interface ChatControlsProps {
  /** Current user identity (null until assigned). Drives the username block. */
  userInfo: UserInfo | null;
  /** Whether an auth token is present (controls bonus icon visibility). */
  hasAuthToken: boolean;
  /** Current chat settings (own color + timestamps). */
  chatSettings: ChatUserSettings;

  /** Settings panel open state + toggle. */
  showSettings: boolean;
  onToggleSettings: () => void;
  onCloseSettings: () => void;

  /** Emoji picker open state + toggle. */
  showEmojiPicker: boolean;
  onToggleEmojiPicker: () => void;
  onCloseEmojiPicker: () => void;
  onEmojiSelect: (emojiCode: string) => void;

  /** Bonus icon state + handler. */
  bonusIconActive: boolean;
  bonusIconCooldown: boolean;
  onBonusClick: () => void;

  /** Settings callbacks. */
  onColorChange: (color: string) => void;
  onSettingsChange: (settings: ChatUserSettings) => void;
}

/**
 * The control cluster that sits inside the chat input bar (above/around the
 * text input): the current-username label + settings gear, the custom-emoji
 * picker toggle and panel, and the bonus-points icon. The text input + send
 * button (`ChatInput`) remains a sibling rendered by the parent.
 *
 * Extracted verbatim from Chat.tsx — DOM structure, class names, titles, and
 * emoji glyphs are unchanged so the characterization test stays green.
 */
export const ChatControls: React.FC<ChatControlsProps> = ({
  userInfo,
  hasAuthToken,
  chatSettings,
  showSettings,
  onToggleSettings,
  onCloseSettings,
  showEmojiPicker,
  onToggleEmojiPicker,
  onCloseEmojiPicker,
  onEmojiSelect,
  bonusIconActive,
  bonusIconCooldown,
  onBonusClick,
  onColorChange,
  onSettingsChange,
}) => {
  return (
    <>
      {userInfo && (
        <div className="user-info">
          <span className="current-username" style={{ color: chatSettings.userColor || userInfo.color }}>
            {userInfo.username}
          </span>
          <button
            className={`chat-settings-button ${showSettings ? 'active' : ''}`}
            onClick={onToggleSettings}
            title="Chat settings"
          >
            ⚙️
          </button>
        </div>
      )}

      <button
        className={`emoji-picker-button ${showEmojiPicker ? 'active' : ''}`}
        onClick={onToggleEmojiPicker}
        title="Custom emojis"
      >
        😊
      </button>

      {hasAuthToken && (
        <button
          className={`bonus-icon ${bonusIconActive ? 'active' : ''} ${bonusIconCooldown ? 'cooldown' : ''}`}
          onClick={onBonusClick}
          disabled={!bonusIconActive || bonusIconCooldown}
          title={bonusIconActive ? 'Click for 100 bonus points!' : 'Bonus points coming soon...'}
        >
          <span className="bonus-icon-symbol">🎁</span>
          {bonusIconActive && <span className="bonus-icon-glow"></span>}
        </button>
      )}

      {showEmojiPicker && (
        <EmojiPicker
          onEmojiSelect={onEmojiSelect}
          onClose={onCloseEmojiPicker}
        />
      )}

      {showSettings && (
        <ChatSettings
          isOpen={showSettings}
          onClose={onCloseSettings}
          currentColor={chatSettings.userColor || userInfo?.color || '#4ECDC4'}
          onColorChange={onColorChange}
          onSettingsChange={onSettingsChange}
          currentSettings={chatSettings}
          username={userInfo?.username || 'User'}
        />
      )}
    </>
  );
};

export default ChatControls;
