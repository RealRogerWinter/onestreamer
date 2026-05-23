import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import WebRTCViewer from './WebRTCViewer';
import { MediasoupClient } from '../../services/MediasoupClient';
import { Socket } from 'socket.io-client';

// Mock MediaStream globally
global.MediaStream = jest.fn().mockImplementation(() => ({
  id: 'stream-id',
  active: true,
  getTracks: () => [],
  getVideoTracks: () => [],
  getAudioTracks: () => [],
  addTrack: jest.fn()
})) as any;

// Mock MediasoupClient
jest.mock('../../services/MediasoupClient');
const MockedMediasoupClient = MediasoupClient as jest.MockedClass<typeof MediasoupClient>;

// Mock HTMLVideoElement
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

describe('WebRTCViewer', () => {
  let mockSocket: Partial<Socket>;
  let mockMediasoupClient: jest.Mocked<MediasoupClient>;

  beforeEach(() => {
    mockSocket = {
      id: 'socket-id',
      connected: true,
      on: jest.fn(),
      emit: jest.fn()
    };

    mockMediasoupClient = {
      initialize: jest.fn().mockResolvedValue(undefined),
      createRecvTransport: jest.fn().mockResolvedValue(undefined),
      recreateTransports: jest.fn().mockResolvedValue(undefined),
      consume: jest.fn().mockResolvedValue(new MediaStream()),
      cleanup: jest.fn().mockResolvedValue(undefined),
      forceReconnection: jest.fn().mockResolvedValue(undefined),
      get connectionState() { return this._connectionState || 'connected'; },
      set connectionState(value) { this._connectionState = value; },
      get reconnectionInfo() { return this._reconnectionInfo || { attempts: 0, maxAttempts: 5, isReconnecting: false }; },
      set reconnectionInfo(value) { this._reconnectionInfo = value; },
      _connectionState: 'connected',
      _reconnectionInfo: { attempts: 0, maxAttempts: 5, isReconnecting: false }
    } as any;

    MockedMediasoupClient.mockImplementation(() => mockMediasoupClient);

    // Clear all mocks before each test
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('rendering', () => {
    it('should render loading state initially', () => {
      render(<WebRTCViewer socket={mockSocket as Socket} isActive={true} />);
      
      expect(screen.getByText('Connecting to stream...')).toBeInTheDocument();
    });

    it('should render waiting state when inactive', () => {
      render(<WebRTCViewer socket={mockSocket as Socket} isActive={false} />);
      
      expect(screen.getByText('Waiting for stream...')).toBeInTheDocument();
    });

    it('should apply custom className', () => {
      const { container } = render(
        <WebRTCViewer socket={mockSocket as Socket} isActive={true} className="custom-class" />
      );
      
      expect(container.firstChild).toHaveClass('webrtc-viewer', 'custom-class');
    });
  });

  describe('initialization', () => {
    it('should initialize MediasoupClient when active', async () => {
      render(<WebRTCViewer socket={mockSocket as Socket} isActive={true} />);

      await waitFor(() => {
        expect(MockedMediasoupClient).toHaveBeenCalledWith({
          socket: mockSocket,
          onConnectionLost: expect.any(Function),
          onConnectionRecovered: expect.any(Function),
          onReconnectionFailed: expect.any(Function)
        });
      });

      expect(mockMediasoupClient.initialize).toHaveBeenCalled();
      expect(mockMediasoupClient.createRecvTransport).toHaveBeenCalled();
      expect(mockMediasoupClient.consume).toHaveBeenCalled();
    });

    it('should not initialize when socket is disconnected', () => {
      mockSocket.connected = false;
      render(<WebRTCViewer socket={mockSocket as Socket} isActive={true} />);

      expect(MockedMediasoupClient).not.toHaveBeenCalled();
    });

    it('should handle initialization timeout', async () => {
      jest.useFakeTimers();
      render(<WebRTCViewer socket={mockSocket as Socket} isActive={true} />);

      // Fast-forward past the debounce timeout
      act(() => {
        jest.advanceTimersByTime(100);
      });

      await waitFor(() => {
        expect(MockedMediasoupClient).toHaveBeenCalled();
      });
    });

    it('should debounce rapid active state changes', async () => {
      jest.useFakeTimers();
      const { rerender } = render(<WebRTCViewer socket={mockSocket as Socket} isActive={false} />);

      // Rapid changes
      rerender(<WebRTCViewer socket={mockSocket as Socket} isActive={true} />);
      rerender(<WebRTCViewer socket={mockSocket as Socket} isActive={false} />);
      rerender(<WebRTCViewer socket={mockSocket as Socket} isActive={true} />);

      // Should only initialize once after debounce
      act(() => {
        jest.advanceTimersByTime(100);
      });

      await waitFor(() => {
        expect(MockedMediasoupClient).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('video playback', () => {
    let mockVideo: HTMLVideoElement;

    beforeEach(async () => {
      const { container } = render(<WebRTCViewer socket={mockSocket as Socket} isActive={true} />);
      mockVideo = container.querySelector('video')!;

      // Wait for initialization
      await waitFor(() => {
        expect(mockMediasoupClient.consume).toHaveBeenCalled();
      });
    });

    it('should attempt video playback after stream is set', async () => {
      await waitFor(() => {
        expect(mockVideo.play).toHaveBeenCalled();
      });
    });

    it('should handle auto-play success', async () => {
      (mockVideo.play as jest.Mock).mockResolvedValue(undefined);

      await waitFor(() => {
        expect(screen.queryByText('Click to play stream')).not.toBeInTheDocument();
      });
    });

    it('should handle auto-play blocked by browser', async () => {
      (mockVideo.play as jest.Mock).mockRejectedValue(
        Object.assign(new Error('NotAllowedError'), { name: 'NotAllowedError' })
      );

      render(<WebRTCViewer socket={mockSocket as Socket} isActive={true} />);

      await waitFor(() => {
        expect(screen.getByText('Click to play stream')).toBeInTheDocument();
      });
    });

    it('should retry playback on AbortError', async () => {
      jest.useFakeTimers();
      (mockVideo.play as jest.Mock)
        .mockRejectedValueOnce(Object.assign(new Error('AbortError'), { name: 'AbortError' }))
        .mockResolvedValueOnce(undefined);

      render(<WebRTCViewer socket={mockSocket as Socket} isActive={true} />);

      act(() => {
        jest.advanceTimersByTime(500); // Fast-forward retry delay
      });

      await waitFor(() => {
        expect(mockVideo.play).toHaveBeenCalledTimes(2);
      });
    });

    it('should show manual play button when auto-play fails', async () => {
      (mockVideo.play as jest.Mock).mockRejectedValue(
        Object.assign(new Error('NotAllowedError'), { name: 'NotAllowedError' })
      );

      render(<WebRTCViewer socket={mockSocket as Socket} isActive={true} />);

      await waitFor(() => {
        expect(screen.getByText('Click to play stream')).toBeInTheDocument();
      });

      const playOverlay = screen.getByText('Click to play stream').closest('div')!;
      fireEvent.click(playOverlay);

      expect(mockVideo.play).toHaveBeenCalledTimes(2); // Initial attempt + manual click
    });

    it('should handle video click when paused', async () => {
      Object.defineProperty(mockVideo, 'paused', { value: true });

      await waitFor(() => {
        expect(mockMediasoupClient.consume).toHaveBeenCalled();
      });

      fireEvent.click(mockVideo);

      expect(mockVideo.play).toHaveBeenCalled();
    });
  });

  describe('connection recovery', () => {
    let onConnectionLost: () => void;
    let onConnectionRecovered: () => void;
    let onReconnectionFailed: (error: Error) => void;

    beforeEach(async () => {
      render(<WebRTCViewer socket={mockSocket as Socket} isActive={true} />);

      await waitFor(() => {
        expect(MockedMediasoupClient).toHaveBeenCalled();
      });

      // Extract the callbacks
      const constructorCall = MockedMediasoupClient.mock.calls[0][0];
      onConnectionLost = constructorCall.onConnectionLost!;
      onConnectionRecovered = constructorCall.onConnectionRecovered!;
      onReconnectionFailed = constructorCall.onReconnectionFailed!;
    });

    it('should handle connection lost', async () => {
      act(() => {
        onConnectionLost();
      });

      await waitFor(() => {
        expect(screen.getByText('Connection lost - attempting recovery...')).toBeInTheDocument();
      });
    });

    it('should handle connection recovered', async () => {
      act(() => {
        onConnectionLost();
      });

      await waitFor(() => {
        expect(screen.getByText('Connection lost - attempting recovery...')).toBeInTheDocument();
      });

      act(() => {
        onConnectionRecovered();
      });

      await waitFor(() => {
        expect(screen.queryByText('Connection lost - attempting recovery...')).not.toBeInTheDocument();
      });
    });

    it('should handle reconnection failed', async () => {
      const error = new Error('Max reconnection attempts reached');

      act(() => {
        onReconnectionFailed(error);
      });

      await waitFor(() => {
        expect(screen.getByText('Connection failed: Max reconnection attempts reached')).toBeInTheDocument();
      });
    });

    it('should show reconnecting overlay', async () => {
      (mockMediasoupClient as any)._connectionState = 'reconnecting';
      (mockMediasoupClient as any)._reconnectionInfo = { attempts: 2, maxAttempts: 5, isReconnecting: true };

      render(<WebRTCViewer socket={mockSocket as Socket} isActive={true} />);

      await waitFor(() => {
        expect(screen.getByText('Reconnecting to stream...')).toBeInTheDocument();
        expect(screen.getByText('Attempt 2 of 5')).toBeInTheDocument();
      });
    });

    it('should handle force reconnection', async () => {
      (mockMediasoupClient as any)._connectionState = 'reconnecting';

      render(<WebRTCViewer socket={mockSocket as Socket} isActive={true} />);

      await waitFor(() => {
        expect(screen.getByText('Force Reconnect')).toBeInTheDocument();
      });

      const forceReconnectBtn = screen.getByText('Force Reconnect');
      fireEvent.click(forceReconnectBtn);

      await waitFor(() => {
        expect(mockMediasoupClient.forceReconnection).toHaveBeenCalled();
      });
    });
  });

  describe('error handling', () => {
    it('should display initialization error', async () => {
      mockMediasoupClient.initialize.mockRejectedValue(new Error('Initialization failed'));

      render(<WebRTCViewer socket={mockSocket as Socket} isActive={true} />);

      await waitFor(() => {
        expect(screen.getByText('⚠️ Initialization failed')).toBeInTheDocument();
      });
    });

    it('should provide retry functionality', async () => {
      mockMediasoupClient.consume.mockRejectedValueOnce(new Error('Consume failed'))
                                     .mockResolvedValueOnce(new MediaStream());

      render(<WebRTCViewer socket={mockSocket as Socket} isActive={true} />);

      await waitFor(() => {
        expect(screen.getByText('Retry Connection')).toBeInTheDocument();
      });

      const retryBtn = screen.getByText('Retry Connection');
      fireEvent.click(retryBtn);

      await waitFor(() => {
        expect(mockMediasoupClient.cleanup).toHaveBeenCalled();
        expect(mockMediasoupClient.consume).toHaveBeenCalledTimes(2);
      });
    });

    it('should handle playback failure with retry option', async () => {
      (HTMLVideoElement.prototype.play as jest.Mock).mockRejectedValue(new Error('Playback failed'));

      render(<WebRTCViewer socket={mockSocket as Socket} isActive={true} />);

      await waitFor(() => {
        expect(screen.getByText('Playback failed')).toBeInTheDocument();
        expect(screen.getByText('Try Again')).toBeInTheDocument();
      });

      const tryAgainBtn = screen.getByText('Try Again');
      fireEvent.click(tryAgainBtn);

      expect(HTMLVideoElement.prototype.play).toHaveBeenCalledTimes(2);
    });
  });

  describe('cleanup', () => {
    it('should cleanup when component unmounts', async () => {
      const { unmount } = render(<WebRTCViewer socket={mockSocket as Socket} isActive={true} />);

      await waitFor(() => {
        expect(mockMediasoupClient.consume).toHaveBeenCalled();
      });

      unmount();

      // Cleanup is async, so we need to wait a bit
      await waitFor(() => {
        expect(mockMediasoupClient.cleanup).toHaveBeenCalled();
      });
    });

    it('should cleanup when switching to inactive', async () => {
      const { rerender } = render(<WebRTCViewer socket={mockSocket as Socket} isActive={true} />);

      await waitFor(() => {
        expect(mockMediasoupClient.consume).toHaveBeenCalled();
      });

      rerender(<WebRTCViewer socket={mockSocket as Socket} isActive={false} />);

      await waitFor(() => {
        expect(mockMediasoupClient.cleanup).toHaveBeenCalled();
      });
    });

    it('should handle cleanup errors gracefully', async () => {
      mockMediasoupClient.cleanup.mockRejectedValue(new Error('Cleanup failed'));

      const { unmount } = render(<WebRTCViewer socket={mockSocket as Socket} isActive={true} />);

      await waitFor(() => {
        expect(mockMediasoupClient.consume).toHaveBeenCalled();
      });

      // Should not throw on unmount even if cleanup fails
      expect(() => unmount()).not.toThrow();
    });
  });

  describe('accessibility', () => {
    it('should have proper video attributes', async () => {
      const { container } = render(<WebRTCViewer socket={mockSocket as Socket} isActive={true} />);

      const video = container.querySelector('video')!;
      expect(video).toHaveAttribute('autoPlay');
      expect(video).toHaveAttribute('muted');
      expect(video).toHaveAttribute('playsInline');
      expect(video).toHaveAttribute('controls', 'false');
    });

    it('should handle keyboard interaction on play overlay', async () => {
      (HTMLVideoElement.prototype.play as jest.Mock).mockRejectedValue(
        Object.assign(new Error('NotAllowedError'), { name: 'NotAllowedError' })
      );

      render(<WebRTCViewer socket={mockSocket as Socket} isActive={true} />);

      await waitFor(() => {
        expect(screen.getByText('Click to play stream')).toBeInTheDocument();
      });

      const playOverlay = screen.getByText('Click to play stream').closest('div')!;
      
      // Focus and press Enter
      playOverlay.focus();
      fireEvent.keyDown(playOverlay, { key: 'Enter' });

      expect(HTMLVideoElement.prototype.play).toHaveBeenCalled();
    });
  });

  describe('development mode features', () => {
    const originalEnv = process.env.NODE_ENV;

    afterEach(() => {
      Object.defineProperty(process.env, 'NODE_ENV', {
        value: originalEnv,
        writable: true,
        configurable: true
      });
    });

    it('should show debug info in development mode', async () => {
      Object.defineProperty(process.env, 'NODE_ENV', {
        value: 'development',
        writable: true,
        configurable: true
      });

      render(<WebRTCViewer socket={mockSocket as Socket} isActive={true} />);

      await waitFor(() => {
        expect(screen.getByText(/Playback:.*Connection:/)).toBeInTheDocument();
      });
    });

    it('should not show debug info in production mode', async () => {
      Object.defineProperty(process.env, 'NODE_ENV', {
        value: 'production',
        writable: true,
        configurable: true
      });

      render(<WebRTCViewer socket={mockSocket as Socket} isActive={true} />);

      await waitFor(() => {
        expect(mockMediasoupClient.consume).toHaveBeenCalled();
      });

      expect(screen.queryByText(/Playback:.*Connection:/)).not.toBeInTheDocument();
    });
  });
});