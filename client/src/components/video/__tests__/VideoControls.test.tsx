import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import VideoControls from '../VideoControls';

/**
 * Helper to build a mock videoRef whose .current.parentElement has
 * spyable fullscreen-request methods.
 */
function buildVideoRef(): {
  ref: React.RefObject<HTMLVideoElement | null>;
  requestFullscreen: jest.Mock;
  parentElement: HTMLElement;
} {
  const requestFullscreen = jest.fn().mockResolvedValue(undefined);
  const parentElement: any = { requestFullscreen };
  const video: any = { parentElement };
  return {
    ref: { current: video },
    requestFullscreen,
    parentElement,
  };
}

describe('VideoControls', () => {
  const baseProps = {
    showControls: true,
    volume: 0.5,
    isPaused: false,
    onTogglePause: jest.fn(),
    onVolumeChange: jest.fn(),
    onMouseMove: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset fullscreen-API surface on document between tests.
    (document as any).fullscreenElement = null;
    (document as any).webkitFullscreenElement = null;
    (document as any).mozFullScreenElement = null;
    (document as any).msFullscreenElement = null;
    (document as any).exitFullscreen = jest.fn().mockResolvedValue(undefined);
  });

  test('renders pause button and volume slider when showControls=true', () => {
    const { ref } = buildVideoRef();
    render(<VideoControls {...baseProps} videoRef={ref} />);

    // Pause icon shown because isPaused=false → ⏸️
    expect(screen.getByText('⏸️')).toBeInTheDocument();
    // Volume slider (the only range input)
    const slider = screen.getByRole('slider');
    expect(slider).toBeInTheDocument();
    expect((slider as HTMLInputElement).value).toBe('0.5');
    // LIVE indicator
    expect(screen.getByText('LIVE')).toBeInTheDocument();
  });

  test('renders nothing (returns null) when showControls=false', () => {
    const { ref } = buildVideoRef();
    const { container } = render(
      <VideoControls {...baseProps} videoRef={ref} showControls={false} />
    );
    expect(container.firstChild).toBeNull();
  });

  test('volume slider change calls onVolumeChange with parsed float', () => {
    const { ref } = buildVideoRef();
    const onVolumeChange = jest.fn();
    render(
      <VideoControls {...baseProps} videoRef={ref} onVolumeChange={onVolumeChange} />
    );

    const slider = screen.getByRole('slider') as HTMLInputElement;
    fireEvent.change(slider, { target: { value: '0.8' } });

    expect(onVolumeChange).toHaveBeenCalledWith(0.8);
  });

  test('pause click calls onTogglePause', () => {
    const { ref } = buildVideoRef();
    const onTogglePause = jest.fn();
    render(
      <VideoControls {...baseProps} videoRef={ref} onTogglePause={onTogglePause} />
    );

    fireEvent.click(screen.getByText('⏸️'));
    expect(onTogglePause).toHaveBeenCalledTimes(1);
  });

  test('mute toggle button calls onVolumeChange(0) when volume>0', () => {
    const { ref } = buildVideoRef();
    const onVolumeChange = jest.fn();
    render(
      <VideoControls
        {...baseProps}
        videoRef={ref}
        volume={0.5}
        onVolumeChange={onVolumeChange}
      />
    );

    // volume=0.5 → 🔊 icon (volume >= 0.5)
    fireEvent.click(screen.getByText('🔊'));
    expect(onVolumeChange).toHaveBeenCalledWith(0);
  });

  test('fullscreen click calls videoRef.current.parentElement.requestFullscreen', async () => {
    const { ref, requestFullscreen } = buildVideoRef();
    render(<VideoControls {...baseProps} videoRef={ref} />);

    // Fullscreen button shows ⊞ when not in fullscreen
    await act(async () => {
      fireEvent.click(screen.getByText('⊞'));
    });

    expect(requestFullscreen).toHaveBeenCalledTimes(1);
  });

  test('fullscreenchange event updates isFullscreen state (icon toggles to ⊡)', () => {
    const { ref } = buildVideoRef();
    render(<VideoControls {...baseProps} videoRef={ref} />);

    expect(screen.getByText('⊞')).toBeInTheDocument();

    act(() => {
      (document as any).fullscreenElement = { tagName: 'DIV' };
      document.dispatchEvent(new Event('fullscreenchange'));
    });

    expect(screen.getByText('⊡')).toBeInTheDocument();
  });

  test('cleanup on unmount removes all 4 vendor-prefixed fullscreenchange listeners', () => {
    const { ref } = buildVideoRef();
    const removeSpy = jest.spyOn(document, 'removeEventListener');

    const { unmount } = render(<VideoControls {...baseProps} videoRef={ref} />);
    unmount();

    const eventNames = removeSpy.mock.calls.map((c) => c[0]);
    expect(eventNames).toEqual(
      expect.arrayContaining([
        'fullscreenchange',
        'webkitfullscreenchange',
        'mozfullscreenchange',
        'MSFullscreenChange',
      ])
    );

    removeSpy.mockRestore();
  });

  test('onMouseMove fires when mouse moves over the controls container', () => {
    const { ref } = buildVideoRef();
    const onMouseMove = jest.fn();
    render(
      <VideoControls {...baseProps} videoRef={ref} onMouseMove={onMouseMove} />
    );

    // The container wraps the LIVE indicator; bubble from there.
    fireEvent.mouseMove(screen.getByText('LIVE'));
    expect(onMouseMove).toHaveBeenCalled();
  });
});
