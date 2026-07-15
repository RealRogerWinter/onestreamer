import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { Socket } from 'socket.io-client';
import WebRTCStreamer from './WebRTCStreamer';
import { WebRTCClientAdapter } from '../../services/WebRTCClientAdapter';
import { ScreenCaptureService } from '../../services/ScreenCaptureService';
import { AudioMixer } from '../../services/AudioMixer';
import { VideoCompositor } from '../../services/VideoCompositor';

/**
 * Characterization tests for WebRTCStreamer (broadcaster UI).
 *
 * WebRTCStreamer is a MEDIA-HEAVY component: it drives getUserMedia,
 * a WebRTC client adapter, screen capture, an audio mixer and a
 * video compositor. None of that live pipeline is deterministically
 * observable in jsdom, so these tests heavily mock the media layer and PIN
 * only the STABLE, observable UI shell + the wiring contracts the parent
 * controls (service construction, screen-share method exposure, cleanup).
 *
 * These tests must pass on the CURRENT component and survive a conservative
 * decomposition WITHOUT modification.
 */

// --- Mock the media-pipeline service classes (automock) --------------------
// CRA's jest preset reliably applies automock for these classes; we then
// shape the auto-stubbed prototype methods that the component depends on.

jest.mock('../../services/WebRTCClientAdapter');
jest.mock('../../services/ScreenCaptureService');
jest.mock('../../services/AudioMixer');
jest.mock('../../services/VideoCompositor');

const MockedScreenCapture = ScreenCaptureService as jest.MockedClass<typeof ScreenCaptureService>;
const MockedAudioMixer = AudioMixer as jest.MockedClass<typeof AudioMixer>;
const MockedVideoCompositor = VideoCompositor as jest.MockedClass<typeof VideoCompositor>;

// --- Mock child components & hooks (keep render deterministic) --------------

jest.mock('../canvas/CanvasEffectOverlay', () => ({
  __esModule: true,
  default: ({ isActive }: { isActive: boolean }) => (
    <div data-testid="canvas-effect-overlay">overlay:{String(isActive)}</div>
  ),
}));

jest.mock('../audio/AudioLevelMeter', () => ({
  __esModule: true,
  default: () => <div data-testid="audio-level-meter">meter</div>,
}));

const mockViewState = { mode: 'local-preview', activeEffects: [] as string[] };
jest.mock('../../hooks/useStreamerViewManager', () => ({
  useStreamerViewManager: () => ({ viewState: mockViewState }),
}));

// --- Mock the global media stack -------------------------------------------
// NOTE: CRA's jest preset sets `resetMocks: true`, which wipes every mock's
// implementation before each test. So the MediaStream factory implementation
// is (re)applied inside beforeEach, not just here at module load.

const makeFakeStream = () => {
  const videoTracks = [{ kind: 'video', readyState: 'live', stop: jest.fn(), getSettings: () => ({}) }];
  const audioTracks = [{ kind: 'audio', readyState: 'live', stop: jest.fn(), getSettings: () => ({}) }];
  return {
    id: 'stream-id',
    active: true,
    getTracks: () => [...videoTracks, ...audioTracks],
    getVideoTracks: () => videoTracks,
    getAudioTracks: () => audioTracks,
    addTrack: jest.fn(),
    removeTrack: jest.fn(),
  };
};

global.MediaStream = jest.fn().mockImplementation(makeFakeStream) as any;

Object.defineProperty(HTMLVideoElement.prototype, 'play', {
  writable: true,
  value: jest.fn().mockResolvedValue(undefined),
});
Object.defineProperty(HTMLVideoElement.prototype, 'pause', {
  writable: true,
  value: jest.fn(),
});
Object.defineProperty(HTMLVideoElement.prototype, 'load', {
  writable: true,
  value: jest.fn(),
});
// jsdom does not implement srcObject; make it a settable no-op so the
// component's video-element setup does not throw.
Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
  writable: true,
  value: null,
});

const MockedAdapter = WebRTCClientAdapter as jest.MockedClass<typeof WebRTCClientAdapter>;

