import { MediasoupClient } from './MediasoupClient';
import { Socket } from 'socket.io-client';

// Mock MediaStreamTrack and MediaStream in the mock factory
const mockMediaStreamTrack = {
  id: 'track-id',
  kind: 'video',
  enabled: true,
  muted: false,
  readyState: 'live'
};

// Mock mediasoup-client
jest.mock('mediasoup-client', () => ({
  Device: jest.fn().mockImplementation(() => ({
    loaded: false,
    rtpCapabilities: {},
    load: jest.fn().mockResolvedValue(undefined),
    canProduce: jest.fn().mockReturnValue(true),
    createSendTransport: jest.fn().mockReturnValue({
      id: 'send-transport-id',
      closed: false,
      on: jest.fn(),
      produce: jest.fn().mockResolvedValue({ id: 'producer-id' }),
      close: jest.fn()
    }),
    createRecvTransport: jest.fn().mockReturnValue({
      id: 'recv-transport-id',
      closed: false,
      on: jest.fn(),
      consume: jest.fn().mockResolvedValue({ 
        id: 'consumer-id',
        track: mockMediaStreamTrack,
        close: jest.fn()
      }),
      close: jest.fn()
    })
  }))
}));

// Mock fetch
global.fetch = jest.fn();

const mockMediaStream = {
  id: 'stream-id',
  active: true,
  getTracks: () => [],
  getVideoTracks: () => [],
  getAudioTracks: () => [],
  addTrack: jest.fn(),
  removeTrack: jest.fn()
};

// Set up global mocks
beforeAll(() => {
  global.MediaStreamTrack = jest.fn().mockImplementation(() => mockMediaStreamTrack) as any;
  global.MediaStream = jest.fn().mockImplementation((tracks = []) => ({
    ...mockMediaStream,
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t: any) => t.kind === 'video'),
    getAudioTracks: () => tracks.filter((t: any) => t.kind === 'audio')
  })) as any;
});

