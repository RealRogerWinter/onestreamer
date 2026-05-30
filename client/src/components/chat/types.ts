// Shared chat types barrel.
//
// Re-exports the message + socket types from the chat hooks so chat sub-
// components and hooks can import from a single, stable location instead of
// reaching into ../../hooks/* directly. The chat settings type lives in the
// existing ChatSettings component; it is re-exported here for the same reason.
export type { ChatMessage } from '../../hooks/useChatMessages';
export type { UserInfo, ConnectionStatus } from '../../hooks/useChatSocket';
export type { ChatUserSettings } from '../ChatSettings';
