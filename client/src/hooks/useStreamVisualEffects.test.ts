import { renderHook, act } from '@testing-library/react';
import { useStreamVisualEffects } from './useStreamVisualEffects';

/** Minimal socket double that lets the test fire `visual-effect-applied`. */
function makeMockSocket() {
  const handlers: Record<string, (data: any) => void> = {};
  return {
    on: jest.fn((event: string, cb: (data: any) => void) => { handlers[event] = cb; }),
    off: jest.fn((event: string) => { delete handlers[event]; }),
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
});
