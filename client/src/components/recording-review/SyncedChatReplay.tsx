import React, { useState, useEffect, useRef, useCallback } from 'react';

interface ChatMessage {
  id: number;
  sessionId: string;
  username: string;
  message: string;
  color: string | null;
  timestamp: number;
  relativeMs: number;
  isSystem: boolean;
}

interface SyncedChatReplayProps {
  currentTimeMs: number;
  recordingStartTime: number;
  isPlaying: boolean;
  makeApiCall: (endpoint: string, options?: RequestInit) => Promise<any>;
  formatDuration: (ms: number) => string;
}

const SyncedChatReplay: React.FC<SyncedChatReplayProps> = ({
  currentTimeMs,
  recordingStartTime,
  isPlaying,
  makeApiCall,
  formatDuration
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [visibleMessages, setVisibleMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const lastFetchedRangeRef = useRef<{ from: number; to: number } | null>(null);

  // Calculate absolute timestamp
  const currentAbsoluteTime = recordingStartTime + currentTimeMs;

  // Fetch chat messages for a time range
  const fetchMessages = useCallback(async (fromMs: number, toMs: number) => {
    try {
      setLoading(true);
      const response = await makeApiCall(
        `/admin/review/chat-stream?fromMs=${fromMs}&toMs=${toMs}&limit=500`
      );

      if (response.success) {
        setMessages(prev => {
          // Merge new messages, avoiding duplicates
          const existingIds = new Set(prev.map(m => m.id));
          const newMessages = response.messages.filter(
            (m: ChatMessage) => !existingIds.has(m.id)
          );
          return [...prev, ...newMessages].sort((a, b) => a.timestamp - b.timestamp);
        });
        lastFetchedRangeRef.current = { from: fromMs, to: toMs };
        setError(null);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [makeApiCall]);

  // Initial fetch - load first batch of messages
  useEffect(() => {
    if (!recordingStartTime || recordingStartTime === 0) return;

    // On first load, fetch all messages from start
    const fromMs = recordingStartTime;
    const toMs = recordingStartTime + (60 * 60 * 1000); // First hour

    if (!lastFetchedRangeRef.current) {
      fetchMessages(fromMs, toMs);
    }
  }, [recordingStartTime, fetchMessages]);

  // Progressive loading as playback continues
  useEffect(() => {
    if (!recordingStartTime || recordingStartTime === 0) return;

    // Fetch a window around current time
    const windowSize = 5 * 60 * 1000; // 5 minutes
    const fromMs = Math.max(recordingStartTime, currentAbsoluteTime - windowSize);
    const toMs = currentAbsoluteTime + windowSize;

    // Only fetch if we don't have this range
    const lastRange = lastFetchedRangeRef.current;
    if (lastRange && (fromMs < lastRange.from || toMs > lastRange.to)) {
      fetchMessages(fromMs, toMs);
    }
  }, [recordingStartTime, currentAbsoluteTime, fetchMessages]);

  // Filter visible messages based on current time
  useEffect(() => {
    const visible = messages.filter(m => m.timestamp <= currentAbsoluteTime);
    // Keep last 100 messages visible
    setVisibleMessages(visible.slice(-100));
  }, [messages, currentAbsoluteTime]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [visibleMessages, autoScroll]);

  // Handle manual scroll
  const handleScroll = () => {
    if (!chatContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = chatContainerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
    setAutoScroll(isAtBottom);
  };

  // Format timestamp for display
  const formatTimestamp = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  // Get relative time from recording start
  const getRelativeTime = (timestamp: number) => {
    const relativeMs = timestamp - recordingStartTime;
    return formatDuration(relativeMs);
  };

  return (
    <div className="synced-chat-replay">
      <div className="chat-header">
        <h4>Chat Replay</h4>
        <div className="chat-status">
          {loading && <span className="loading-indicator">Loading...</span>}
          <span className="message-count">
            {visibleMessages.length} messages
          </span>
        </div>
      </div>

      {error && (
        <div className="chat-error">
          <span>{error}</span>
          <button onClick={() => fetchMessages(
            currentAbsoluteTime - 5 * 60 * 1000,
            currentAbsoluteTime + 5 * 60 * 1000
          )}>
            Retry
          </button>
        </div>
      )}

      <div
        ref={chatContainerRef}
        className="chat-messages"
        onScroll={handleScroll}
      >
        {visibleMessages.length === 0 ? (
          <div className="no-messages">
            No chat messages at this point in the recording
          </div>
        ) : (
          visibleMessages.map(msg => (
            <div
              key={msg.id}
              className={`chat-message ${msg.isSystem ? 'system' : ''}`}
            >
              <span className="message-time" title={formatTimestamp(msg.timestamp)}>
                [{getRelativeTime(msg.timestamp)}]
              </span>
              <span
                className="message-username"
                style={{ color: msg.color || '#ffffff' }}
              >
                {msg.username}:
              </span>
              <span className="message-text">{msg.message}</span>
            </div>
          ))
        )}
      </div>

      {!autoScroll && (
        <button
          className="scroll-to-bottom"
          onClick={() => {
            setAutoScroll(true);
            if (chatContainerRef.current) {
              chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
            }
          }}
        >
          Scroll to latest
        </button>
      )}
    </div>
  );
};

export default SyncedChatReplay;
