/**
 * Characterization tests for App (the ROOT component).
 *
 * These pin the CURRENT, observable DOM shape of the app shell so that a
 * conservative decomposition of App.tsx can be verified to preserve behavior.
 * They assert ONLY current actual behavior, not desired behavior.
 *
 * Companion to the existing src/App.test.tsx smoke test (which must also keep
 * passing). The mocking strategy mirrors App.test.tsx + setupTests.ts:
 * jsdom defaults make matchMedia return false and window.innerWidth large,
 * so the app boots in its DESKTOP + THEATRE-MODE default state. socket.io is
 * mocked so the SocketProvider mounts without a real connection.
 */
import { render } from '@testing-library/react';
import App from './App';

function mockSocket() {
  jest.doMock('socket.io-client', () =>
    jest.fn(() => ({
      emit: jest.fn(),
      on: jest.fn(),
      off: jest.fn(),
      disconnect: jest.fn(),
      id: 'mock-socket-id',
    }))
  );
}

describe('App characterization (desktop / theatre-mode default)', () => {
  test('renders the root .App shell', () => {
    mockSocket();
    const { container } = render(<App />);
    const app = container.querySelector('.App');
    expect(app).toBeInTheDocument();
  });

  test('boots in theatre mode by default on desktop (jsdom)', () => {
    mockSocket();
    const { container } = render(<App />);
    // window.innerWidth in jsdom is desktop-sized and matchMedia is mocked
    // false, so the theatreMode initializer evaluates to true.
    expect(container.querySelector('.App')).toHaveClass('theatre-mode');
  });

  test('renders the App-main region (providers + layout mounted)', () => {
    mockSocket();
    const { container } = render(<App />);
    expect(container.querySelector('.App-main')).toBeInTheDocument();
  });

  test('main-content carries the theatre-mode-active modifier', () => {
    mockSocket();
    const { container } = render(<App />);
    const mainContent = container.querySelector('.main-content');
    expect(mainContent).toBeInTheDocument();
    expect(mainContent).toHaveClass('theatre-mode-active');
  });

  test('renders the stream layout + viewer regions', () => {
    mockSocket();
    const { container } = render(<App />);
    expect(container.querySelector('.stream-layout-container')).toBeInTheDocument();
    expect(container.querySelector('.stream-viewer-container')).toBeInTheDocument();
  });

  test('renders the theatre-mode chat sidebar (not the non-theatre chat-sidebar)', () => {
    mockSocket();
    const { container } = render(<App />);
    // In theatre mode the chat lives inside .theatre-mode-sidebar / .theatre-mode-chat,
    // and the non-theatre .chat-sidebar is NOT rendered.
    expect(container.querySelector('.theatre-mode-sidebar')).toBeInTheDocument();
    expect(container.querySelector('.theatre-mode-chat')).toBeInTheDocument();
    expect(container.querySelector('.chat-sidebar')).not.toBeInTheDocument();
  });

  test('renders the theatre chat collapse toggle', () => {
    mockSocket();
    const { container } = render(<App />);
    expect(container.querySelector('.theatre-chat-toggle')).toBeInTheDocument();
  });

  test('does NOT render the non-theatre stream-controls / theatre-mode button', () => {
    mockSocket();
    const { container } = render(<App />);
    // These belong to the !theatreMode branch; absent in the default theatre layout.
    expect(container.querySelector('.stream-controls-container')).not.toBeInTheDocument();
    expect(container.querySelector('.theatre-mode-btn')).not.toBeInTheDocument();
  });

  test('mounts exactly one App shell instance (no double-mount)', () => {
    mockSocket();
    const { container } = render(<App />);
    expect(container.querySelectorAll('.App')).toHaveLength(1);
  });

  test('does not render takeover / transition / disconnection overlays at rest', () => {
    mockSocket();
    const { container } = render(<App />);
    expect(container.querySelector('.takeover-overlay')).not.toBeInTheDocument();
    expect(container.querySelector('.disconnection-banner')).not.toBeInTheDocument();
    expect(container.querySelector('.error-message')).not.toBeInTheDocument();
  });

  test('renders without throwing (parity with App.test.tsx smoke test)', () => {
    mockSocket();
    expect(() => render(<App />)).not.toThrow();
  });
});
