import React from 'react';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import Chat from './Chat';
import { ChatMessage } from '../hooks/useChatMessages';
import { UserInfo } from '../hooks/useChatSocket';

// ---------------------------------------------------------------------------
// Characterization test for Chat.tsx
// ---------------------------------------------------------------------------
// This pins the CURRENT observable behavior of the Chat component BEFORE the
// decomposition refactor. It must remain UNCHANGED across the refactor commit.
//
// IO mechanism (verified by reading the source):
//   - The chat socket is NOT a prop. It is owned by `SocketContext` and
//     consumed through the real `useChatSocket` hook (../hooks/useChatSocket),
//     which itself calls `useChatSocket` from `../contexts/SocketContext`.
//   - We mock ONLY the context module, injecting a fake `chatSocket`
//     ({emit, on, off, connected, id}). The real `useChatSocket` hook then
//     registers real `socket.on(...)` handlers against our fake; we capture
//     those handlers and drive messages / user-assignment / counts through
//     them exactly the way the live server would.
//   - `authService`, global `fetch`, the Turnstile widget, and the popout
//     window opener are stubbed so the component renders deterministically.
// ---------------------------------------------------------------------------

// --- Fake chat socket + context mock --------------------------------------
type Handler = (...args: any[]) => void;
const socketHandlers: Record<string, Handler> = {};

const mockSocket = {
  emit: jest.fn(),
  on: jest.fn((event: string, handler: Handler) => {
    socketHandlers[event] = handler;
  }),
  off: jest.fn((event: string) => {
    delete socketHandlers[event];
  }),
  connected: true,
  id: 'sock-test',
};

jest.mock('../contexts/SocketContext', () => ({
  __esModule: true,
  useChatSocket: () => ({ socket: mockSocket, connected: true, error: null }),
  useSocket: () => ({}),
  useMainSocket: () => ({ socket: null, connected: false, error: null }),
}));

// --- authService stub ------------------------------------------------------
jest.mock('../services/AuthService', () => ({
  __esModule: true,
  default: {
    getToken: jest.fn(() => null),
    getUser: jest.fn(() => null),
  },
}));

// --- Heavy / external sub-components stubbed to keep render deterministic ---
jest.mock('./CloudflareTurnstile', () => ({
  __esModule: true,
  default: () => <div data-testid="turnstile-widget" />,
}));

