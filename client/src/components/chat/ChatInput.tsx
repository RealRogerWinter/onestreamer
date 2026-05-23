import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';

export interface ChatInputHandle {
  /** Insert text at the current cursor position and refocus the input. */
  insertAtCursor: (text: string) => void;
  /** Focus the input element. */
  focus: () => void;
  /** Programmatically trigger a submit (e.g. after Turnstile verification). */
  submit: () => void;
  /** Clear the input value (e.g. after a ban/timeout notification). */
  clear: () => void;
}

export interface ChatInputProps {
  /**
   * Submit the trimmed message. Returning `true` means the input should clear
   * itself (message was accepted/queued). Returning `false` leaves the input
   * value intact (e.g. parent gated on Turnstile verification).
   */
  onSend: (text: string) => boolean;
  /** Step backwards (older) in chat message history. */
  historyPrev: () => { index: number; message: string } | null;
  /** Step forwards (newer) in chat message history. */
  historyNext: () => { index: number; message: string } | null;
  /** Reset the history cursor (called when the user starts typing fresh). */
  resetHistoryIndex: () => void;
  /** Disable the input + send button (e.g. when socket is not connected). */
  disabled?: boolean;
  /** Override the default placeholder shown inside the input. */
  placeholder?: string;
}

/**
 * Controlled chat input box + send button. Owns the in-progress message text
 * and handles arrow-up/arrow-down history navigation locally. The parent
 * remains responsible for higher-level concerns (Turnstile gating, scroll
 * reset, pushing into history on send) via the `onSend` callback.
 */
export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(
  ({ onSend, historyPrev, historyNext, resetHistoryIndex, disabled = false, placeholder }, ref) => {
    const [currentMessage, setCurrentMessage] = useState('');
    const [inHistory, setInHistory] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    const submit = useCallback(() => {
      const trimmed = currentMessage.trim();
      if (!trimmed) return;
      const consumed = onSend(trimmed);
      if (consumed) {
        setCurrentMessage('');
        setInHistory(false);
      }
    }, [currentMessage, onSend]);

    useImperativeHandle(
      ref,
      () => ({
        insertAtCursor: (text: string) => {
          const input = inputRef.current;
          const cursorPosition = input?.selectionStart ?? currentMessage.length;
          const next =
            currentMessage.slice(0, cursorPosition) +
            text +
            currentMessage.slice(cursorPosition);
          setCurrentMessage(next);

          // Restore focus + place caret after the inserted text.
          setTimeout(() => {
            const el = inputRef.current;
            if (el) {
              el.focus();
              const newPosition = cursorPosition + text.length;
              el.setSelectionRange(newPosition, newPosition);
            }
          }, 0);
        },
        focus: () => {
          inputRef.current?.focus();
        },
        submit,
        clear: () => {
          setCurrentMessage('');
          setInHistory(false);
        },
      }),
      [currentMessage, submit],
    );

    const handleSubmit = useCallback(
      (e: React.FormEvent) => {
        e.preventDefault();
        submit();
      },
      [submit],
    );

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'ArrowUp') {
          // Navigate to older messages when input is empty or already in history.
          if (currentMessage === '' || inHistory) {
            e.preventDefault();
            const result = historyPrev();
            if (result) {
              setCurrentMessage(result.message);
              setInHistory(true);
              // Move cursor to end of input.
              setTimeout(() => {
                const el = inputRef.current;
                if (el) {
                  el.setSelectionRange(el.value.length, el.value.length);
                }
              }, 0);
            }
          }
        } else if (e.key === 'ArrowDown') {
          if (inHistory) {
            e.preventDefault();
            const result = historyNext();
            if (result) {
              setCurrentMessage(result.message);
            } else {
              // Reached the end, clear input.
              setCurrentMessage('');
              setInHistory(false);
            }
            setTimeout(() => {
              const el = inputRef.current;
              if (el) {
                el.setSelectionRange(el.value.length, el.value.length);
              }
            }, 0);
          }
        } else if (e.key !== 'Enter' && inHistory) {
          // Any other key press resets history navigation while typing.
          setInHistory(false);
          resetHistoryIndex();
        }
      },
      [currentMessage, inHistory, historyPrev, historyNext, resetHistoryIndex],
    );

    const handleKeyPress = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          submit();
        }
      },
      [submit],
    );

    return (
      <form onSubmit={handleSubmit} className="chat-input-form">
        <input
          ref={inputRef}
          type="text"
          value={currentMessage}
          onChange={(e) => setCurrentMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          onKeyPress={handleKeyPress}
          placeholder={placeholder ?? (disabled ? 'Connecting...' : 'Type a message...')}
          disabled={disabled}
          maxLength={2000}
          className="chat-input"
        />
        <button
          type="submit"
          disabled={disabled || !currentMessage.trim()}
          className="chat-send-button"
        >
          Send
        </button>
      </form>
    );
  },
);

ChatInput.displayName = 'ChatInput';

export default ChatInput;
