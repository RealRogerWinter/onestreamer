import { useEffect, useCallback } from 'react';
import { Socket } from 'socket.io-client';
import { useChatSocket as useChatSocketContext } from '../contexts/SocketContext';
import { ChatMessage } from './useChatMessages';

export interface UserInfo {
  username: string;
  color: string;
  userId: string;
  isAdmin?: boolean;
  isModerator?: boolean;
}

/**
 * Sentinel message body that the chat-service broadcasts via `new-message` to
 * tell every client to wipe its UI without persisting anything. Matched
 * exactly against `message.message` and intercepted before the message is
 * appended (so callers see it as a clear, not a message).
 */
const CLEAR_CHAT_UI_SENTINEL = '**CLEAR_CHAT_UI**';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface UseChatSocketOptions {
  /** Called when a new chat message arrives via `new-message` (sentinel-filtered). */
  onMessage?: (message: ChatMessage) => void;
  /** Called when the full chat history arrives via `chat-history` — replaces the current list. */
  onMessagesReplace?: (messages: ChatMessage[]) => void;
  /** Called when admin/moderator deletes one or more messages (`delete-messages`). */
  onDeleteMessages?: (ids: string[]) => void;
  /** Called when chat is cleared by admin (`chat-cleared` or `chat-clear-ui`) or via the `**CLEAR_CHAT_UI**` sentinel. */
  onChatCleared?: () => void;
  /** Called when the server assigns / updates the local user identity (`user-assigned`). */
  onUserAssigned?: (info: UserInfo) => void;
  /** Called on viewer-count updates (`user-count-update`). */
  onUserCountChange?: (count: number) => void;
  /** Called when the local user is banned (`banned`). */
  onBanned?: (data: { reason: string }) => void;
  /** Called when the local user is timed out (`timeout`). */
  onTimeout?: (data: { reason: string; endTime: number }) => void;
}

export interface UseChatSocketResult {
  /** The underlying chat socket (null until the SocketProvider has produced one). */
  socket: Socket | null;
  /** Derived connection status suitable for connection-indicator UI. */
  connectionStatus: ConnectionStatus;
  /**
   * Emit a `send-message` event. No-op when disconnected.
   * Returns true if the emit was attempted.
   */
  sendMessage: (message: string) => boolean;
}

/**
 * Hook that wraps the chat socket subscription + send logic.
 *
 * The socket itself is owned by `SocketContext` (singleton via `SocketManager`)
 * — this hook is a thin layer that:
 *   - registers the chat-specific listeners (`chat-history`, `new-message`,
 *     `user-assigned`, `user-count-update`, `chat-cleared`, `chat-clear-ui`,
 *     `banned`, `timeout`, `delete-messages`),
 *   - requests initial state on connect (`request-user-info`, `request-viewer-count`),
 *   - intercepts the `**CLEAR_CHAT_UI**` sentinel inside `new-message` and turns
 *     it into an `onChatCleared` callback (matching the previous inline behavior),
 *   - exposes a `sendMessage(text)` helper for `send-message` emission.
 *
 * State that the parent already owns (messages, userInfo, userCount, settings,
 * scroll, turnstile) is updated via the callbacks in {@link UseChatSocketOptions}.
 * No new state is added by this hook beyond the derived `connectionStatus`.
 */
export function useChatSocket(opts: UseChatSocketOptions = {}): UseChatSocketResult {
  const { socket, connected } = useChatSocketContext();

  const {
    onMessage,
    onMessagesReplace,
    onDeleteMessages,
    onChatCleared,
    onUserAssigned,
    onUserCountChange,
    onBanned,
    onTimeout,
  } = opts;

  // Register chat event handlers
  useEffect(() => {
    if (!socket) return;

    // console.log('💬 CLIENT: Setting up chat event handlers');

    // Request current user info and viewer count when component mounts
    socket.emit('request-user-info');
    socket.emit('request-viewer-count');

    const handleUserAssigned = (data: UserInfo) => {
      // console.log('💬 CLIENT: Assigned username:', data.username, 'color:', data.color);
      onUserAssigned?.(data);
    };

    const handleChatHistory = (history: ChatMessage[]) => {
      // console.log('💬 CLIENT: Received chat history:', history.length, 'messages');
      onMessagesReplace?.(history);
    };

    const handleNewMessage = (message: ChatMessage) => {
      // console.log('💬 CLIENT: New message from', message.username + ':', message.message);

      // Check if this is a clear command
      if (message.message === CLEAR_CHAT_UI_SENTINEL) {
        // console.log('💬 CLIENT: Received clear command, clearing chat UI');
        onChatCleared?.();
        return; // Don't add the clear command message to the chat
      }

      onMessage?.(message);
    };

    const handleUserCountUpdate = (data: { count: number }) => {
      onUserCountChange?.(data.count);
    };

    const handleChatCleared = (_data: any) => {
      // console.log('💬 CLIENT: Chat cleared by admin');
      onChatCleared?.();
    };

    const handleChatClearUI = (_data: any) => {
      // console.log('💬 CLIENT: Chat UI clear requested');
      onChatCleared?.();
    };

    const handleBanned = (data: any) => {
      // console.log('💬 CLIENT: User has been banned:', data.reason);
      onBanned?.(data);
    };

    const handleTimeout = (data: any) => {
      // console.log('💬 CLIENT: User has been timed out');
      onTimeout?.(data);
    };

    const handleDeleteMessages = (data: { messageIds: string[]; reason: string }) => {
      // console.log('💬 CLIENT: Deleting messages:', data.messageIds.length);
      onDeleteMessages?.(data.messageIds);
    };

    socket.on('user-assigned', handleUserAssigned);
    socket.on('chat-history', handleChatHistory);
    socket.on('new-message', handleNewMessage);
    socket.on('user-count-update', handleUserCountUpdate);
    socket.on('chat-cleared', handleChatCleared);
    socket.on('chat-clear-ui', handleChatClearUI);
    socket.on('banned', handleBanned);
    socket.on('timeout', handleTimeout);
    socket.on('delete-messages', handleDeleteMessages);

    return () => {
      // console.log('💬 CLIENT: Cleaning up chat event handlers');
      socket.off('user-assigned', handleUserAssigned);
      socket.off('chat-history', handleChatHistory);
      socket.off('new-message', handleNewMessage);
      socket.off('user-count-update', handleUserCountUpdate);
      socket.off('chat-cleared', handleChatCleared);
      socket.off('chat-clear-ui', handleChatClearUI);
      socket.off('banned', handleBanned);
      socket.off('timeout', handleTimeout);
      socket.off('delete-messages', handleDeleteMessages);
    };
  }, [
    socket,
    onMessage,
    onMessagesReplace,
    onDeleteMessages,
    onChatCleared,
    onUserAssigned,
    onUserCountChange,
    onBanned,
    onTimeout,
  ]);

  const sendMessage = useCallback(
    (message: string): boolean => {
      if (!socket || !connected) return false;
      socket.emit('send-message', { message });
      return true;
    },
    [socket, connected]
  );

  const connectionStatus: ConnectionStatus = connected ? 'connected' : 'disconnected';

  return {
    socket,
    connectionStatus,
    sendMessage,
  };
}

export default useChatSocket;
