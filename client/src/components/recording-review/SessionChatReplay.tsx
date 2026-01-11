import React, { useState, useEffect, useRef, useCallback } from 'react';

interface ChatMessage {
  id: number;
  username: string;
  message: string;
  color: string | null;
  relative_time_ms: number;
  absolute_time_ms: number;
  isSystem: boolean;
  isContext: boolean;
}

interface SessionChatReplayProps {
  sessionId: string;
  currentTimeMs: number;
  durationMs: number;
  isPlaying: boolean;
  makeApiCall: (endpoint: string, options?: RequestInit) => Promise<any>;
  onSeek: (timeMs: number) => void;
}

const SessionChatReplay: React.FC<SessionChatReplayProps> = ({
  sessionId,
  currentTimeMs,
  durationMs,
  isPlaying,
  makeApiCall,
  onSeek
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const fetchMessages = useCallback(async () => {
    try {
      setLoading(true);
      const response = await makeApiCall(`/admin/review/sessions/${sessionId}/chat`);

      if (response.success) {
        setMessages(response.messages);
        setError(null);
      } else {
        setError(response.error || 'Failed to fetch chat');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to fetch chat');
    } finally {
      setLoading(false);
    }
  }, [makeApiCall, sessionId]);

  useEffect(() => {
    fetchMessages();
  }, [fetchMessages]);

  // Auto-scroll when playing
  useEffect(() => {
    if (autoScroll && isPlaying && chatContainerRef.current) {
      const visibleMessages = messages.filter(
        msg => msg.isContext || msg.relative_time_ms <= currentTimeMs + 500
      );
      if (visibleMessages.length > 0) {
        const container = chatContainerRef.current;
        container.scrollTop = container.scrollHeight;
      }
    }
  }, [currentTimeMs, messages, isPlaying, autoScroll]);

  // Handle manual scroll
  const handleScroll = () => {
    if (!chatContainerRef.current) return;

    const container = chatContainerRef.current;
    const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
    setAutoScroll(isAtBottom);
  };

  const handleMessageClick = (msg: ChatMessage) => {
    if (msg.relative_time_ms >= 0) {
      onSeek(msg.relative_time_ms);
    }
  };

  const formatTime = (ms: number) => {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  // Filter messages based on current playback time
  const visibleMessages = messages.filter(msg => {
    if (msg.isContext) return true; // Always show context messages
    return msg.relative_time_ms <= currentTimeMs + 500; // 500ms lookahead buffer
  });

  if (loading) {
    return <div className="chat-replay-loading">Loading chat...</div>;
  }

  if (error) {
    return (
      <div className="chat-replay-error">
        <p>{error}</p>
        <button onClick={fetchMessages}>Retry</button>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="chat-replay-empty">
        <p>No chat messages recorded</p>
      </div>
    );
  }

  return (
    <div className="session-chat-replay">
      <div className="chat-header">
        <span className="chat-title">Chat Replay</span>
        <span className="chat-count">
          {visibleMessages.length} / {messages.length} messages
        </span>
      </div>

      <div
        className="chat-messages"
        ref={chatContainerRef}
        onScroll={handleScroll}
      >
        {visibleMessages.map((msg) => (
          <div
            key={msg.id}
            className={`chat-message ${msg.isContext ? 'context' : ''} ${msg.isSystem ? 'system' : ''}`}
            onClick={() => handleMessageClick(msg)}
          >
            <span className="message-time">
              {msg.isContext ? '(context)' : formatTime(msg.relative_time_ms)}
            </span>
            <span
              className="message-username"
              style={{ color: msg.color || '#888' }}
            >
              {msg.username}:
            </span>
            <span className="message-text">{msg.message}</span>
          </div>
        ))}
      </div>

      <div className="chat-footer">
        <button
          className={`auto-scroll-btn ${autoScroll ? 'active' : ''}`}
          onClick={() => setAutoScroll(!autoScroll)}
        >
          {autoScroll ? 'Auto-scroll: ON' : 'Auto-scroll: OFF'}
        </button>
      </div>
    </div>
  );
};

export default SessionChatReplay;
