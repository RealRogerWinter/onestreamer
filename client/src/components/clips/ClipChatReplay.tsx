import React, { useState, useEffect, useRef, useCallback } from 'react';

interface ChatMessage {
  username: string;
  message: string;
  relative_time_ms: number;
  original_timestamp: string;
  isContext?: boolean; // Messages from before clip started (for context)
}

interface ClipChatReplayProps {
  clipId: string;
  currentTimeMs: number;
  isPlaying: boolean;
  duration: number;
}

const ClipChatReplay: React.FC<ClipChatReplayProps> = ({
  clipId,
  currentTimeMs,
  isPlaying,
  duration
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [visibleMessages, setVisibleMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chatEnabled, setChatEnabled] = useState(true);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const lastScrollRef = useRef<number>(0);

  // Fetch chat messages for the clip
  useEffect(() => {
    const fetchChat = async () => {
      try {
        setLoading(true);
        setError(null);
        const response = await fetch(`/api/clips/${clipId}/chat`);
        const data = await response.json();

        if (data.success) {
          setMessages(data.messages);
        } else {
          setError('Failed to load chat');
        }
      } catch (err) {
        console.error('Error fetching clip chat:', err);
        setError('Failed to load chat');
      } finally {
        setLoading(false);
      }
    };

    fetchChat();
  }, [clipId]);

  // Update visible messages based on current playback time
  useEffect(() => {
    if (!chatEnabled || messages.length === 0) {
      setVisibleMessages([]);
      return;
    }

    // Show messages up to current time (with small buffer ahead)
    // Context messages (negative relative_time_ms) are shown immediately at start
    const currentTime = currentTimeMs;
    const visible = messages.filter(msg => {
      // Context messages (negative time) are always shown from the start
      if (msg.relative_time_ms < 0) return true;
      // Regular messages appear when video time reaches them
      return msg.relative_time_ms <= currentTime + 500;
    });

    setVisibleMessages(visible);
  }, [currentTimeMs, messages, chatEnabled]);

  // Auto-scroll to bottom when new messages appear
  useEffect(() => {
    if (chatContainerRef.current && visibleMessages.length > 0) {
      const container = chatContainerRef.current;
      const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;

      // Only auto-scroll if user hasn't scrolled up significantly
      if (isNearBottom || isPlaying) {
        container.scrollTop = container.scrollHeight;
      }
    }
  }, [visibleMessages, isPlaying]);

  // Format timestamp for display
  const formatTime = (ms: number): string => {
    // Context messages (negative time) show as pre-clip marker
    if (ms < 0) {
      return '...';
    }
    const seconds = Math.floor(ms / 1000);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Toggle chat visibility
  const toggleChat = () => {
    setChatEnabled(!chatEnabled);
  };

  if (loading) {
    return (
      <div className="clip-chat-replay">
        <div className="clip-chat-header">
          <span>Chat Replay</span>
        </div>
        <div className="clip-chat-loading">
          <div className="clip-chat-spinner"></div>
          <span>Loading chat...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="clip-chat-replay">
        <div className="clip-chat-header">
          <span>Chat Replay</span>
        </div>
        <div className="clip-chat-error">
          <span>{error}</span>
        </div>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="clip-chat-replay">
        <div className="clip-chat-header">
          <span>Chat Replay</span>
        </div>
        <div className="clip-chat-empty">
          <span>No chat messages during this clip</span>
        </div>
      </div>
    );
  }

  return (
    <div className="clip-chat-replay">
      <div className="clip-chat-header">
        <span>Chat Replay</span>
        <div className="clip-chat-controls">
          <span className="clip-chat-count">{visibleMessages.length}/{messages.length}</span>
          <button
            className={`clip-chat-toggle ${chatEnabled ? 'active' : ''}`}
            onClick={toggleChat}
            title={chatEnabled ? 'Hide chat' : 'Show chat'}
          >
            {chatEnabled ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>

      {chatEnabled && (
        <div className="clip-chat-messages" ref={chatContainerRef}>
          {visibleMessages.map((msg, index) => (
            <div
              key={`${msg.relative_time_ms}-${index}`}
              className={`clip-chat-message ${msg.relative_time_ms < 0 ? 'clip-chat-context' : ''}`}
            >
              <span className="clip-chat-timestamp">{formatTime(msg.relative_time_ms)}</span>
              <span className="clip-chat-username">{msg.username}</span>
              <span className="clip-chat-text">{msg.message}</span>
            </div>
          ))}

          {visibleMessages.length === 0 && (
            <div className="clip-chat-waiting">
              Waiting for chat...
            </div>
          )}
        </div>
      )}

      {!chatEnabled && (
        <div className="clip-chat-disabled">
          <span>Chat replay disabled</span>
          <button onClick={toggleChat}>Enable</button>
        </div>
      )}
    </div>
  );
};

export default ClipChatReplay;
