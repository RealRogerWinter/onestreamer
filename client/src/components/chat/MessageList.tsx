import React from 'react';
import DOMPurify from 'dompurify';
import { ChatMessage } from '../../hooks/useChatMessages';
import { UserInfo } from '../../hooks/useChatSocket';
import { ChatUserSettings } from '../ChatSettings';

export interface MessageListProps {
  /** Ordered list of chat messages to render. */
  messages: ChatMessage[];
  /** Current user, used for own-color override + self-mention check. */
  userInfo: UserInfo | null;
  /** User-facing chat settings (timestamp visibility, format, own color). */
  chatSettings: ChatUserSettings;
  /** Custom emoji code -> URL map for `:code:` rendering inside messages. */
  customEmojis: Map<string, string>;
  /** Current connection status; drives the connecting / error placeholders. */
  connectionStatus: 'connected' | 'connecting' | 'error' | 'disconnected' | string;
  /** Whether the user has scrolled away from the bottom of the list. */
  isScrolledUp: boolean;
  /** Number of new messages received while scrolled up. */
  newMessagesCount: number;
  /** Click handler for the "N new messages" jump-to-bottom badge. */
  onJumpToBottom: () => void;
  /** Click handler when a username in a message is clicked. */
  onUsernameClick: (username: string, event: React.MouseEvent) => void;
  /**
   * Ref to the scroll container (the `.chat-messages` element). Forwarded
   * directly so the parent can attach scroll listeners + MutationObservers.
   */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /**
   * Ref to the bottom sentinel inside the list. Kept around as a stable
   * scroll target / future anchor; parent currently uses containerRef for
   * scrollTop manipulation.
   */
  endRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Renders the scrollback portion of the chat: the messages list, status
 * placeholders, and the "N new messages" overlay shown when the user is
 * scrolled up.
 *
 * Scroll behavior (auto-scroll, MutationObserver, scroll listeners) lives in
 * the parent — this component just paints the DOM and forwards the container
 * ref so the parent can attach observers/listeners to it.
 */
const isUserMentioned = (msg: ChatMessage, userInfo: UserInfo | null): boolean => {
  if (!userInfo || !msg.mentions || msg.mentions.length === 0) {
    return false;
  }
  // Check if current user's username (without emoji prefix) is in mentions
  const currentUsername = userInfo.username.replace(/^🤖\s*/, '').toLowerCase();
  return msg.mentions.some(mention => mention.toLowerCase() === currentUsername);
};

const formatTimestamp = (
  timestamp: string,
  fullTimestamp: string,
  chatSettings: ChatUserSettings,
): string => {
  if (!chatSettings.showTimestamps) {
    return '';
  }

  switch (chatSettings.timestampFormat) {
    case 'long': {
      // Parse the full timestamp and format to HH:MM:SS
      if (fullTimestamp) {
        const date = new Date(fullTimestamp);
        const hours = date.getHours().toString().padStart(2, '0');
        const minutes = date.getMinutes().toString().padStart(2, '0');
        const seconds = date.getSeconds().toString().padStart(2, '0');
        return `${hours}:${minutes}:${seconds}`;
      }
      return timestamp;
    }
    case 'relative': {
      // Parse the timestamp and calculate relative time
      const messageTime = new Date(fullTimestamp || `${new Date().toDateString()} ${timestamp}`);
      const now = new Date();
      const diff = now.getTime() - messageTime.getTime();
      const seconds = Math.floor(diff / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);

      if (hours > 0) return `${hours}h ago`;
      if (minutes > 0) return `${minutes}m ago`;
      if (seconds > 30) return `${seconds}s ago`;
      return 'just now';
    }
    case 'short':
    default: {
      // For short format, also use local time but only show HH:MM
      if (fullTimestamp) {
        const date = new Date(fullTimestamp);
        const hours = date.getHours().toString().padStart(2, '0');
        const minutes = date.getMinutes().toString().padStart(2, '0');
        return `${hours}:${minutes}`;
      }
      return timestamp;
    }
  }
};

const formatMessage = (
  text: string,
  customEmojis: Map<string, string>,
): string => {
  // STEP 1: First, escape ALL HTML to prevent XSS attacks
  // This converts <script> to &lt;script&gt;, etc.
  const escapeHtml = (unsafe: string): string => {
    return unsafe
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  };

  let safeText = escapeHtml(text);

  // STEP 1.5: Process @ mentions - highlight them
  const mentionRegex = /@([a-zA-Z0-9_-]+)/g;
  safeText = safeText.replace(mentionRegex, (_match, username) => {
    // Mark mentions with a special delimiter so we can preserve them
    return `{{MENTION_START}}<span class="chat-mention">@${username}</span>{{MENTION_END}}`;
  });

  // STEP 2: Process emoji codes - these are safe because we control the HTML
  const emojiRegex = /:([a-zA-Z0-9_-]+):/g;
  safeText = safeText.replace(emojiRegex, (match, code) => {
    const emojiUrl = customEmojis.get(code);
    if (emojiUrl) {
      // Sanitize the URL to prevent javascript: or data: URLs
      const safeUrl = DOMPurify.sanitize(emojiUrl);
      // Mark emojis with a special delimiter so we can preserve them
      return `{{EMOJI_START}}<img src="${safeUrl}" alt=":${code}:" class="chat-emoji" title=":${code}:" />{{EMOJI_END}}`;
    }
    return match; // Return original if no emoji found
  });

  // STEP 3: Process URLs - convert them to clickable links
  // Split by emoji and mention markers to avoid replacing URLs inside them
  const parts = safeText.split(/({{(?:EMOJI|MENTION)_START}}.*?{{(?:EMOJI|MENTION)_END}})/);
  safeText = parts.map((part) => {
    // Skip parts that are emoji or mention markers
    if (part.startsWith('{{EMOJI_START}}') || part.startsWith('{{MENTION_START}}')) {
      return part;
    }
    // Replace URLs in non-emoji/non-mention parts
    const urlRegex = /(https?:\/\/[^\s<>&]+)/g;
    return part.replace(urlRegex, (_match, url) => {
      // Sanitize the URL to prevent XSS
      const safeUrl = DOMPurify.sanitize(url);
      // Add a data attribute with the URL for the click handler
      return `{{LINK_START}}<a href="${safeUrl}" data-external-url="${safeUrl}" class="chat-link" target="_blank" rel="noopener noreferrer">${safeUrl}</a>{{LINK_END}}`;
    });
  }).join('');

  // STEP 4: Remove our special markers and prepare final HTML
  safeText = safeText
    .replace(/{{EMOJI_START}}/g, '')
    .replace(/{{EMOJI_END}}/g, '')
    .replace(/{{MENTION_START}}/g, '')
    .replace(/{{MENTION_END}}/g, '')
    .replace(/{{LINK_START}}/g, '')
    .replace(/{{LINK_END}}/g, '');

  // STEP 5: Final sanitization with DOMPurify
  // Configure DOMPurify to only allow specific tags and attributes
  const config = {
    ALLOWED_TAGS: ['img', 'a', 'span'],
    ALLOWED_ATTR: ['src', 'alt', 'class', 'title', 'href', 'target', 'rel'],
    ALLOWED_PROTOCOLS: ['http', 'https'],
    KEEP_CONTENT: true,
    // Don't allow any data: or javascript: URLs
    ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?):\/\/)/,
  };

  const cleanHtml = DOMPurify.sanitize(safeText, config);

  return cleanHtml;
};

