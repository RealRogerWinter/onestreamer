import { renderHook, act } from '@testing-library/react';
import { EventEmitter } from 'events';
import type { Socket } from 'socket.io-client';
import { useStreamState, UseStreamStateOptions } from '../useStreamState';

// Characterization test for useStreamState — pins the CURRENT observable
// behavior of the hook (initial returned shape, socket-event-driven state
// transitions, derived takeover/transition overlays, cooldown timer, and
// listener cleanup on unmount) before decomposing it into sub-hooks.
//
// The hook calls `socket.emit('join-as-viewer')` on bind and registers a
// pile of `socket.on(...)` listeners. We model the socket as a Node
// EventEmitter so we can drive those handlers by emitting events, and use
// fake timers to pin the setTimeout/setInterval-gated transitions.

function makeMockSocket(id = 'my-socket-id') {
  const ee = new EventEmitter() as any;
  ee.setMaxListeners(0);
  // socket.io-client's on/off return the socket; EventEmitter returns the
  // emitter. We don't chain, so the difference is immaterial here.
  ee.on = ee.addListener.bind(ee);
  // socket.io-client's `socket.off(event)` (no handler) removes ALL
  // listeners for that event; the hook's cleanup relies on that form.
  // Node's EventEmitter.removeListener requires a handler, so route the
  // single-arg call to removeAllListeners.
  ee.off = (event: string, handler?: (...args: any[]) => void) => {
    if (handler) {
      ee.removeListener(event, handler);
    } else {
      ee.removeAllListeners(event);
    }
    return ee;
  };
  ee.id = id;
  const emitted: Array<{ event: string; args: any[] }> = [];
  const realEmit = ee.emit.bind(ee);
  ee.emit = (event: string, ...args: any[]) => {
    emitted.push({ event, args });
    return realEmit(event, ...args);
  };
  ee.__emitted = emitted;
  return ee as unknown as Socket & { __emitted: Array<{ event: string; args: any[] }> };
}

function render(opts: Partial<UseStreamStateOptions> & { socket: Socket | null }) {
  const fullOpts: UseStreamStateOptions = {
    socket: opts.socket,
    connected: opts.connected ?? true,
    onError: opts.onError,
    onClearError: opts.onClearError,
  };
  return renderHook((p: UseStreamStateOptions) => useStreamState(p), {
    initialProps: fullOpts,
  });
}

