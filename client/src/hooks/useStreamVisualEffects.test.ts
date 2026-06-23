import { renderHook, act } from '@testing-library/react';
import { useStreamVisualEffects } from './useStreamVisualEffects';

/** Minimal socket double that lets the test fire server events. */
function makeMockSocket() {
  const handlers: Record<string, (data: any) => void> = {};
  return {
    on: jest.fn((event: string, cb: (data: any) => void) => { handlers[event] = cb; }),
    off: jest.fn((event: string) => { delete handlers[event]; }),
    emit: jest.fn(),
    fire: (event: string, data: any) => handlers[event]?.(data),
  } as any;
}

describe('useStreamVisualEffects', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('starts with no effect style', () => {
    const { result } = renderHook(() => useStreamVisualEffects(makeMockSocket()));
    expect(result.current).toEqual({});
  });

  it('maps flip_vertical (upside down) to a scaleY(-1) transform', () => {
    const socket = makeMockSocket();
    const { result } = renderHook(() => useStreamVisualEffects(socket));

    act(() => socket.fire('visual-effect-applied', { effectId: 'flip_vertical', durationSeconds: 20 }));

    expect(result.current.transform).toBe('scaleY(-1)');
    expect(result.current.filter).toBeUndefined();
  });

  it('maps grayscale to a filter and clears it once the duration elapses', () => {
    const socket = makeMockSocket();
    const { result } = renderHook(() => useStreamVisualEffects(socket));

    act(() => socket.fire('visual-effect-applied', { effectId: 'grayscale', durationSeconds: 5 }));
    expect(result.current.filter).toBe('grayscale(100%)');

    act(() => { jest.advanceTimersByTime(5000); });
    expect(result.current.filter).toBeUndefined();
  });

  it('composes distinct effects and ignores unknown / non-visual ids', () => {
    const socket = makeMockSocket();
    const { result } = renderHook(() => useStreamVisualEffects(socket));

    act(() => socket.fire('visual-effect-applied', { effectId: 'mirror', durationSeconds: 20 }));
    act(() => socket.fire('visual-effect-applied', { effectId: 'flip_vertical', durationSeconds: 20 }));
    act(() => socket.fire('visual-effect-applied', { effectId: 'audio_pitch_high', durationSeconds: 20 }));

    // mirror + flip compose; the audio effect carries no CSS mapping so is ignored.
    expect(result.current.transform).toBe('scaleX(-1) scaleY(-1)');
  });

  it('refreshes (does not stack) a repeated effect so two upside-downs never cancel out', () => {
    const socket = makeMockSocket();
    const { result } = renderHook(() => useStreamVisualEffects(socket));

    act(() => socket.fire('visual-effect-applied', { effectId: 'flip_vertical', durationSeconds: 5 }));
    // Re-apply 3s in: the timer resets, and the transform stays a single scaleY(-1).
    act(() => {
      jest.advanceTimersByTime(3000);
      socket.fire('visual-effect-applied', { effectId: 'flip_vertical', durationSeconds: 5 });
    });
    expect(result.current.transform).toBe('scaleY(-1)');

    // 3s after the refresh (6s after the first apply) it is still active …
    act(() => { jest.advanceTimersByTime(3000); });
    expect(result.current.transform).toBe('scaleY(-1)');

    // … and clears only once the *refreshed* 5s fully elapses.
    act(() => { jest.advanceTimersByTime(2000); });
    expect(result.current.transform).toBeUndefined();
  });

  it('detaches its listener on unmount', () => {
    const socket = makeMockSocket();
    const { unmount } = renderHook(() => useStreamVisualEffects(socket));
    expect(socket.on).toHaveBeenCalledWith('visual-effect-applied', expect.any(Function));
    unmount();
    expect(socket.off).toHaveBeenCalledWith('visual-effect-applied', expect.any(Function));
  });

  it('requests current streamer buffs on mount (to seed in-progress effects)', () => {
    const socket = makeMockSocket();
    renderHook(() => useStreamVisualEffects(socket));
    expect(socket.emit).toHaveBeenCalledWith('get-streamer-buffs');
    expect(socket.on).toHaveBeenCalledWith('streamer-buffs-update', expect.any(Function));
  });

  it('seeds an in-progress effect from streamer buffs (late-join / reload) for the remaining time', () => {
    const socket = makeMockSocket();
    const { result } = renderHook(() => useStreamVisualEffects(socket));

    // Join while an upside-down debuff is active with 8s left.
    act(() => socket.fire('streamer-buffs-update', {
      buffs: [{ effectData: { effect_type: 'visual_filter', visual_effect: 'flip_vertical' }, remainingSeconds: 8 }],
    }));
    expect(result.current.transform).toBe('scaleY(-1)');

    // It clears when the remaining time elapses.
    act(() => { jest.advanceTimersByTime(8000); });
    expect(result.current.transform).toBeUndefined();
  });

  it('tolerates effectData provided as a JSON string and ignores non-visual buffs', () => {
    const socket = makeMockSocket();
    const { result } = renderHook(() => useStreamVisualEffects(socket));

    act(() => socket.fire('streamer-buffs-update', {
      buffs: [
        { effectData: JSON.stringify({ effect_type: 'visual_filter', visual_effect: 'grayscale' }), remainingSeconds: 10 },
        { effectData: { effect_type: 'bitrate_reduction', visual_effect: 'bitrate_low' }, remainingSeconds: 10 },
      ],
    }));
    expect(result.current.filter).toBe('grayscale(100%)');
  });

  it('seeds only once — periodic streamer-buffs-update broadcasts do not re-seed', () => {
    const socket = makeMockSocket();
    const { result } = renderHook(() => useStreamVisualEffects(socket));

    act(() => socket.fire('streamer-buffs-update', {
      buffs: [{ effectData: { effect_type: 'visual_filter', visual_effect: 'flip_vertical' }, remainingSeconds: 5 }],
    }));
    // Effect expires …
    act(() => { jest.advanceTimersByTime(5000); });
    expect(result.current.transform).toBeUndefined();
    // … and a later periodic broadcast of the same (now-stale) buff must NOT revive it.
    act(() => socket.fire('streamer-buffs-update', {
      buffs: [{ effectData: { effect_type: 'visual_filter', visual_effect: 'flip_vertical' }, remainingSeconds: 5 }],
    }));
    expect(result.current.transform).toBeUndefined();
  });

  // Regression: when the streamer changes (takeover / switch / end) a
  // continuously-connected viewer must NOT keep the previous streamer's CSS
  // filters painted on the new streamer's video. The hook clears effects and
  // re-seeds for the new streamer when currentStreamerId changes.
  it("clears the previous streamer's effect when the streamer changes (no bleed-through)", () => {
    const socket = makeMockSocket();
    const { result, rerender } = renderHook(
      ({ id }) => useStreamVisualEffects(socket, id),
      { initialProps: { id: 'streamer-A' } },
    );

    // Streamer A is upside-down (seeded on join).
    act(() => socket.fire('streamer-buffs-update', {
      buffs: [{ effectData: { effect_type: 'visual_filter', visual_effect: 'flip_vertical' }, remainingSeconds: 30 }],
    }));
    expect(result.current.transform).toBe('scaleY(-1)');

    // Streamer B takes over — A's filter must be gone immediately.
    act(() => rerender({ id: 'streamer-B' }));
    expect(result.current.transform).toBeUndefined();
  });

  it('re-asks the server for the new streamer buffs and re-seeds on a streamer change', () => {
    const socket = makeMockSocket();
    const { result, rerender } = renderHook(
      ({ id }) => useStreamVisualEffects(socket, id),
      { initialProps: { id: 'streamer-A' } },
    );

    act(() => socket.fire('streamer-buffs-update', {
      buffs: [{ effectData: { effect_type: 'visual_filter', visual_effect: 'grayscale' }, remainingSeconds: 10 }],
    }));
    expect(result.current.filter).toBe('grayscale(100%)');

    // Switch to streamer B: A's grayscale clears and the hook re-requests buffs.
    (socket.emit as jest.Mock).mockClear();
    act(() => rerender({ id: 'streamer-B' }));
    expect(result.current.filter).toBeUndefined();
    expect(socket.emit).toHaveBeenCalledWith('get-streamer-buffs');

    // B's OWN in-progress debuff seeds correctly (the one-time guard reset with
    // the streamer change, so this is not blocked).
    act(() => socket.fire('streamer-buffs-update', {
      buffs: [{ effectData: { effect_type: 'visual_filter', visual_effect: 'invert' }, remainingSeconds: 10 }],
    }));
    expect(result.current.filter).toBe('invert(100%)');
  });
});
