import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import ConnectionMonitor from './ConnectionMonitor';

/**
 * Regression tests for audit Plan 05, C4: ConnectionMonitor used to call
 * socket.off('stream-started') / socket.off('stream-ended') (and friends)
 * WITHOUT handler references on cleanup, which removes EVERY listener for
 * those events on the shared main socket — stripping App-level stream state
 * and WebRTCViewer's takeover/stream-end handling whenever an admin left the
 * Connections tab (or on any connected flap).
 */

// Minimal socket.io-like emitter with faithful off() semantics:
// off(event, handler) removes just that handler; off(event) removes ALL.
class FakeSocket {
  private listeners = new Map<string, Array<(...args: any[]) => void>>();

  on(event: string, handler: (...args: any[]) => void) {
    const existing = this.listeners.get(event) || [];
    existing.push(handler);
    this.listeners.set(event, existing);
    return this;
  }

  off(event: string, handler?: (...args: any[]) => void) {
    if (!handler) {
      this.listeners.delete(event);
    } else {
      this.listeners.set(
        event,
        (this.listeners.get(event) || []).filter(h => h !== handler)
      );
    }
    return this;
  }

  emit(event: string, ...args: any[]) {
    (this.listeners.get(event) || []).slice().forEach(h => h(...args));
    return this;
  }

  listenerCount(event: string): number {
    return (this.listeners.get(event) || []).length;
  }
}

const mockSocketState: { socket: FakeSocket | null } = { socket: null };

jest.mock('../contexts/SocketContext', () => ({
  useMainSocket: () => ({
    socket: mockSocketState.socket,
    connected: true,
    error: null,
  }),
}));

const emptyConnectionData = {
  totalConnections: 0,
  connections: [],
  sessions: [],
  uniqueViewers: 0,
  activeSessions: 0,
  streamStatus: {
    hasActiveStream: false,
    streamerId: null,
    streamType: null,
    viewerCount: 0,
    streamStartTime: null,
    streamDuration: 0,
  },
};

describe('ConnectionMonitor socket cleanup (C4)', () => {
  beforeEach(() => {
    mockSocketState.socket = new FakeSocket();
  });

  it('removes only its own listeners on unmount — other components\' stream-started/stream-ended handlers survive', async () => {
    const socket = mockSocketState.socket!;

    // Sentinels standing in for other components' handlers on the SHARED
    // main socket (e.g. useStreamSocketListeners, WebRTCViewer).
    const sentinelStarted = jest.fn();
    const sentinelEnded = jest.fn();
    socket.on('stream-started', sentinelStarted);
    socket.on('stream-ended', sentinelEnded);

    const makeApiCall = jest.fn().mockResolvedValue(emptyConnectionData);
    const { unmount } = render(
      <ConnectionMonitor makeApiCall={makeApiCall} addLog={jest.fn()} />
    );

    // Wait for the initial fetch to settle and the component to register its
    // own listeners.
    await waitFor(() => expect(makeApiCall).toHaveBeenCalled());
    await screen.findByText('🔌 Connections Manager');
    expect(socket.listenerCount('stream-started')).toBe(2);
    expect(socket.listenerCount('stream-ended')).toBe(2);

    unmount();

    // Only the component's own listeners are gone; sentinels remain wired.
    expect(socket.listenerCount('stream-started')).toBe(1);
    expect(socket.listenerCount('stream-ended')).toBe(1);
    expect(socket.listenerCount('user-connected')).toBe(0);
    expect(socket.listenerCount('user-disconnected')).toBe(0);

    socket.emit('stream-started', { streamerId: 'x' });
    socket.emit('stream-ended', {});
    expect(sentinelStarted).toHaveBeenCalledTimes(1);
    expect(sentinelEnded).toHaveBeenCalledTimes(1);
  });

  it('reacts to stream events while mounted (its own listeners still work)', async () => {
    const makeApiCall = jest.fn().mockResolvedValue(emptyConnectionData);
    const addLog = jest.fn();
    render(<ConnectionMonitor makeApiCall={makeApiCall} addLog={addLog} />);

    await screen.findByText('🔌 Connections Manager');
    const callsBefore = makeApiCall.mock.calls.length;

    mockSocketState.socket!.emit('stream-started', { streamerId: 'x' });

    expect(addLog).toHaveBeenCalledWith('Stream started');
    await waitFor(() =>
      expect(makeApiCall.mock.calls.length).toBeGreaterThan(callsBefore)
    );
  });
});