interface MessageItemProps {
  msg: ChatMessage;
  isMentioned: boolean;
  ownColor: string;
  isOwn: boolean;
  showTimestamps: boolean;
  formattedTimestamp: string;
  formattedMessageHtml: string;
  onUsernameClick: (username: string, event: React.MouseEvent) => void;
}

/**
 * Renders a single chat message row: optional timestamp, clickable username
 * (with admin/moderator badges), and the message text (HTML pre-sanitized by
 * the parent before being injected).
 */
const MessageItem: React.FC<MessageItemProps> = ({
  msg,
  isMentioned,
  ownColor,
  isOwn,
  showTimestamps,
  formattedTimestamp,
  formattedMessageHtml,
  onUsernameClick,
}) => {
  return (
    <div className={`chat-message ${msg.isAnnouncement ? 'announcement' : ''} ${isMentioned ? 'mentioned' : ''}`}>
      {showTimestamps && (
        <span className="message-timestamp">
          {formattedTimestamp}
        </span>
      )}
      <span
        className="message-username clickable-username"
        style={{
          color: isOwn && ownColor ? ownColor : msg.color,
          cursor: 'pointer',
        }}
        onClick={(e) => onUsernameClick(msg.username, e)}
        title="Click to view profile"
      >
        {msg.isAdmin && <span className="user-badge admin-badge" title="Admin">👑</span>}
        {!msg.isAdmin && msg.isModerator && <span className="user-badge moderator-badge" title="Moderator">🛡️</span>}
        {msg.username}:
      </span>
      <span
        className="message-text"
        dangerouslySetInnerHTML={{ __html: formattedMessageHtml }}
      />
    </div>
  );
};

/**
 * MessageList — the chat scrollback container plus its "N new messages"
 * overlay. The parent passes the container + end refs in directly so it can
 * attach scroll listeners, MutationObservers, and ResizeObservers without
 * needing an imperative handle round-trip.
 */
export const MessageList: React.FC<MessageListProps> = ({
  messages,
  userInfo,
  chatSettings,
  customEmojis,
  connectionStatus,
  isScrolledUp,
  newMessagesCount,
  onJumpToBottom,
  onUsernameClick,
  containerRef,
  endRef,
}) => {
  return (
    <>
      <div className="chat-messages" ref={containerRef}>
        {messages.length === 0 && connectionStatus === 'connected' && (
          <div className="chat-empty">
            <p>No messages yet. Start the conversation!</p>
          </div>
        )}

        {messages.map((msg) => {
          const isMentioned = isUserMentioned(msg, userInfo);
          const formattedTimestamp = formatTimestamp(msg.timestamp, msg.fullTimestamp, chatSettings);
          const formattedMessageHtml = formatMessage(msg.message, customEmojis);
          const isOwn = msg.userId === userInfo?.userId;
          return (
            <MessageItem
              key={msg.id}
              msg={msg}
              isMentioned={isMentioned}
              ownColor={chatSettings.userColor || ''}
              isOwn={isOwn}
              showTimestamps={chatSettings.showTimestamps}
              formattedTimestamp={formattedTimestamp}
              formattedMessageHtml={formattedMessageHtml}
              onUsernameClick={onUsernameClick}
            />
          );
        })}

        {connectionStatus === 'connecting' && (
          <div className="chat-status-message">
            <p>Connecting to chat...</p>
          </div>
        )}

        {connectionStatus === 'error' && (
          <div className="chat-status-message error">
            <p>Failed to connect to chat service</p>
          </div>
        )}

        <div ref={endRef} />
      </div>

      {/* New Messages Overlay */}
      {isScrolledUp && newMessagesCount > 0 && (
        <div className="new-messages-overlay">
          <button
            className="new-messages-button"
            onClick={onJumpToBottom}
          >
            {newMessagesCount} new message{newMessagesCount !== 1 ? 's' : ''} ↓
          </button>
        </div>
      )}
    </>
  );
};

export default MessageList;
