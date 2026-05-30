import { useEffect, useRef, useState } from 'react';
import { ChatMessage } from './types';

export interface UseChatScrollResult {
  /** Ref to attach to the `.chat-messages` scroll container. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Whether the user has scrolled away from the bottom. */
  isScrolledUp: boolean;
  /** Count of messages that arrived while scrolled up. */
  newMessagesCount: number;
  /** Scroll to the bottom of the list (smooth by default). */
  scrollToBottom: (smooth?: boolean) => void;
  /** Reset scroll state + scroll to bottom (the "N new messages" button). */
  jumpToBottom: () => void;
  /** Imperatively reset scroll bookkeeping to the at-bottom state. */
  resetScrollState: () => void;
}

/**
 * Owns the chat scroll experience: auto-scroll, the MutationObserver that
 * detects new message nodes, the ResizeObserver that re-anchors on layout
 * changes (mobile keyboard), the scroll listener that tracks scrolled-up
 * state, and the "N new messages" counter.
 *
 * Extracted verbatim from Chat.tsx. The container ref is returned so the
 * parent can forward it to `MessageList`, and the observers/listeners attach
 * to it exactly as before. Behavior (debounce thresholds, touch handling,
 * easing) is unchanged.
 */
export function useChatScroll(
  messages: ChatMessage[],
  isPoppedOut: boolean,
): UseChatScrollResult {
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const [newMessagesCount, setNewMessagesCount] = useState(0);

  const chatContainerRef = useRef<HTMLDivElement>(null);
  const mutationObserverRef = useRef<MutationObserver | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const scrollDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const autoScrollEnabledRef = useRef(true);
  const programmaticScrollRef = useRef(false);

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

  // Imperatively reset scroll bookkeeping (used on send / popout return).
  const resetScrollState = () => {
    setIsScrolledUp(false);
    setNewMessagesCount(0);
    autoScrollEnabledRef.current = true;
  };

  // Jump to bottom and reset scroll state
  const jumpToBottom = () => {
    setIsScrolledUp(false);
    setNewMessagesCount(0);
    autoScrollEnabledRef.current = true;
    scrollToBottom(true);
  };

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run once on mount

  // Add scroll event listener to detect when user scrolls up
  useEffect(() => {
    const chatContainer = chatContainerRef.current;
    if (chatContainer && !isPoppedOut) {
      // Only attach scroll listener when not popped out
      chatContainer.addEventListener('scroll', handleScroll);
      return () => chatContainer.removeEventListener('scroll', handleScroll);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPoppedOut]); // Re-attach when isPoppedOut changes

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

  return {
    containerRef: chatContainerRef,
    isScrolledUp,
    newMessagesCount,
    scrollToBottom,
    jumpToBottom,
    resetScrollState,
  };
}

export default useChatScroll;
