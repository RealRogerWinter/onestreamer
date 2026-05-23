import { useState, useEffect, useCallback } from 'react';

export interface ChatMessage {
  id: string;
  username: string;
  color: string;
  message: string;
  timestamp: string;
  fullTimestamp: string;
  userId: string;
  isAnnouncement?: boolean;
  isAdmin?: boolean;
  isModerator?: boolean;
  mentions?: string[];
}

export interface UseChatMessagesResult {
  // Message list state
  messages: ChatMessage[];
  /** Replace the entire message list (used when receiving chat-history from server). */
  replaceMessages: (next: ChatMessage[]) => void;
  /** Append a single new message. */
  addMessage: (message: ChatMessage) => void;
  /** Clear every message. */
  clearMessages: () => void;
  /** Remove messages by id (used when admin/mod deletes). */
  removeMessages: (ids: string[]) => void;

  // Input-history navigation state
  messageHistory: string[];
  historyIndex: number;
  /** Push a sent message onto the recent input history (dedup consecutive duplicates). */
  pushHistory: (message: string) => void;
  /** Reset history navigation cursor to "not browsing". */
  resetHistoryIndex: () => void;
  /** Step backwards in history (ArrowUp). Returns the message at the new index, or null if no change. */
  historyPrev: () => { index: number; message: string } | null;
  /** Step forwards in history (ArrowDown). Returns the message at the new index, or null to clear input. */
  historyNext: () => { index: number; message: string } | null;
}

const STORAGE_KEY = 'chatMessages';
const MAX_INPUT_HISTORY = 50;

function loadInitialMessages(): ChatMessage[] {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

/**
 * Hook that owns the chat message list and the input-history navigation state.
 *
 * Persistence: messages are mirrored to sessionStorage under `chatMessages` so
 * the chat survives client-side route changes / popout. The hook performs the
 * persistence via a useEffect — callers should not write the key directly.
 *
 * The socket subscription logic stays in the component; it drives this hook
 * via the returned setters (replaceMessages / addMessage / clearMessages /
 * removeMessages). Behavior — including dedup and ordering — matches the
 * inline implementation that previously lived in Chat.tsx.
 */
export function useChatMessages(): UseChatMessagesResult {
  const [messages, setMessages] = useState<ChatMessage[]>(loadInitialMessages);
  const [messageHistory, setMessageHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  // Persist messages to sessionStorage whenever they change.
  useEffect(() => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
  }, [messages]);

  const replaceMessages = useCallback((next: ChatMessage[]) => {
    setMessages(next);
  }, []);

  const addMessage = useCallback((message: ChatMessage) => {
    setMessages(prev => [...prev, message]);
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  const removeMessages = useCallback((ids: string[]) => {
    if (!ids || ids.length === 0) return;
    const idSet = new Set(ids);
    setMessages(prev => prev.filter(msg => !idSet.has(msg.id)));
  }, []);

  const pushHistory = useCallback((message: string) => {
    setMessageHistory(prev => {
      const newHistory = prev[0] === message ? prev : [message, ...prev];
      return newHistory.slice(0, MAX_INPUT_HISTORY);
    });
  }, []);

  const resetHistoryIndex = useCallback(() => {
    setHistoryIndex(-1);
  }, []);

  const historyPrev = useCallback((): { index: number; message: string } | null => {
    const newIndex = Math.min(historyIndex + 1, messageHistory.length - 1);
    if (newIndex >= 0 && newIndex < messageHistory.length) {
      setHistoryIndex(newIndex);
      return { index: newIndex, message: messageHistory[newIndex] };
    }
    return null;
  }, [historyIndex, messageHistory]);

  const historyNext = useCallback((): { index: number; message: string } | null => {
    if (historyIndex < 0) return null;
    const newIndex = historyIndex - 1;
    if (newIndex >= 0) {
      setHistoryIndex(newIndex);
      return { index: newIndex, message: messageHistory[newIndex] };
    }
    // Reached the end — clear input
    setHistoryIndex(-1);
    return null;
  }, [historyIndex, messageHistory]);

  return {
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
  };
}

export default useChatMessages;