describe('useStreamState (characterization)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('returns the pinned initial shape and values', () => {
    const socket = makeMockSocket();
    const { result } = render({ socket });

    expect(result.current.isStreaming).toBe(false);
    expect(result.current.cooldownRemaining).toBe(0);
    expect(result.current.wasStreamingBeforeTakeover).toBe(false);
    expect(result.current.forceViewerAfterTakeover).toBe(false);
    expect(result.current.showTakeoverOverlay).toBe(false);
    expect(result.current.takeoverMessage).toBe('');
    expect(result.current.showTransitionOverlay).toBe(false);
    expect(result.current.transitionMessage).toBe('');
    expect(result.current.disconnectionReason).toBeNull();
    expect(result.current.isForceDisconnected).toBe(false);
    expect(result.current.streamerBuffs).toEqual([]);
    expect(result.current.streamStatus).toEqual({
      hasActiveStream: false,
      streamerId: null,
      streamType: null,
      viewerCount: 0,
      streamStartTime: null,
      streamDuration: 0,
    });
    // Setters are exposed for App.tsx's stream-status listener.
    expect(typeof result.current.setIsStreaming).toBe('function');
    expect(typeof result.current.setStreamStatus).toBe('function');
    expect(typeof result.current.setWasStreamingBeforeTakeover).toBe('function');
  });

  it('emits join-as-viewer when the socket is bound', () => {
    const socket = makeMockSocket();
    render({ socket });
    const joins = (socket as any).__emitted.filter((e: any) => e.event === 'join-as-viewer');
    expect(joins.length).toBeGreaterThanOrEqual(1);
  });

  it('updates streamStatus on stream-started for another streamer', () => {
    const socket = makeMockSocket();
    const { result } = render({ socket });

    act(() => {
      (socket as any).emit('stream-started', {
        streamerId: 'other-id',
        streamType: 'webrtc',
        streamStartTime: 123456,
        streamerDisplayName: 'Alice',
      });
    });

    expect(result.current.streamStatus.hasActiveStream).toBe(true);
    expect(result.current.streamStatus.streamerId).toBe('other-id');
    expect(result.current.streamStatus.streamType).toBe('webrtc');
    expect(result.current.streamStatus.streamStartTime).toBe(123456);
    expect(result.current.streamStatus.streamerDisplayName).toBe('Alice');
    // We weren't streaming, so no takeover overlay.
    expect(result.current.wasStreamingBeforeTakeover).toBe(false);
    expect(result.current.showTakeoverOverlay).toBe(false);
  });

  it('updates viewerCount on viewer-count-update', () => {
    const socket = makeMockSocket();
    const { result } = render({ socket });

    act(() => {
      (socket as any).emit('viewer-count-update', 42);
    });
    expect(result.current.streamStatus.viewerCount).toBe(42);
  });

  it('updates display name and rotation flags on new-streamer', () => {
    const socket = makeMockSocket();
    const { result } = render({ socket });

    act(() => {
      (socket as any).emit('new-streamer', {
        streamer: {
          odyseeId: 'ody-1',
          odysee_username: 'Bob',
          isRandomRotation: true,
          platform: 'twitch',
        },
      });
    });

    expect(result.current.streamStatus.hasActiveStream).toBe(true);
    expect(result.current.streamStatus.streamerId).toBe('ody-1');
    expect(result.current.streamStatus.streamerDisplayName).toBe('Bob');
    expect(result.current.streamStatus.isRandomRotation).toBe(true);
    expect(result.current.streamStatus.randomRotationPlatform).toBe('twitch');
  });

  it('populates rotation metadata on random-rotation-status (enabled)', () => {
    const socket = makeMockSocket();
    const { result } = render({ socket });

    act(() => {
      (socket as any).emit('random-rotation-status', {
        enabled: true,
        currentStream: {
          displayName: 'Carol',
          platform: 'kick',
          streamerUsername: 'carol_k',
          url: 'https://kick.com/carol_k',
          game: 'Chess',
          viewers: 99,
          startedAt: 1000,
        },
      });
    });

    expect(result.current.streamStatus.isRandomRotation).toBe(true);
    expect(result.current.streamStatus.randomRotationPlatform).toBe('kick');
    expect(result.current.streamStatus.randomRotationStreamerUrl).toBe('https://kick.com/carol_k');
    expect(result.current.streamStatus.randomRotationStreamerUsername).toBe('carol_k');
    expect(result.current.streamStatus.randomRotationGame).toBe('Chess');
    expect(result.current.streamStatus.randomRotationViewers).toBe(99);
    expect(result.current.streamStatus.streamerDisplayName).toBe('Carol');
  });

  it('clears rotation metadata on random-rotation-status (disabled)', () => {
    const socket = makeMockSocket();
    const { result } = render({ socket });

    act(() => {
      (socket as any).emit('random-rotation-status', {
        enabled: true,
        currentStream: {
          displayName: 'Carol',
          platform: 'kick',
          streamerUsername: 'carol_k',
          url: 'u',
        },
      });
    });
    expect(result.current.streamStatus.isRandomRotation).toBe(true);

    act(() => {
      (socket as any).emit('random-rotation-status', { enabled: false });
    });
    expect(result.current.streamStatus.isRandomRotation).toBe(false);
    expect(result.current.streamStatus.randomRotationPlatform).toBeNull();
    expect(result.current.streamStatus.nextRotationAt).toBeNull();
  });

  it('sets rotation lock state on rotation-locked and rotation-unlocked', () => {
    const socket = makeMockSocket();
    const { result } = render({ socket });

    act(() => {
      (socket as any).emit('rotation-locked', { locked: true, remainingMs: 30000 });
    });
    expect(result.current.streamStatus.isRotationLocked).toBe(true);
    expect(result.current.streamStatus.lockedRemainingMs).toBe(30000);

    act(() => {
      (socket as any).emit('rotation-unlocked', {
        locked: false,
        remainingMs: 0,
        nextRotationAt: 5000,
      });
    });
    expect(result.current.streamStatus.isRotationLocked).toBe(false);
    expect(result.current.streamStatus.lockedRemainingMs).toBeNull();
    expect(result.current.streamStatus.nextRotationAt).toBe(5000);
  });

  it('starts the cooldown countdown on global-cooldown and decrements each second', () => {
    const socket = makeMockSocket();
    const { result } = render({ socket });

    act(() => {
      (socket as any).emit('global-cooldown', { cooldownRemaining: 3 });
    });
    expect(result.current.cooldownRemaining).toBe(3);

    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(result.current.cooldownRemaining).toBe(2);

    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(result.current.cooldownRemaining).toBe(0);
  });

  it('sets streaming + transition overlay on streaming-approved and clears it after 2s', () => {
    const socket = makeMockSocket();
    const onClearError = jest.fn();
    const { result } = render({ socket, onClearError });

    act(() => {
      (socket as any).emit('streaming-approved');
    });
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.showTransitionOverlay).toBe(true);
    expect(result.current.transitionMessage).toBe('Starting your stream...');
    expect(onClearError).toHaveBeenCalledTimes(1);

    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(result.current.showTransitionOverlay).toBe(false);
  });

  it('fires onError and starts cooldown on takeover-denied', () => {
    const socket = makeMockSocket();
    const onError = jest.fn();
    const { result } = render({ socket, onError });

    act(() => {
      (socket as any).emit('takeover-denied', { reason: 'Too soon', cooldownRemaining: 5 });
    });
    expect(onError).toHaveBeenCalledWith('Too soon');
    expect(result.current.cooldownRemaining).toBe(5);
  });

  it('updates streamerBuffs on streamer-buffs-update', () => {
    const socket = makeMockSocket();
    const { result } = render({ socket });

    act(() => {
      (socket as any).emit('streamer-buffs-update', { buffs: [{ id: 'b1' }, { id: 'b2' }] });
    });
    expect(result.current.streamerBuffs).toEqual([{ id: 'b1' }, { id: 'b2' }]);
  });

  it('drives the takeover transition on stream-takeover while streaming', () => {
    const socket = makeMockSocket();
    const { result } = render({ socket });

    // Become the active streamer first.
    act(() => {
      (socket as any).emit('streaming-approved');
    });
    expect(result.current.isStreaming).toBe(true);

    act(() => {
      (socket as any).emit('stream-takeover', {
        newStreamerId: 'taker-id',
        newStreamerDisplayName: 'Dave',
        cooldownRemaining: 10,
      });
    });

    expect(result.current.isStreaming).toBe(false);
    expect(result.current.forceViewerAfterTakeover).toBe(true);
    expect(result.current.showTakeoverOverlay).toBe(true);
    expect(result.current.takeoverMessage).toBe('Your stream is being taken over!');
    expect(result.current.streamStatus.streamerId).toBe('taker-id');
    expect(result.current.streamStatus.streamerDisplayName).toBe('Dave');
    expect(result.current.cooldownRemaining).toBe(10);
  });

  it('shows the connection-lost overlay when an active streamer disconnects', () => {
    const socket = makeMockSocket();
    const { result, rerender } = render({ socket, connected: true });

    act(() => {
      (socket as any).emit('streaming-approved');
    });
    expect(result.current.isStreaming).toBe(true);

    act(() => {
      rerender({ socket, connected: false } as UseStreamStateOptions);
    });

    expect(result.current.isStreaming).toBe(false);
    expect(result.current.isForceDisconnected).toBe(true);
    expect(result.current.showTakeoverOverlay).toBe(true);
    expect(result.current.takeoverMessage).toBe('⚠️ Connection Lost!');
  });

  it('unregisters all socket listeners on unmount (no leak)', () => {
    const socket = makeMockSocket();
    const ee = socket as unknown as EventEmitter;
    const { unmount } = render({ socket });

    const events = [
      'connect',
      'stream-started',
      'stream-ended',
      'viewer-count-update',
      'new-streamer',
      'random-rotation-status',
      'rotation-timing',
      'rotation-extended',
      'rotation-reduced',
      'rotation-locked',
      'rotation-unlocked',
      'global-cooldown',
      'cooldown-status-update',
      'streaming-approved',
      'takeover-approved',
      'takeover-denied',
      'takeover-blocked',
      'streamer-buffs-update',
      'force-disconnect',
      'stream-takeover',
    ];
    events.forEach((evt) => {
      expect(ee.listenerCount(evt)).toBeGreaterThanOrEqual(1);
    });

    unmount();

    events.forEach((evt) => {
      expect(ee.listenerCount(evt)).toBe(0);
    });
  });

  it('is a no-op with a null socket and still returns the initial shape', () => {
    const { result } = render({ socket: null });
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.streamStatus.hasActiveStream).toBe(false);
    expect(result.current.cooldownRemaining).toBe(0);
  });
});
