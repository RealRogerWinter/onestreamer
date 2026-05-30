import React, { useState, useEffect, useRef, useCallback } from 'react';
import authService from '../services/AuthService';
import CookieService, { COOKIE_NAMES } from '../services/CookieService';
import { ChatUserSettings } from './ChatSettings';
import CloudflareTurnstile from './CloudflareTurnstile';
import { TURNSTILE_SITE_KEY } from '../config/turnstile';
import ExternalLinkModal from './ExternalLinkModal';
import UserInfoPopup from './user/UserInfoPopup';
import { openPopoutChat } from './PopoutChat';
import { useChatMessages, ChatMessage } from '../hooks/useChatMessages';
import { useChatSocket, UserInfo } from '../hooks/useChatSocket';
import { ChatInput, ChatInputHandle } from './chat/ChatInput';
import { MessageList } from './chat/MessageList';
import { ChatControls } from './chat/ChatControls';
import { useChatBonus } from './chat/useChatBonus';
import { useChatScroll } from './chat/useChatScroll';
import './Chat.css';
import './PopoutChat.css';

interface ChatProps {
  className?: string;
}

declare global {
  interface Window {
    showFloatingPoints?: (amount: number, source?: string) => void;
  }
}

const Chat: React.FC<ChatProps> = ({ className = '' }) => {
  const {
    messages,
    replaceMessages,
    addMessage,
    clearMessages,
    removeMessages,
    pushHistory,
    resetHistoryIndex,
    historyPrev,
    historyNext,
  } = useChatMessages();
  const [userInfo, setUserInfo] = useState<UserInfo | null>(() => {
    // Restore user info from session storage
    const stored = sessionStorage.getItem('chatUserInfo');
    return stored ? JSON.parse(stored) : null;
  });
  const [userCount, setUserCount] = useState(() => {
    // Restore user count from session storage
    const stored = sessionStorage.getItem('chatUserCount');
    return stored ? parseInt(stored, 10) : 0;
  });
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [customEmojis, setCustomEmojis] = useState<Map<string, string>>(new Map());
  const [showSettings, setShowSettings] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [externalLinkModal, setExternalLinkModal] = useState<{ isOpen: boolean; url: string }>({ isOpen: false, url: '' });
  const [isPoppedOut, setIsPoppedOut] = useState(() => {
    // Don't show popped out state if we ARE the popout window
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('popout') === 'true') {
      return false;
    }
    return sessionStorage.getItem('chatPoppedOut') === 'true';
  });
  const popoutWindowRef = useRef<Window | null>(null);
  const [userInfoPopup, setUserInfoPopup] = useState<{
    username: string;
    position: { x: number; y: number };
  } | null>(null);
  const [chatSettings, setChatSettings] = useState<ChatUserSettings>(() => {
    // Load settings from cookies
    const saved = CookieService.getCookie(COOKIE_NAMES.CHAT_SETTINGS);
    if (saved) {
      return saved;
    }
    // Try localStorage as fallback for migration
    const legacySaved = localStorage.getItem('chatSettings');
    if (legacySaved) {
      try {
        const settings = JSON.parse(legacySaved);
        // Migrate to cookies
        CookieService.setCookie(COOKIE_NAMES.CHAT_SETTINGS, settings);
        // Clean up localStorage
        localStorage.removeItem('chatSettings');
        return settings;
      } catch {
        // Default settings if parse fails
      }
    }
    return {
      showTimestamps: true,
      timestampFormat: 'long' as const,
      userColor: userInfo?.color || '#4ECDC4'
    };
  });
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<ChatInputHandle>(null);

  // Scroll behavior (auto-scroll, observers, scrolled-up state) lives in a
  // dedicated hook; it owns the `.chat-messages` container ref.
  const {
    containerRef: chatContainerRef,
    isScrolledUp,
    newMessagesCount,
    scrollToBottom,
    jumpToBottom,
    resetScrollState,
  } = useChatScroll(messages, isPoppedOut);

  // Bonus-points icon (server-driven availability + claim) lives in its own hook.
  const { bonusIconActive, bonusIconCooldown, handleBonusClick } = useChatBonus(userInfo);

  // Chat socket subscription + send.
  // The socket itself is owned by SocketContext; this hook wires the chat-
  // specific listeners through callbacks that update parent-owned state.
  const handleSocketUserAssigned = useCallback((data: UserInfo) => {
    setUserInfo(data);
    sessionStorage.setItem('chatUserInfo', JSON.stringify(data));
    // Update settings with the assigned color if it's different
    setChatSettings(prev => {
      if (data.color === prev.userColor) return prev;
      const next = { ...prev, userColor: data.color };
      CookieService.setCookie(COOKIE_NAMES.CHAT_SETTINGS, next);
      return next;
    });
  }, []);

  const handleSocketMessagesReplace = useCallback((history: ChatMessage[]) => {
    replaceMessages(history);
    // Force scroll to bottom after chat history loads; small delay to let DOM update.
    setTimeout(() => {
      const chatContainer = chatContainerRef.current;
      if (chatContainer) {
        chatContainer.scrollTop = chatContainer.scrollHeight;
        resetScrollState();
      }
    }, 50);
  }, [replaceMessages, chatContainerRef, resetScrollState]);

  const handleSocketUserCountChange = useCallback((count: number) => {
    setUserCount(count);
    sessionStorage.setItem('chatUserCount', count.toString());
  }, []);

  const handleSocketBanned = useCallback((data: { reason: string }) => {
    alert(`You have been banned from chat: ${data.reason}`);
    chatInputRef.current?.clear();
  }, []);

  const handleSocketTimeout = useCallback((data: { reason: string; endTime: number }) => {
    const remainingTime = Math.ceil((data.endTime - Date.now()) / 1000);
    alert(`You have been timed out for ${remainingTime} seconds: ${data.reason}`);
    chatInputRef.current?.clear();
  }, []);

  const { socket: chatSocket, connectionStatus, sendMessage: emitChatMessage } = useChatSocket({
    onMessage: addMessage,
    onMessagesReplace: handleSocketMessagesReplace,
    onDeleteMessages: removeMessages,
    onChatCleared: clearMessages,
    onUserAssigned: handleSocketUserAssigned,
    onUserCountChange: handleSocketUserCountChange,
    onBanned: handleSocketBanned,
    onTimeout: handleSocketTimeout,
  });
  const isConnected = connectionStatus === 'connected';


  // Listen for messages from popout window
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data.type === 'POPOUT_CLOSED') {
        setIsPoppedOut(false);
        popoutWindowRef.current = null;
      }
    };

    window.addEventListener('message', handleMessage);
    
    // Check if popout window is still open on mount
    if (isPoppedOut && popoutWindowRef.current) {
      if (popoutWindowRef.current.closed) {
        setIsPoppedOut(false);
        sessionStorage.removeItem('chatPoppedOut');
        popoutWindowRef.current = null;
      }
    }

    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [isPoppedOut]);

  // Reset scroll state when returning from popout
  useEffect(() => {
    if (!isPoppedOut && chatContainerRef.current) {
      // Chat is back in main window, ensure scroll works
      resetScrollState();

      // Re-attach scroll listener and scroll to bottom
      const chatContainer = chatContainerRef.current;
      if (chatContainer) {
        // Ensure we're at the bottom
        setTimeout(() => {
          scrollToBottom(true);
        }, 100);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPoppedOut]);

  // Handle browser back gesture for emoji picker and settings panels
  useEffect(() => {
    const hasNestedPanel = showEmojiPicker || showSettings;

    if (hasNestedPanel) {
      // Push history state so back gesture can be intercepted
      window.history.pushState({ nestedPanel: 'chatPanel' }, '');

      // Register close handler for App.tsx to call on back gesture
      (window as any).__closeNestedPanel = () => {
        if (showEmojiPicker) {
          setShowEmojiPicker(false);
        }
        if (showSettings) {
          setShowSettings(false);
        }
        (window as any).__closeNestedPanel = null;
      };

      return () => {
        (window as any).__closeNestedPanel = null;
      };
    }
  }, [showEmojiPicker, showSettings]);

  // Fetch custom emojis for parsing
  useEffect(() => {
    const fetchEmojis = async () => {
      try {
        const apiUrl = process.env.REACT_APP_API_URL || 'https://onestreamer.live';
        const response = await fetch(`${apiUrl}/api/emojis`);
        if (response.ok) {
          const emojis = await response.json();
          const emojiMap = new Map<string, string>();
          
          // Detect browser support for AVIF animation
          const supportsAnimatedAvif = CSS.supports('background-image', 'url("test.avif")');
          const isFirefox = navigator.userAgent.toLowerCase().includes('firefox');
          const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
          
          emojis.forEach((emoji: any) => {
            let preferredUrl = emoji.url;
            
            // If we have formats object, choose the best format
            if (emoji.formats) {
              // For browsers with poor AVIF animation support, prefer GIF for animated emojis
              if ((isFirefox || isSafari) && emoji.formats.gif) {
                preferredUrl = emoji.formats.gif;
              } else if (!supportsAnimatedAvif && emoji.formats.gif) {
                preferredUrl = emoji.formats.gif;
              } else if (emoji.formats.webp && !supportsAnimatedAvif) {
                preferredUrl = emoji.formats.webp;
              }
            }
            
            emojiMap.set(emoji.code, `${apiUrl}${preferredUrl}`);
          });
          setCustomEmojis(emojiMap);
        }
      } catch (error) {
        console.error('Error fetching custom emojis:', error);
      }
    };
    
    fetchEmojis();
  }, []);


  // Add click event listener for external links
  useEffect(() => {
    const handleLinkClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'A' && target.classList.contains('chat-link')) {
        e.preventDefault();
        const url = target.getAttribute('data-external-url') || target.getAttribute('href') || '';
        
        // Check if it's an external link
        try {
          const urlObj = new URL(url);
          const isExternal = !['onestreamer.com', 'www.onestreamer.com', 'onestreamer.live', 'www.onestreamer.live'].includes(urlObj.hostname);
          
          if (isExternal) {
            setExternalLinkModal({ isOpen: true, url });
          } else {
            // Internal link, open directly
            window.open(url, '_blank', 'noopener,noreferrer');
          }
        } catch {
          // Invalid URL, don't open
          console.error('Invalid URL:', url);
        }
      }
    };

    const chatContainer = chatContainerRef.current;
    if (chatContainer) {
      chatContainer.addEventListener('click', handleLinkClick);
      return () => chatContainer.removeEventListener('click', handleLinkClick);
    }
  }, []);
  
  // Check if user has been verified for this session
  useEffect(() => {
    const verified = sessionStorage.getItem('chatTurnstileVerified');
    if (verified === 'true') {
      setTurnstileToken('verified');
    }
  }, []);

  // Handle sending messages. Returns true if the message was consumed and the
  // input should clear; false if we deferred (e.g. waiting on Turnstile).
  const handleSend = (message: string): boolean => {
    if (!isConnected) {
      return false;
    }

    // Check if we need Turnstile verification
    if (!turnstileToken) {
      setIsVerifying(true);
      return false;
    }

    // Add to message history (avoid duplicates of the same message in a row)
    pushHistory(message);

    // Reset history index when sending a new message
    resetHistoryIndex();

    // console.log('💬 CLIENT: Sending message:', message);
    const emitted = emitChatMessage(message);
    if (!emitted) return false;

    // Force scroll to bottom after sending a message
    // Reset scroll state and enable auto-scroll
    resetScrollState();

    // Immediate scroll to bottom
    const chatContainer = chatContainerRef.current;
    if (chatContainer) {
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    return true;
  };

  // Handle emoji selection from picker
  const handleEmojiSelect = (emojiCode: string) => {
    chatInputRef.current?.insertAtCursor(emojiCode);
    setShowEmojiPicker(false);
  };

  // Handle settings changes
  const handleSettingsChange = (newSettings: ChatUserSettings) => {
    setChatSettings(newSettings);
    CookieService.setCookie(COOKIE_NAMES.CHAT_SETTINGS, newSettings);
  };

  // Handle popout button click
  const handlePopoutClick = () => {
    const popoutWindow = openPopoutChat();
    if (popoutWindow) {
      popoutWindowRef.current = popoutWindow;
      setIsPoppedOut(true);
    }
  };

  // Handle returning chat to main window
  const handleReturnToMain = () => {
    if (popoutWindowRef.current && !popoutWindowRef.current.closed) {
      popoutWindowRef.current.close();
    }
    sessionStorage.removeItem('chatPoppedOut');
    setIsPoppedOut(false);

    // Reset scroll state when returning to main
    resetScrollState();

    // Force scroll to bottom after a brief delay to ensure DOM is ready
    setTimeout(() => {
      scrollToBottom(true);
    }, 100);
  };

  // Handle color change from settings
  const handleColorChange = (color: string) => {
    if (userInfo && chatSocket) {
      // Send color update to server
      chatSocket.emit('update-user-color', { color });
      const updatedUserInfo = { ...userInfo, color };
      setUserInfo(updatedUserInfo);
      // Save to session storage
      sessionStorage.setItem('chatUserInfo', JSON.stringify(updatedUserInfo));
    }
  };

  // Handle username click to show user info popup
  const handleUsernameClick = (username: string, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    
    // Remove any emoji prefix (like 🤖) from the username
    const cleanUsername = username.replace(/^🤖\s*/, '');
    
    // Get click position
    const rect = (event.target as HTMLElement).getBoundingClientRect();
    setUserInfoPopup({
      username: cleanUsername,
      position: {
        x: rect.left,
        y: rect.bottom + 5 // Position below the username
      }
    });
  };

  // If chat is popped out, show indicator instead
  if (isPoppedOut && !window.location.search.includes('popout=true')) {
    return (
      <div className={`chat-container ${className}`}>
        <div className="chat-popped-out-indicator">
          <h3>Chat Opened in New Window</h3>
          <p>Your chat is open in a separate window.</p>
          <p>You can continue chatting there or return it here.</p>
          <button onClick={handleReturnToMain}>
            Return Chat to Main Window
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`chat-container ${className}`}>
      {/* Chat Header */}
      <div className="chat-header">
        <h3>Live Chat</h3>
        <div className="chat-status">
          {!window.location.search.includes('popout=true') && (
            <button 
              className="chat-popout-button"
              onClick={handlePopoutClick}
              title="Open chat in new window"
            >
              <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M14,3V5H17.59L7.76,14.83L9.17,16.24L19,6.41V10H21V3M19,19H5V5H12V3H5C3.89,3 3,3.9 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V12H19V19Z" />
              </svg>
              Pop Out
            </button>
          )}
          <div className={`connection-indicator ${connectionStatus}`}></div>
        </div>
      </div>
      
      {/* Chat Messages */}
      <MessageList
        messages={messages}
        userInfo={userInfo}
        chatSettings={chatSettings}
        customEmojis={customEmojis}
        connectionStatus={connectionStatus}
        isScrolledUp={isScrolledUp}
        newMessagesCount={newMessagesCount}
        onJumpToBottom={jumpToBottom}
        onUsernameClick={handleUsernameClick}
        containerRef={chatContainerRef}
        endRef={messagesEndRef}
      />
      
      {/* Chat Input */}
      <div className="chat-input-container">
        <ChatControls
          userInfo={userInfo}
          hasAuthToken={!!authService.getToken()}
          chatSettings={chatSettings}
          showSettings={showSettings}
          onToggleSettings={() => setShowSettings(!showSettings)}
          onCloseSettings={() => setShowSettings(false)}
          showEmojiPicker={showEmojiPicker}
          onToggleEmojiPicker={() => setShowEmojiPicker(!showEmojiPicker)}
          onCloseEmojiPicker={() => setShowEmojiPicker(false)}
          onEmojiSelect={handleEmojiSelect}
          bonusIconActive={bonusIconActive}
          bonusIconCooldown={bonusIconCooldown}
          onBonusClick={handleBonusClick}
          onColorChange={handleColorChange}
          onSettingsChange={handleSettingsChange}
        />

        <ChatInput
          ref={chatInputRef}
          onSend={handleSend}
          historyPrev={historyPrev}
          historyNext={historyNext}
          resetHistoryIndex={resetHistoryIndex}
          disabled={!isConnected}
        />
      </div>

      {/* Invisible Turnstile verification modal */}
      {isVerifying && (
        <div className="turnstile-verification-modal">
          <div className="turnstile-modal-content">
            <p>Verifying you're human...</p>
            <CloudflareTurnstile
              siteKey={TURNSTILE_SITE_KEY}
              onVerify={(token) => {
                setTurnstileToken(token);
                sessionStorage.setItem('chatTurnstileVerified', 'true');
                setIsVerifying(false);
                // Retry sending the message after verification
                setTimeout(() => {
                  chatInputRef.current?.submit();
                }, 100);
              }}
              onError={() => {
                setIsVerifying(false);
                console.error('Turnstile verification failed');
              }}
              onExpire={() => {
                setTurnstileToken(null);
                sessionStorage.removeItem('chatTurnstileVerified');
              }}
              theme="auto"
              size="compact"
              appearance="interaction-only"
            />
          </div>
        </div>
      )}

      {/* External Link Warning Modal */}
      <ExternalLinkModal
        isOpen={externalLinkModal.isOpen}
        url={externalLinkModal.url}
        onConfirm={() => {
          window.open(externalLinkModal.url, '_blank', 'noopener,noreferrer');
          setExternalLinkModal({ isOpen: false, url: '' });
        }}
        onCancel={() => {
          setExternalLinkModal({ isOpen: false, url: '' });
        }}
      />

      {/* User Info Popup */}
      {userInfoPopup && (
        <UserInfoPopup
          username={userInfoPopup.username}
          position={userInfoPopup.position}
          onClose={() => setUserInfoPopup(null)}
        />
      )}
    </div>
  );
};

export default Chat;