describe('WebRTCStreamer (characterization)', () => {
  let mockSocket: Partial<Socket>;
  let mockAdapter: any;

  beforeEach(() => {
    localStorage.clear();

    // resetMocks wiped these implementations; re-apply them before each test.
    (global.MediaStream as jest.Mock).mockImplementation(makeFakeStream);

    mockSocket = {
      id: 'socket-id',
      connected: true,
      on: jest.fn(),
      off: jest.fn(),
      emit: jest.fn(),
    };

    mockAdapter = {
      initialize: jest.fn().mockResolvedValue(undefined),
      createSendTransport: jest.fn().mockResolvedValue(undefined),
      produce: jest.fn().mockResolvedValue(undefined),
      stopProducing: jest.fn().mockResolvedValue(undefined),
      cleanup: jest.fn().mockResolvedValue(undefined),
      switchToScreenShare: jest.fn().mockResolvedValue(undefined),
      switchToCamera: jest.fn().mockResolvedValue(undefined),
      replaceAudioTrack: jest.fn().mockResolvedValue(undefined),
      replaceVideoTrack: jest.fn().mockResolvedValue(undefined),
      hasAudioProducer: false,
      hasVideoProducer: false,
    };
    MockedAdapter.mockImplementation(() => mockAdapter);

    (navigator as any).mediaDevices = {
      getUserMedia: jest.fn().mockResolvedValue(new MediaStream()),
      getDisplayMedia: jest.fn().mockResolvedValue(new MediaStream()),
      enumerateDevices: jest.fn().mockResolvedValue([
        { kind: 'audioinput', deviceId: 'mic-1', label: 'Mic 1' },
        { kind: 'videoinput', deviceId: 'cam-1', label: 'Cam 1' },
      ]),
    };

    // Shape the auto-mocked media-service prototypes the component leans on.
    MockedScreenCapture.prototype.getScreenStream.mockResolvedValue(new MediaStream() as any);
    MockedAudioMixer.prototype.getIsActive.mockReturnValue(false);
    MockedAudioMixer.prototype.mix.mockResolvedValue(null as any);
    MockedVideoCompositor.prototype.getIsActive.mockReturnValue(false);
    MockedVideoCompositor.prototype.composite.mockResolvedValue(null as any);
  });

  // --- 1. UI shell while idle ----------------------------------------------

  describe('idle (not streaming)', () => {
    it('renders the root webrtc-streamer container with the custom className', () => {
      const { container } = render(
        <WebRTCStreamer socket={mockSocket as Socket} isStreaming={false} className="my-stage" />
      );
      expect(container.firstChild).toHaveClass('webrtc-streamer', 'my-stage');
    });

    it('shows the idle preview prompt when not streaming', () => {
      render(<WebRTCStreamer socket={mockSocket as Socket} isStreaming={false} />);
      expect(
        screen.getByText('Click "Start Streaming" to begin broadcasting')
      ).toBeInTheDocument();
    });

    it('always renders the local <video> preview element', () => {
      const { container } = render(
        <WebRTCStreamer socket={mockSocket as Socket} isStreaming={false} />
      );
      const video = container.querySelector('video.webrtc-video');
      expect(video).toBeInTheDocument();
      expect(video).toHaveAttribute('autoplay');
      expect(video).toHaveAttribute('playsinline');
    });

    it('does NOT render the canvas effect overlay while idle', () => {
      render(<WebRTCStreamer socket={mockSocket as Socket} isStreaming={false} />);
      expect(screen.queryByTestId('canvas-effect-overlay')).not.toBeInTheDocument();
    });

    it('does NOT construct the WebRTC client adapter while idle', () => {
      render(<WebRTCStreamer socket={mockSocket as Socket} isStreaming={false} />);
      expect(MockedAdapter).not.toHaveBeenCalled();
    });
  });

  // --- 2. UI shell + pipeline wiring while streaming -----------------------

  describe('streaming', () => {
    it('renders the canvas effect overlay when streaming starts', () => {
      render(<WebRTCStreamer socket={mockSocket as Socket} isStreaming={true} />);
      expect(screen.getByTestId('canvas-effect-overlay')).toBeInTheDocument();
    });

    it('does not show the idle preview prompt while streaming', () => {
      render(<WebRTCStreamer socket={mockSocket as Socket} isStreaming={true} />);
      expect(
        screen.queryByText('Click "Start Streaming" to begin broadcasting')
      ).not.toBeInTheDocument();
    });

    it('requests camera + mic via getUserMedia when streaming starts', async () => {
      render(<WebRTCStreamer socket={mockSocket as Socket} isStreaming={true} />);
      await waitFor(() => {
        expect((navigator as any).mediaDevices.getUserMedia).toHaveBeenCalled();
      });
    });

    it('constructs the WebRTC client adapter with the socket when streaming', async () => {
      render(<WebRTCStreamer socket={mockSocket as Socket} isStreaming={true} />);
      await waitFor(
        () => {
          expect(MockedAdapter).toHaveBeenCalled();
        },
        { timeout: 4000 }
      );
      const adapterArg = MockedAdapter.mock.calls[0][0] as any;
      expect(adapterArg.socket).toBeDefined();
      expect(adapterArg.socket.id).toBe('socket-id');
      expect(typeof adapterArg.serverUrl).toBe('string');
    });

    it('fires onStreamStart after the pipeline initializes', async () => {
      const onStreamStart = jest.fn();
      render(
        <WebRTCStreamer
          socket={mockSocket as Socket}
          isStreaming={true}
          onStreamStart={onStreamStart}
        />
      );
      await waitFor(() => expect(onStreamStart).toHaveBeenCalled(), { timeout: 4000 });
    });
  });

  // --- 2b. Publish failure is a stream-start failure (audit Plan 05, C3) ---

  describe('publish failure (C3)', () => {
    it('does NOT fire onStreamStart when produce rejects; surfaces error + retry and cleans up the adapter', async () => {
      mockAdapter.produce.mockRejectedValue(new Error('sfu unreachable'));
      const onStreamStart = jest.fn();
      render(
        <WebRTCStreamer
          socket={mockSocket as Socket}
          isStreaming={true}
          onStreamStart={onStreamStart}
        />
      );

      await waitFor(
        () => expect(screen.getByText(/Failed to publish stream/)).toBeInTheDocument(),
        { timeout: 4000 }
      );
      expect(onStreamStart).not.toHaveBeenCalled();
      expect(mockAdapter.cleanup).toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    });

    it('does NOT fire onStreamStart when createSendTransport rejects', async () => {
      mockAdapter.createSendTransport.mockRejectedValue(new Error('token endpoint down'));
      const onStreamStart = jest.fn();
      render(
        <WebRTCStreamer
          socket={mockSocket as Socket}
          isStreaming={true}
          onStreamStart={onStreamStart}
        />
      );

      await waitFor(
        () => expect(screen.getByText(/Failed to publish stream/)).toBeInTheDocument(),
        { timeout: 4000 }
      );
      expect(onStreamStart).not.toHaveBeenCalled();
      expect(mockAdapter.cleanup).toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    });
  });

  // --- 2c. Mid-stream device change goes through the adapter (C2) ----------

  describe('device change (C2)', () => {
    it('replaces the published audio track via the adapter with a MediaStreamTrack', async () => {
      mockAdapter.hasAudioProducer = true;
      const onStreamStart = jest.fn();
      const baseAudioSettings = {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 48000,
        channelCount: 2,
        profile: 'raw' as const,
        inputDeviceId: undefined,
        outputDeviceId: undefined,
      };

      const { rerender } = render(
        <WebRTCStreamer
          socket={mockSocket as Socket}
          isStreaming={true}
          onStreamStart={onStreamStart}
          audioSettings={baseAudioSettings as any}
        />
      );
      await waitFor(() => expect(onStreamStart).toHaveBeenCalled(), { timeout: 4000 });

      await act(async () => {
        rerender(
          <WebRTCStreamer
            socket={mockSocket as Socket}
            isStreaming={true}
            onStreamStart={onStreamStart}
            audioSettings={{ ...baseAudioSettings, inputDeviceId: 'mic-2' } as any}
          />
        );
      });

      await waitFor(() => expect(mockAdapter.replaceAudioTrack).toHaveBeenCalled());
      const replacementTrack = mockAdapter.replaceAudioTrack.mock.calls[0][0];
      expect(replacementTrack).toBeDefined();
      expect(replacementTrack.kind).toBe('audio');
    });
  });

  // --- 3. Parent control contracts ----------------------------------------

  describe('control contracts', () => {
    it('exposes startScreenShare / stopScreenShare methods to the parent', () => {
      const onScreenShareMethodsReady = jest.fn();
      render(
        <WebRTCStreamer
          socket={mockSocket as Socket}
          isStreaming={false}
          onScreenShareMethodsReady={onScreenShareMethodsReady}
        />
      );
      expect(onScreenShareMethodsReady).toHaveBeenCalledWith(
        expect.objectContaining({
          startScreenShare: expect.any(Function),
          stopScreenShare: expect.any(Function),
        })
      );
    });

    it('tears down the pipeline (onStreamStop) when streaming is turned off', async () => {
      const onStreamStop = jest.fn();
      const { rerender } = render(
        <WebRTCStreamer
          socket={mockSocket as Socket}
          isStreaming={true}
          onStreamStop={onStreamStop}
        />
      );
      await act(async () => {
        rerender(
          <WebRTCStreamer
            socket={mockSocket as Socket}
            isStreaming={false}
            onStreamStop={onStreamStop}
          />
        );
      });
      await waitFor(() => expect(onStreamStop).toHaveBeenCalled());
    });
  });
});
