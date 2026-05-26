import { renderHook, act } from '@testing-library/react';
import { EventEmitter } from 'events';
import type { Socket } from 'socket.io-client';
import { useStreamGenerationGuard } from '../useStreamGenerationGuard';

// PR 2.5b — drop-by-streamGeneration replaces the 10-second
// takeoverTargetRef lock that used to gate stream-status arrivals in
// App.tsx. The guard is the testable unit; the App.tsx integration
// just calls the function on every payload.
//
// The 10s lock paper-clipped over the cross-channel ordering problem
// the server-side counter (StreamService.streamGeneration) actually
// solves. This test pins:
//   1. Initial state accepts the first emit (counter starts at -1
//      internally; server starts at 0, so 0 < -1 is false → accept).
//   2. Equal or higher counters are accepted.
//   3. Strictly older counters are dropped.
//   4. Missing counter is accepted (back-compat with older servers /
//      partial emit sites that don't yet thread the counter).
//   5. Socket `connect` event resets the high-water mark to -1, so a
//      server restart (which rewinds StreamService.streamGeneration
//      to 0) doesn't lock the client out forever.

function makeMockSocket() {
  const ee = new EventEmitter() as any;
  // socket.io-client's `socket.on` returns the socket for chaining;
  // EventEmitter's returns the emitter, which is close enough for these
  // tests since we don't chain.
  ee.on = ee.addListener.bind(ee);
  ee.off = ee.removeListener.bind(ee);
  return ee as unknown as Socket;
}

describe('useStreamGenerationGuard (PR 2.5b)', () => {
  it('accepts the first emit (server starts at 0, internal lastSeen at -1)', () => {
    const socket = makeMockSocket();
    const { result } = renderHook(() => useStreamGenerationGuard(socket));

    expect(result.current(0)).toBe(true);
  });

  it('accepts equal-counter emits (same generation, fresh data)', () => {
    const socket = makeMockSocket();
    const { result } = renderHook(() => useStreamGenerationGuard(socket));

    expect(result.current(5)).toBe(true);
    expect(result.current(5)).toBe(true);
    expect(result.current(5)).toBe(true);
  });

  it('accepts strictly-higher counters and advances the high-water mark', () => {
    const socket = makeMockSocket();
    const { result } = renderHook(() => useStreamGenerationGuard(socket));

    expect(result.current(1)).toBe(true);
    expect(result.current(2)).toBe(true);
    expect(result.current(7)).toBe(true);
    expect(result.current(8)).toBe(true);
  });

  it('drops strictly-lower counters (the headline behavior)', () => {
    const socket = makeMockSocket();
    const { result } = renderHook(() => useStreamGenerationGuard(socket));

    expect(result.current(5)).toBe(true);
    expect(result.current(3)).toBe(false); // older — stale
    expect(result.current(4)).toBe(false); // older — stale
    expect(result.current(5)).toBe(true);  // catches back up
    expect(result.current(6)).toBe(true);  // proceeds
  });

  it('accepts payloads with no streamGeneration (back-compat)', () => {
    const socket = makeMockSocket();
    const { result } = renderHook(() => useStreamGenerationGuard(socket));

    expect(result.current(undefined)).toBe(true);
    expect(result.current(5)).toBe(true);
    // After establishing lastSeen=5, an undefined counter must still
    // be accepted — we can't reason about ordering without it, and the
    // older-server back-compat case should not silently drop updates.
    expect(result.current(undefined)).toBe(true);
    // But a known-older counter is still dropped.
    expect(result.current(3)).toBe(false);
  });

  it('resets the high-water mark on socket connect (server-restart case)', () => {
    const socket = makeMockSocket();
    const { result } = renderHook(() => useStreamGenerationGuard(socket));

    // Establish a high counter.
    expect(result.current(10)).toBe(true);
    expect(result.current(5)).toBe(false); // older — dropped

    // Simulate a socket reconnect after the server has restarted (and
    // its StreamService.streamGeneration has rewound to 0).
    act(() => {
      (socket as any).emit('connect');
    });

    // Without the reset, generation 0 would be dropped (0 < 10). With
    // the reset, it's the first emit of a fresh run — accepted.
    expect(result.current(0)).toBe(true);
    expect(result.current(1)).toBe(true);
  });

  it('unbinds the connect listener on unmount (no leak)', () => {
    const socket = makeMockSocket();
    const { unmount } = renderHook(() => useStreamGenerationGuard(socket));

    expect((socket as unknown as EventEmitter).listenerCount('connect')).toBe(1);
    unmount();
    expect((socket as unknown as EventEmitter).listenerCount('connect')).toBe(0);
  });

  it('returns a stable function reference across renders (safe as effect dep)', () => {
    // App.tsx passes the returned function into the stream-status
    // useEffect's dep array. If the reference churned on every render,
    // the socket listener would tear down and re-register on every
    // App re-render — burning the lastSeen high-water mark on the
    // way. Pin that the callback is memoized.
    const socket = makeMockSocket();
    const { result, rerender } = renderHook(() => useStreamGenerationGuard(socket));

    const first = result.current;
    rerender();
    rerender();
    expect(result.current).toBe(first);
  });

  it('tolerates a null socket (no-op, callback still works)', () => {
    const { result } = renderHook(() => useStreamGenerationGuard(null));

    expect(result.current(0)).toBe(true);
    expect(result.current(5)).toBe(true);
    expect(result.current(3)).toBe(false);
  });
});
