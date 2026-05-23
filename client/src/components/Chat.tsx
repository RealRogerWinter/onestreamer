import React, { useState, useEffect, useRef, useCallback } from 'react';
import authService from '../services/AuthService';
import CookieService, { COOKIE_NAMES } from '../services/CookieService';
import EmojiPicker from './EmojiPicker';
import ChatSettings, { ChatUserSettings } from './ChatSettings';
import DOMPurify from 'dompurify';
import CloudflareTurnstile from './CloudflareTurnstile';
import { TURNSTILE_SITE_KEY } from '../config/turnstile';
import ExternalLinkModal from './ExternalLinkModal';
import UserInfoPopup from './user/UserInfoPopup';
import { openPopoutChat } from './PopoutChat';
import { useChatMessages, ChatMessage } from '../hooks/useChatMessages';
import { useChatSocket, UserInfo } from '../hooks/useChatSocket';
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
    messageHistory,
    historyIndex,
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
  const [currentMessage, setCurrentMessage] = useState('');
  const [userCount, setUserCount] = useState(() => {
    // Restore user count from session storage
    const stored = sessionStorage.getItem('chatUserCount');
    return stored ? parseInt(stored, 10) : 0;
  });
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const [newMessagesCount, setNewMessagesCount] = useState(0);
  const [bonusIconActive, setBonusIconActive] = useState(false);
  const [bonusIconCooldown, setBonusIconCooldown] = useState(false);
  const [nextBonusTime, setNextBonusTime] = useState<number>(0);
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
  const inputRef = useRef<HTMLInputElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const bonusTimerRef = useRef<NodeJS.Timeout | null>(null);
  const mutationObserverRef = useRef<MutationObserver | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const scrollDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const autoScrollEnabledRef = useRef(true);
  const programmaticScrollRef = useRef(false);

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
        setIsScrolledUp(false);
        setNewMessagesCount(0);
        autoScrollEnabledRef.current = true;
      }
    }, 50);
  }, [replaceMessages]);

  const handleSocketUserCountChange = useCallback((count: number) => {
    setUserCount(count);
    sessionStorage.setItem('chatUserCount', count.toString());
  }, []);

  const handleSocketBanned = useCallback((data: { reason: string }) => {
    alert(`You have been banned from chat: ${data.reason}`);
    setCurrentMessage('');
  }, []);

  const handleSocketTimeout = useCallback((data: { reason: string; endTime: number }) => {
    const remainingTime = Math.ceil((data.endTime - Date.now()) / 1000);
    alert(`You have been timed out for ${remainingTime} seconds: ${data.reason}`);
    setCurrentMessage('');
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

  // Improved scroll to bottom with direct scrollTop manipulation
  const scrollToBottom = (smooth: boolean = true) => {
    const chatContainer = chatContainerRef.current;
    if (!chatContainer) return;
    
    // Set flag to indicate programmatic scroll
    programmaticScrollRef.current = true;
    
    if (smooth) {
      // Smooth scroll implementation
      const start = chatContainer.scrollTop;
      const end = chatContainer.scrollHeight - chatContainer.clientHeight;
      const distance = end - start;
      const duration = 300; // ms
      let startTime: number | null = null;
      
      const animateScroll = (currentTime: number) => {
        if (!startTime) startTime = currentTime;
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        
        // Easing function for smooth animation
        const easeInOutCubic = (t: number) => {
          return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        };
        
        chatContainer.scrollTop = start + (distance * easeInOutCubic(progress));
        
        if (progress < 1) {
          requestAnimationFrame(animateScroll);
        } else {
          programmaticScrollRef.current = false;
        }
      };
      
      requestAnimationFrame(animateScroll);
    } else {
      // Instant scroll - more reliable for auto-scroll
      chatContainer.scrollTop = chatContainer.scrollHeight;
      // Reset flag after a small delay
      setTimeout(() => {
        programmaticScrollRef.current = false;
      }, 50);
    }
  };

  // More accurate check if user is scrolled near the bottom
  const isScrolledToBottom = () => {
    const chatContainer = chatContainerRef.current;
    if (!chatContainer) return true;
    
    const { scrollTop, scrollHeight, clientHeight } = chatContainer;
    // Dynamic threshold based on viewport height
    const threshold = Math.min(clientHeight * 0.1, 100); // 10% of viewport or 100px max
    const distanceFromBottom = scrollHeight - (scrollTop + clientHeight);
    
    return distanceFromBottom <= threshold;
  };

  // Debounced scroll handler with improved logic
  const handleScroll = () => {
    // Ignore programmatic scrolls
    if (programmaticScrollRef.current) return;
    
    const chatContainer = chatContainerRef.current;
    if (!chatContainer) return;
    
    // Get current scroll metrics immediately
    const { scrollTop, scrollHeight, clientHeight } = chatContainer;
    const distanceFromBottom = scrollHeight - (scrollTop + clientHeight);
    
    // Clear existing debounce timer
    if (scrollDebounceRef.current) {
      clearTimeout(scrollDebounceRef.current);
    }
    
    // For touch devices, be more lenient with "at bottom" detection
    const isTouchDevice = 'ontouchstart' in window;
    const threshold = isTouchDevice 
      ? Math.min(clientHeight * 0.15, 150) // 15% or 150px for touch
      : Math.min(clientHeight * 0.1, 100); // 10% or 100px for desktop
    
    // Debounce scroll detection
    scrollDebounceRef.current = setTimeout(() => {
      const isAtBottom = distanceFromBottom <= threshold;
      
      if (isAtBottom) {
        setIsScrolledUp(false);
        setNewMessagesCount(0);
        autoScrollEnabledRef.current = true;
      } else {
        // Only mark as scrolled up if user scrolled significantly
        if (distanceFromBottom > threshold * 2) {
          setIsScrolledUp(true);
          autoScrollEnabledRef.current = false;
        }
      }
    }, 100); // 100ms debounce
  };

  // Jump to bottom and reset scroll state
  const jumpToBottom = () => {
    setIsScrolledUp(false);
    setNewMessagesCount(0);
    autoScrollEnabledRef.current = true;
    scrollToBottom(true);
  };

  // Check if bonus is available from server
  const checkBonusAvailability = async () => {
    const token = authService.getToken();
    const user = authService.getUser();
    
    if (!token || !user) return;
    
    try {
      const apiUrl = process.env.REACT_APP_API_URL || 'http://localhost:8080';
      const response = await fetch(`${apiUrl}/api/internal/bonus-status/${user.id}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (response.ok) {
        const data = await response.json();
        if (data.available) {
          // console.log('🎁 Bonus is available!');
          setBonusIconActive(true);
          setBonusIconCooldown(false);
        } else {
          // console.log(`⏰ Bonus on cooldown for ${data.remainingSeconds}s`);
          setBonusIconActive(false);
          setBonusIconCooldown(true);
          
          // Set timer to check again when cooldown expires
          if (bonusTimerRef.current) {
            clearTimeout(bonusTimerRef.current);
          }
          bonusTimerRef.current = setTimeout(() => {
            checkBonusAvailability();
          }, data.remainingSeconds * 1000);
        }
      }
    } catch (error) {
      console.error('Error checking bonus availability:', error);
    }
  };

  // Setup bonus timer based on server response
  const setupBonusTimer = (delay?: number) => {
    // Clear existing timer
    if (bonusTimerRef.current) {
      clearTimeout(bonusTimerRef.current);
    }

    // Use provided delay or random 2-6 minutes
    const randomDelay = delay || (Math.floor(Math.random() * 240000) + 120000);
    const nextTime = Date.now() + randomDelay;
    setNextBonusTime(nextTime);

    // console.log(`⏰ Bonus timer set for ${randomDelay}ms (${randomDelay/1000} seconds)`);

    bonusTimerRef.current = setTimeout(() => {
      // console.log('🎁 Checking bonus availability...');
      checkBonusAvailability();
    }, randomDelay);
  };

  // Handle bonus icon click
  const handleBonusClick = async () => {
    // console.log('🎁 Bonus icon clicked', {
    //   bonusIconActive,
    //   bonusIconCooldown,
    //   userInfo: userInfo ? 'exists' : 'null',
    //   isAuthenticated: !!authService.getToken()
    // });

    if (!bonusIconActive || bonusIconCooldown) {
      // console.log('❌ Bonus icon not active or in cooldown');
      return;
    }

    // Immediately disable the icon
    setBonusIconActive(false);
    setBonusIconCooldown(true);

    try {
      // Get auth token
      const token = authService.getToken();
      const user = authService.getUser();
      
      // console.log('🔑 Auth check:', {
      //   hasToken: !!token,
      //   hasUser: !!user,
      //   userId: user?.id
      // });

      if (!token || !user) {
        console.error('No auth token or user available for bonus claim');
        setBonusIconActive(true);
        setBonusIconCooldown(false);
        return;
      }

      // Make API call to claim bonus
      // console.log('📡 Claiming bonus for user:', user.id);
      const apiUrl = process.env.REACT_APP_API_URL || 'http://localhost:8080';
      const response = await fetch(`${apiUrl}/api/internal/claim-chat-bonus`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          userId: user.id
        })
      });

      // console.log('📡 Response status:', response.status);

      if (response.ok) {
        const data = await response.json();
        // console.log('✅ Bonus claimed successfully:', data);
        
        // Show floating points animation
        if (window.showFloatingPoints) {
          // console.log('🎆 Showing floating points animation');
          window.showFloatingPoints(100, 'chat_bonus');
        } else {
          // console.log('❌ window.showFloatingPoints not available');
        }

        // Setup next timer with server-provided delay
        if (data.nextBonusDelay) {
          setupBonusTimer(data.nextBonusDelay);
        } else {
          setupBonusTimer();
        }
      } else if (response.status === 429) {
        // Too many requests - bonus still on cooldown
        const errorData = await response.json();
        // console.log(`⏰ Bonus still on cooldown: ${errorData.remainingSeconds}s remaining`);
        
        // Keep icon disabled and set timer for remaining cooldown
        setBonusIconActive(false);
        setBonusIconCooldown(true);
        
        if (errorData.remainingSeconds) {
          if (bonusTimerRef.current) {
            clearTimeout(bonusTimerRef.current);
          }
          bonusTimerRef.current = setTimeout(() => {
            checkBonusAvailability();
          }, errorData.remainingSeconds * 1000);
        }
      } else {
        const errorData = await response.text();
        console.error('Failed to claim bonus:', response.status, errorData);
        // Re-enable on error
        setBonusIconActive(true);
        setBonusIconCooldown(false);
      }
    } catch (error) {
      console.error('Error claiming bonus:', error);
      // Re-enable on error
      setBonusIconActive(true);
      setBonusIconCooldown(false);
    }
  };

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
      setIsScrolledUp(false);
      setNewMessagesCount(0);
      autoScrollEnabledRef.current = true;
      
      // Re-attach scroll listener and scroll to bottom
      const chatContainer = chatContainerRef.current;
      if (chatContainer) {
        // Ensure we're at the bottom
        setTimeout(() => {
          scrollToBottom(true);
        }, 100);
      }
    }
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

  // Start bonus timer when user is authenticated
  useEffect(() => {
    // console.log('🔄 Bonus timer useEffect triggered', {
    //   hasUserInfo: !!userInfo,
    //   hasToken: !!authService.getToken(),
    //   username: userInfo?.username
    // });
    
    if (userInfo && authService.getToken()) {
      // console.log('✅ Checking bonus availability for authenticated user');
      // Check current bonus status from server first
      checkBonusAvailability();
    } else {
      // console.log('❌ Not starting bonus timer - missing userInfo or token');
    }

    // Cleanup timer on unmount
    return () => {
      if (bonusTimerRef.current) {
        clearTimeout(bonusTimerRef.current);
      }
    };
  }, [userInfo]);

  // Setup MutationObserver for reliable message detection and auto-scroll
  useEffect(() => {
    const chatContainer = chatContainerRef.current;
    if (!chatContainer) return;
    
    // Cleanup existing observer
    if (mutationObserverRef.current) {
      mutationObserverRef.current.disconnect();
    }
    
    // Create MutationObserver to watch for new messages
    let scrollTimeout: NodeJS.Timeout | null = null;
    const observer = new MutationObserver((mutations) => {
      // Check if there are actual child additions (not just attribute changes)
      const hasNewMessages = mutations.some(mutation => 
        mutation.type === 'childList' && mutation.addedNodes.length > 0
      );
      
      if (!hasNewMessages) return;
      
      // Clear any pending scroll operation
      if (scrollTimeout) {
        clearTimeout(scrollTimeout);
      }
      
      // Perform auto-scroll logic
      if (autoScrollEnabledRef.current && !isScrolledUp) {
        // Batch multiple rapid messages into single scroll
        scrollTimeout = setTimeout(() => {
          const container = chatContainerRef.current;
          if (container) {
            // Direct manipulation for maximum reliability
            container.scrollTop = container.scrollHeight;
          }
        }, 50); // Small delay to batch rapid messages
      } else if (isScrolledUp) {
        // User is scrolled up, increment new messages count
        // Count actual message nodes added
        const newMessageCount = mutations.reduce((count, mutation) => {
          return count + Array.from(mutation.addedNodes).filter(
            node => node.nodeType === Node.ELEMENT_NODE
          ).length;
        }, 0);
        setNewMessagesCount(prev => prev + newMessageCount);
      }
    });
    
    // Start observing
    observer.observe(chatContainer, {
      childList: true,
      subtree: false, // Only watch direct children
      attributes: false,
      characterData: false
    });
    
    mutationObserverRef.current = observer;
    
    // Cleanup on unmount
    return () => {
      if (mutationObserverRef.current) {
        mutationObserverRef.current.disconnect();
      }
      if (scrollDebounceRef.current) {
        clearTimeout(scrollDebounceRef.current);
      }
    };
  }, [isScrolledUp, isPoppedOut]); // Re-create observer when isScrolledUp or isPoppedOut changes
  
  // Initial scroll to bottom when messages first load
  useEffect(() => {
    if (messages.length > 0) {
      // Use a small timeout to ensure DOM is ready
      const timer = setTimeout(() => {
        scrollToBottom(false);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, []); // Only run once on mount

  // Add scroll event listener to detect when user scrolls up
  useEffect(() => {
    const chatContainer = chatContainerRef.current;
    if (chatContainer && !isPoppedOut) {
      // Only attach scroll listener when not popped out
      chatContainer.addEventListener('scroll', handleScroll);
      return () => chatContainer.removeEventListener('scroll', handleScroll);
    }
  }, [isPoppedOut]); // Re-attach when isPoppedOut changes

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
  
  // Setup ResizeObserver to handle container size changes (e.g., keyboard on mobile)
  useEffect(() => {
    const chatContainer = chatContainerRef.current;
    if (!chatContainer) return;
    
    // Cleanup existing observer
    if (resizeObserverRef.current) {
      resizeObserverRef.current.disconnect();
    }
    
    // Create ResizeObserver to watch for size changes
    const resizeObserver = new ResizeObserver((entries) => {
      // When container resizes and user is at bottom, maintain scroll position
      if (autoScrollEnabledRef.current && !isScrolledUp) {
        requestAnimationFrame(() => {
          const container = entries[0].target as HTMLElement;
          container.scrollTop = container.scrollHeight;
        });
      }
    });
    
    // Start observing
    resizeObserver.observe(chatContainer);
    resizeObserverRef.current = resizeObserver;
    
    // Cleanup on unmount
    return () => {
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
      }
    };
  }, [isScrolledUp]);

  // Check if user has been verified for this session
  useEffect(() => {
    const verified = sessionStorage.getItem('chatTurnstileVerified');
    if (verified === 'true') {
      setTurnstileToken('verified');
    }
  }, []);

  // Handle sending messages
  const sendMessage = (e: React.FormEvent) => {
    e.preventDefault();

    if (!currentMessage.trim() || !isConnected) {
      return;
    }

    // Check if we need Turnstile verification
    if (!turnstileToken) {
      setIsVerifying(true);
      return;
    }

    const message = currentMessage.trim();

    // Add to message history (avoid duplicates of the same message in a row)
    pushHistory(message);

    // Reset history index when sending a new message
    resetHistoryIndex();

    // console.log('💬 CLIENT: Sending message:', message);
    const emitted = emitChatMessage(message);
    if (!emitted) return;
    setCurrentMessage('');
    
    // Force scroll to bottom after sending a message
    // Reset scroll state and enable auto-scroll
    setIsScrolledUp(false);
    setNewMessagesCount(0);
    autoScrollEnabledRef.current = true;
    
    // Immediate scroll to bottom
    const chatContainer = chatContainerRef.current;
    if (chatContainer) {
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }
  };

  // Handle keyboard navigation for message history
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Only handle arrow keys when input is empty or when navigating history
    if (e.key === 'ArrowUp') {
      // If we're at the beginning of input or input is empty, navigate history
      if (currentMessage === '' || historyIndex >= 0) {
        e.preventDefault();

        // Navigate to older messages
        const result = historyPrev();
        if (result) {
          setCurrentMessage(result.message);

          // Move cursor to end of input
          setTimeout(() => {
            if (inputRef.current) {
              inputRef.current.setSelectionRange(inputRef.current.value.length, inputRef.current.value.length);
            }
          }, 0);
        }
      }
    } else if (e.key === 'ArrowDown') {
      // Only navigate if we're in history mode
      if (historyIndex >= 0) {
        e.preventDefault();

        // Navigate to newer messages
        const result = historyNext();
        if (result) {
          setCurrentMessage(result.message);
        } else {
          // Reached the end, clear input
          setCurrentMessage('');
        }

        // Move cursor to end of input
        setTimeout(() => {
          if (inputRef.current) {
            inputRef.current.setSelectionRange(inputRef.current.value.length, inputRef.current.value.length);
          }
        }, 0);
      }
    } else {
      // Any other key press resets history navigation if we're typing new content
      if (historyIndex >= 0 && e.key !== 'Enter') {
        resetHistoryIndex();
      }
    }
  };

  // Handle input key press
  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(e as any);
    }
  };

  // Format message text (safely handle HTML, emojis, URLs, and mentions)
  const formatMessage = (text: string, isMentioned: boolean = false) => {
    // STEP 1: First, escape ALL HTML to prevent XSS attacks
    // This converts <script> to &lt;script&gt;, etc.
    const escapeHtml = (unsafe: string): string => {
      return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    };
    
    let safeText = escapeHtml(text);
    
    // STEP 1.5: Process @ mentions - highlight them
    const mentionRegex = /@([a-zA-Z0-9_-]+)/g;
    safeText = safeText.replace(mentionRegex, (match, username) => {
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
      return part.replace(urlRegex, (match, url) => {
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
      ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?):\/\/)/
    };
    
    const cleanHtml = DOMPurify.sanitize(safeText, config);
    
    return cleanHtml;
  };

  // Handle emoji selection from picker
  const handleEmojiSelect = (emojiCode: string) => {
    const cursorPosition = inputRef.current?.selectionStart || currentMessage.length;
    const newMessage = 
      currentMessage.slice(0, cursorPosition) + 
      emojiCode + 
      currentMessage.slice(cursorPosition);
    
    setCurrentMessage(newMessage);
    setShowEmojiPicker(false);
    
    // Focus back on input and set cursor position after emoji
    setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.focus();
        const newPosition = cursorPosition + emojiCode.length;
        inputRef.current.setSelectionRange(newPosition, newPosition);
      }
    }, 0);
  };

  // Check if the current user is mentioned in a message
  const isUserMentioned = (message: ChatMessage): boolean => {
    if (!userInfo || !message.mentions || message.mentions.length === 0) {
      return false;
    }
    
    // Check if current user's username (without emoji prefix) is in mentions
    const currentUsername = userInfo.username.replace(/^🤖\s*/, '').toLowerCase();
    return message.mentions.some(mention => mention.toLowerCase() === currentUsername);
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
    setIsScrolledUp(false);
    setNewMessagesCount(0);
    autoScrollEnabledRef.current = true;
    
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

  // Format timestamp based on settings
  const formatTimestamp = (timestamp: string, fullTimestamp: string): string => {
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
      <div className="chat-messages" ref={chatContainerRef}>
        {messages.length === 0 && connectionStatus === 'connected' && (
          <div className="chat-empty">
            <p>No messages yet. Start the conversation!</p>
          </div>
        )}
        
        {messages.map((msg) => {
          const isMentioned = isUserMentioned(msg);
          return (
            <div key={msg.id} className={`chat-message ${msg.isAnnouncement ? 'announcement' : ''} ${isMentioned ? 'mentioned' : ''}`}>
              {chatSettings.showTimestamps && (
                <span className="message-timestamp">
                  {formatTimestamp(msg.timestamp, msg.fullTimestamp)}
                </span>
              )}
              <span 
                className="message-username clickable-username" 
                style={{ 
                  color: msg.userId === userInfo?.userId && chatSettings.userColor ? chatSettings.userColor : msg.color,
                  cursor: 'pointer'
                }}
                onClick={(e) => handleUsernameClick(msg.username, e)}
                title="Click to view profile"
              >
                {msg.isAdmin && <span className="user-badge admin-badge" title="Admin">👑</span>}
                {!msg.isAdmin && msg.isModerator && <span className="user-badge moderator-badge" title="Moderator">🛡️</span>}
                {msg.username}:
              </span>
              <span 
                className="message-text"
                dangerouslySetInnerHTML={{ __html: formatMessage(msg.message, isMentioned) }}
              />
            </div>
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
        
        <div ref={messagesEndRef} />
      </div>
      
      {/* New Messages Overlay */}
      {isScrolledUp && newMessagesCount > 0 && (
        <div className="new-messages-overlay">
          <button 
            className="new-messages-button"
            onClick={jumpToBottom}
          >
            {newMessagesCount} new message{newMessagesCount !== 1 ? 's' : ''} ↓
          </button>
        </div>
      )}
      
      {/* Chat Input */}
      <div className="chat-input-container">
        {userInfo && (
          <div className="user-info">
            <span className="current-username" style={{ color: chatSettings.userColor || userInfo.color }}>
              {userInfo.username}
            </span>
            <button 
              className={`chat-settings-button ${showSettings ? 'active' : ''}`}
              onClick={() => setShowSettings(!showSettings)}
              title="Chat settings"
            >
              ⚙️
            </button>
          </div>
        )}
        
        <button
          className={`emoji-picker-button ${showEmojiPicker ? 'active' : ''}`}
          onClick={() => setShowEmojiPicker(!showEmojiPicker)}
          title="Custom emojis"
        >
          😊
        </button>
        
        {authService.getToken() && (
          <button
            className={`bonus-icon ${bonusIconActive ? 'active' : ''} ${bonusIconCooldown ? 'cooldown' : ''}`}
            onClick={handleBonusClick}
            disabled={!bonusIconActive || bonusIconCooldown}
            title={bonusIconActive ? 'Click for 100 bonus points!' : 'Bonus points coming soon...'}
          >
            <span className="bonus-icon-symbol">🎁</span>
            {bonusIconActive && <span className="bonus-icon-glow"></span>}
          </button>
        )}
        
        {showEmojiPicker && (
          <EmojiPicker 
            onEmojiSelect={handleEmojiSelect}
            onClose={() => setShowEmojiPicker(false)}
          />
        )}
        
        {showSettings && (
          <ChatSettings
            isOpen={showSettings}
            onClose={() => setShowSettings(false)}
            currentColor={chatSettings.userColor || userInfo?.color || '#4ECDC4'}
            onColorChange={handleColorChange}
            onSettingsChange={handleSettingsChange}
            currentSettings={chatSettings}
            username={userInfo?.username || 'User'}
          />
        )}
        
        <form onSubmit={sendMessage} className="chat-input-form">
          <input
            ref={inputRef}
            type="text"
            value={currentMessage}
            onChange={(e) => setCurrentMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            onKeyPress={handleKeyPress}
            placeholder={isConnected ? "Type a message..." : "Connecting..."}
            disabled={!isConnected}
            maxLength={2000}
            className="chat-input"
          />
          <button
            type="submit"
            disabled={!isConnected || !currentMessage.trim()}
            className="chat-send-button"
          >
            Send
          </button>
        </form>
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
                  const form = document.querySelector('.chat-input-form') as HTMLFormElement;
                  if (form) {
                    form.requestSubmit();
                  }
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