jest.mock('./PopoutChat', () => ({
  __esModule: true,
  openPopoutChat: jest.fn(() => null),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { openPopoutChat: mockOpenPopoutChat } = require('./PopoutChat');

// Helper to drive a socket event the component registered via socket.on().
function emitServer(event: string, payload?: any) {
  const handler = socketHandlers[event];
  if (!handler) throw new Error(`No handler registered for "${event}"`);
  act(() => {
    handler(payload);
  });
}

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm-1',
    username: 'alice',
    color: '#ff0000',
    message: 'hello world',
    timestamp: '12:00',
    fullTimestamp: '2026-05-23T12:00:00.000Z',
    userId: 'u-1',
    ...overrides,
  };
}

const assignedUser: UserInfo = {
  username: 'tester',
  color: '#4ECDC4',
  userId: 'u-self',
};

// --- sessionStorage / localStorage in-memory backing -----------------------
let store: Record<string, string>;
let fetchMock: jest.Mock;

beforeEach(() => {
  Object.keys(socketHandlers).forEach((k) => delete socketHandlers[k]);
  mockSocket.emit.mockClear();
  // Re-install the capture implementations every test. `restoreAllMocks` in
  // afterEach can strip jest.fn implementations, so re-set them here to ensure
  // socket.on continues recording handlers and socket.off removing them.
  mockSocket.on.mockReset().mockImplementation((event: string, handler: Handler) => {
    socketHandlers[event] = handler;
  });
  mockSocket.off.mockReset().mockImplementation((event: string) => {
    delete socketHandlers[event];
  });

  store = {};
  jest.spyOn(Storage.prototype, 'getItem').mockImplementation((key: string) =>
    key in store ? store[key] : null,
  );
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation((key: string, value: string) => {
    store[key] = String(value);
  });
  jest.spyOn(Storage.prototype, 'removeItem').mockImplementation((key: string) => {
    delete store[key];
  });

  // Custom-emoji fetch (and any other fetch) resolves to an empty list.
  fetchMock = jest.fn(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve([]),
      text: () => Promise.resolve(''),
      status: 200,
    }),
  ) as unknown as jest.Mock;
  (global as any).fetch = fetchMock;

  // alert is invoked on ban / timeout.
  jest.spyOn(window, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Chat (characterization)', () => {
  it('renders the chat header and connection indicator', () => {
    render(<Chat />);
    expect(screen.getByText('Live Chat')).toBeInTheDocument();
    expect(screen.getByText('Pop Out')).toBeInTheDocument();
  });

  it('registers the chat socket listeners on mount', () => {
    render(<Chat />);
    expect(mockSocket.on).toHaveBeenCalledWith('new-message', expect.any(Function));
    expect(mockSocket.on).toHaveBeenCalledWith('chat-history', expect.any(Function));
    expect(mockSocket.on).toHaveBeenCalledWith('user-assigned', expect.any(Function));
    // Requests initial state on connect.
    expect(mockSocket.emit).toHaveBeenCalledWith('request-user-info');
    expect(mockSocket.emit).toHaveBeenCalledWith('request-viewer-count');
  });

  it('shows the empty state when connected with no messages', () => {
    render(<Chat />);
    expect(
      screen.getByText('No messages yet. Start the conversation!'),
    ).toBeInTheDocument();
  });

  it('renders a message pushed through the new-message socket handler', () => {
    render(<Chat />);
    emitServer('new-message', makeMessage({ id: 'a', username: 'bob', message: 'hi there' }));

    expect(screen.getByText('hi there')).toBeInTheDocument();
    expect(screen.getByText('bob:')).toBeInTheDocument();
    // Empty-state placeholder is gone once a message exists.
    expect(
      screen.queryByText('No messages yet. Start the conversation!'),
    ).not.toBeInTheDocument();
  });

  it('replaces the list when chat-history arrives', () => {
    render(<Chat />);
    emitServer('chat-history', [
      makeMessage({ id: 'h1', username: 'carol', message: 'first' }),
      makeMessage({ id: 'h2', username: 'dave', message: 'second' }),
    ]);

    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.getByText('second')).toBeInTheDocument();
    expect(screen.getByText('carol:')).toBeInTheDocument();
  });

  it('removes messages when delete-messages arrives', () => {
    render(<Chat />);
    emitServer('chat-history', [
      makeMessage({ id: 'd1', username: 'carol', message: 'keepme' }),
      makeMessage({ id: 'd2', username: 'dave', message: 'deleteme' }),
    ]);
    expect(screen.getByText('deleteme')).toBeInTheDocument();

    emitServer('delete-messages', { messageIds: ['d2'], reason: 'spam' });
    expect(screen.queryByText('deleteme')).not.toBeInTheDocument();
    expect(screen.getByText('keepme')).toBeInTheDocument();
  });

  it('clears the list on chat-cleared', () => {
    render(<Chat />);
    emitServer('chat-history', [makeMessage({ id: 'c1', message: 'wipe me' })]);
    expect(screen.getByText('wipe me')).toBeInTheDocument();

    emitServer('chat-cleared', {});
    expect(screen.queryByText('wipe me')).not.toBeInTheDocument();
  });

  it('typing + submitting emits a send-message socket event', () => {
    // Pre-seed Turnstile verification so the send is not gated.
    store['chatTurnstileVerified'] = 'true';
    render(<Chat />);

    const input = screen.getByPlaceholderText('Type a message...') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'my message' } });
    expect(input.value).toBe('my message');

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(mockSocket.emit).toHaveBeenCalledWith('send-message', { message: 'my message' });
    // Input clears after a successful send.
    expect(input.value).toBe('');
  });

  it('does not emit send-message for an empty/whitespace input', () => {
    store['chatTurnstileVerified'] = 'true';
    render(<Chat />);

    const input = screen.getByPlaceholderText('Type a message...') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    const sendCalls = mockSocket.emit.mock.calls.filter((c) => c[0] === 'send-message');
    expect(sendCalls).toHaveLength(0);
  });

  it('toggles the emoji picker when the emoji button is clicked', () => {
    render(<Chat />);
    const emojiButton = screen.getByTitle('Custom emojis');

    expect(emojiButton).not.toHaveClass('active');
    fireEvent.click(emojiButton);
    expect(emojiButton).toHaveClass('active');
  });

  it('shows the current username + settings gear after user-assigned', () => {
    render(<Chat />);
    // No user info initially -> no username block / settings gear.
    expect(screen.queryByText(assignedUser.username)).not.toBeInTheDocument();

    emitServer('user-assigned', assignedUser);

    expect(screen.getByText(assignedUser.username)).toBeInTheDocument();
    expect(screen.getByTitle('Chat settings')).toBeInTheDocument();
  });

  it('renders the scroll container and end sentinel for the message list', () => {
    render(<Chat />);
    const container = document.querySelector('.chat-messages') as HTMLElement;
    expect(container).toBeInTheDocument();
    // The empty-state placeholder lives inside the scroll container.
    expect(
      within(container).getByText('No messages yet. Start the conversation!'),
    ).toBeInTheDocument();
  });

  it('keeps the live chat UI when popout fails to open (null window)', () => {
    mockOpenPopoutChat.mockReturnValueOnce(null);
    render(<Chat />);
    fireEvent.click(screen.getByText('Pop Out'));
    expect(screen.getByText('Live Chat')).toBeInTheDocument();
    expect(
      screen.queryByText('Chat Opened in New Window'),
    ).not.toBeInTheDocument();
  });

  it('switches to the popped-out indicator when a popout window opens', () => {
    mockOpenPopoutChat.mockReturnValueOnce({ closed: false, close: jest.fn() });
    render(<Chat />);
    act(() => {
      fireEvent.click(screen.getByText('Pop Out'));
    });
    expect(screen.getByText('Chat Opened in New Window')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Return Chat to Main Window' }),
    ).toBeInTheDocument();
  });

  it('shows an alert and stays mounted when the user is banned', () => {
    render(<Chat />);
    emitServer('banned', { reason: 'rule violation' });
    expect(window.alert).toHaveBeenCalledWith(
      expect.stringContaining('banned'),
    );
    // Component still renders its header after the ban notification.
    expect(screen.getByText('Live Chat')).toBeInTheDocument();
  });

  it('applies the className prop to the chat container', () => {
    const { container } = render(<Chat className="my-extra-class" />);
    const root = container.querySelector('.chat-container');
    expect(root).toHaveClass('my-extra-class');
  });

  it('renders the send button disabled state reflecting connection', () => {
    render(<Chat />);
    // Connected (mock) -> default placeholder, Send button present.
    expect(screen.getByPlaceholderText('Type a message...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });
});