describe('MediasoupClient', () => {
  let mockSocket: Partial<Socket>;
  let mediasoupClient: MediasoupClient;
  let mockFetch: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    mockSocket = {
      id: 'socket-id',
      connected: true,
      on: jest.fn(),
      emit: jest.fn()
    };

    mockFetch = fetch as jest.MockedFunction<typeof fetch>;
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ rtpCapabilities: {} })
    } as Response);

    mediasoupClient = new MediasoupClient({
      socket: mockSocket as Socket,
      serverUrl: 'http://test.com'
    });

    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.clearAllTimers();
  });

  describe('initialization', () => {
    it('should initialize successfully', async () => {
      await expect(mediasoupClient.initialize()).resolves.not.toThrow();
      expect(mockFetch).toHaveBeenCalledWith('http://test.com/api/mediasoup/router-capabilities');
    });

    it('should handle initialization timeout', async () => {
      mockFetch.mockImplementationOnce(() => 
        new Promise(resolve => setTimeout(resolve, 15000))
      );

      await expect(mediasoupClient.initialize()).rejects.toThrow('Operation timeout after 10000ms');
    });

    it('should throw error when socket is disconnected', async () => {
      mockSocket.connected = false;
      await expect(mediasoupClient.initialize()).rejects.toThrow('MediasoupClient is in invalid state for initialization');
    });

    it('should handle server error during initialization', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error'
      } as Response);

      await expect(mediasoupClient.initialize()).rejects.toThrow();
    });
  });

  describe('transport creation', () => {
    beforeEach(async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ 
          id: 'transport-id',
          iceParameters: {},
          iceCandidates: [],
          dtlsParameters: {}
        })
      } as Response);

      await mediasoupClient.initialize();
    });

    it('should create send transport successfully', async () => {
      await expect(mediasoupClient.createSendTransport()).resolves.not.toThrow();
      expect(mockFetch).toHaveBeenCalledWith('http://test.com/api/mediasoup/create-transport', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ socketId: 'socket-id' })
      });
    });

    it('should create receive transport successfully', async () => {
      await expect(mediasoupClient.createRecvTransport()).resolves.not.toThrow();
      expect(mockFetch).toHaveBeenCalledWith('http://test.com/api/mediasoup/create-transport', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ socketId: 'socket-id' })
      });
    });

    it('should handle transport creation failure', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500
      } as Response);

      await expect(mediasoupClient.createSendTransport()).rejects.toThrow();
    });
  });

  describe('producing media', () => {
    let mockVideoTrack: MediaStreamTrack;
    let mockAudioTrack: MediaStreamTrack;
    let mockStream: MediaStream;

    beforeEach(async () => {
      mockVideoTrack = new MediaStreamTrack();
      Object.assign(mockVideoTrack, { kind: 'video' });
      
      mockAudioTrack = new MediaStreamTrack();
      Object.assign(mockAudioTrack, { kind: 'audio' });

      mockStream = new MediaStream([mockVideoTrack, mockAudioTrack]);

      await mediasoupClient.initialize();
      await mediasoupClient.createSendTransport();
    });

    it('should produce video and audio tracks', async () => {
      await expect(mediasoupClient.produce(mockStream)).resolves.not.toThrow();
    });

    it('should handle produce failure', async () => {
      const mockDevice = mediasoupClient['device'] as any;
      const mockTransport = mockDevice.createSendTransport();
      mockTransport.produce.mockRejectedValue(new Error('Produce failed'));

      await expect(mediasoupClient.produce(mockStream)).rejects.toThrow('Produce failed');
    });

    it('should clean up producers on error', async () => {
      const mockDevice = mediasoupClient['device'] as any;
      const mockTransport = mockDevice.createSendTransport();
      mockTransport.produce.mockRejectedValueOnce(new Error('First track failed'));

      await expect(mediasoupClient.produce(mockStream)).rejects.toThrow();
      
      // Verify cleanup was called
      expect(mediasoupClient['videoProducer']).toBeUndefined();
      expect(mediasoupClient['audioProducer']).toBeUndefined();
    });
  });

  describe('consuming media', () => {
    beforeEach(async () => {
      await mediasoupClient.initialize();
      await mediasoupClient.createRecvTransport();

      // Mock socket emit for consume requests
      (mockSocket.emit as jest.Mock).mockImplementation((event, data, callback) => {
        if (event === 'mediasoup:consume') {
          callback({
            success: true,
            consumer: {
              id: 'consumer-id',
              producerId: 'producer-id',
              kind: data.kind,
              rtpParameters: {}
            }
          });
        } else if (event === 'mediasoup:resume-consumer') {
          callback({ success: true });
        }
      });
    });

    it('should consume media successfully', async () => {
      const stream = await mediasoupClient.consume();
      expect(stream).toBeInstanceOf(MediaStream);
      expect(mockSocket.emit).toHaveBeenCalledWith(
        'mediasoup:consume',
        expect.objectContaining({ kind: 'video' }),
        expect.any(Function)
      );
    });

    it('should handle no available streams', async () => {
      (mockSocket.emit as jest.Mock).mockImplementation((event, data, callback) => {
        callback({ success: false });
      });

      const stream = await mediasoupClient.consume();
      expect(stream).toBeNull();
    });

    it('should handle consumer creation failure', async () => {
      const mockDevice = mediasoupClient['device'] as any;
      const mockTransport = mockDevice.createRecvTransport();
      mockTransport.consume.mockRejectedValue(new Error('Consumer creation failed'));

      const stream = await mediasoupClient.consume();
      expect(stream).toBeNull();
    });
  });

  describe('connection recovery', () => {
    let onConnectionLost: jest.Mock;
    let onConnectionRecovered: jest.Mock;
    let onReconnectionFailed: jest.Mock;

    beforeEach(() => {
      onConnectionLost = jest.fn();
      onConnectionRecovered = jest.fn();
      onReconnectionFailed = jest.fn();

      mediasoupClient = new MediasoupClient({
        socket: mockSocket as Socket,
        onConnectionLost,
        onConnectionRecovered,
        onReconnectionFailed
      });
    });

    it('should handle socket disconnect', () => {
      const disconnectHandler = (mockSocket.on as jest.Mock).mock.calls
        .find(call => call[0] === 'disconnect')?.[1];

      disconnectHandler?.('server disconnect');

      expect(onConnectionLost).toHaveBeenCalled();
    });

    it('should handle socket reconnect', () => {
      const connectHandler = (mockSocket.on as jest.Mock).mock.calls
        .find(call => call[0] === 'connect')?.[1];

      // Simulate previous disconnect
      mediasoupClient['lastConnectionState'] = 'disconnected';

      connectHandler?.();

      expect(onConnectionRecovered).toHaveBeenCalled();
    });

    it('should handle connection errors', () => {
      const errorHandler = (mockSocket.on as jest.Mock).mock.calls
        .find(call => call[0] === 'connect_error')?.[1];

      const error = new Error('Connection failed');
      errorHandler?.(error);

      // Should trigger reconnection logic
      expect(mediasoupClient.connectionState).toBe('disconnected');
    });

    it('should perform health checks', async () => {
      // Mock successful health check
      mockFetch.mockResolvedValue({ ok: true } as Response);

      await mediasoupClient['performHealthCheck']();

      expect(mockFetch).toHaveBeenCalledWith('http://localhost:8080/health', {
        signal: expect.any(AbortSignal)
      });
    });

    it('should handle health check failure', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      await mediasoupClient['performHealthCheck']();

      // Should trigger connection error handling
      expect(console.warn).toHaveBeenCalledWith(
        '⚠️ MEDIASOUP CLIENT: Health check failed:',
        expect.any(Error)
      );
    });
  });

  describe('cleanup', () => {
    beforeEach(async () => {
      await mediasoupClient.initialize();
      await mediasoupClient.createSendTransport();
      await mediasoupClient.createRecvTransport();
    });

    it('should cleanup all resources', async () => {
      await mediasoupClient.cleanup();

      expect(mediasoupClient['isDestroyed']).toBe(true);
      expect(mediasoupClient['sendTransport']).toBeUndefined();
      expect(mediasoupClient['recvTransport']).toBeUndefined();
      expect(mediasoupClient['consumers'].size).toBe(0);
    });

    it('should handle cleanup when already destroyed', async () => {
      await mediasoupClient.cleanup();
      await expect(mediasoupClient.cleanup()).resolves.not.toThrow();
    });

    it('should stop reconnection timers on cleanup', async () => {
      // Start a mock reconnection
      mediasoupClient['reconnectionTimer'] = setTimeout(() => {}, 1000) as NodeJS.Timeout;
      mediasoupClient['healthCheckInterval'] = setInterval(() => {}, 1000) as NodeJS.Timeout;

      await mediasoupClient.cleanup();

      expect(mediasoupClient['reconnectionTimer']).toBeUndefined();
      expect(mediasoupClient['healthCheckInterval']).toBeUndefined();
    });
  });

  describe('transport recreation', () => {
    it('should recreate transports successfully', async () => {
      await mediasoupClient.initialize();
      await mediasoupClient.createSendTransport();
      await mediasoupClient.createRecvTransport();

      await expect(mediasoupClient.recreateTransports()).resolves.not.toThrow();
    });

    it('should handle recreation failure', async () => {
      mockSocket.connected = false;

      await expect(mediasoupClient.recreateTransports()).rejects.toThrow(
        'Cannot recreate transports in current state'
      );
    });
  });

  describe('getters', () => {
    it('should return correct ready state', () => {
      expect(mediasoupClient.isReady).toBe(false);
      
      // Mock device as loaded
      Object.defineProperty(mediasoupClient['device'], 'loaded', {
        value: true,
        writable: true,
        configurable: true
      });
      expect(mediasoupClient.isReady).toBe(true);
    });

    it('should return connection state', () => {
      expect(mediasoupClient.connectionState).toBe('disconnected');
      
      mediasoupClient['lastConnectionState'] = 'connected';
      expect(mediasoupClient.connectionState).toBe('connected');
      
      mediasoupClient['isReconnecting'] = true;
      expect(mediasoupClient.connectionState).toBe('reconnecting');
    });

    it('should return reconnection info', () => {
      const info = mediasoupClient.reconnectionInfo;
      expect(info).toEqual({
        attempts: 0,
        maxAttempts: 5,
        isReconnecting: false
      });
    });
  });
});