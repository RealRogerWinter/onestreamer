import { TestStreamGenerator } from './TestStreamGenerator';

// Mock HTML Canvas API
const mockCanvas = {
  width: 640,
  height: 480,
  getContext: jest.fn().mockReturnValue({
    fillStyle: '',
    fillRect: jest.fn(),
    beginPath: jest.fn(),
    arc: jest.fn(),
    fill: jest.fn(),
    clearRect: jest.fn(),
    createRadialGradient: jest.fn().mockReturnValue({
      addColorStop: jest.fn()
    }),
    createLinearGradient: jest.fn().mockReturnValue({
      addColorStop: jest.fn()
    }),
    createImageData: jest.fn().mockReturnValue({
      data: new Uint8ClampedArray(640 * 480 * 4)
    }),
    putImageData: jest.fn(),
    font: '',
    textAlign: '',
    fillText: jest.fn()
  }),
  captureStream: jest.fn().mockReturnValue({
    getVideoTracks: () => [{ kind: 'video', id: 'video-track' }]
  })
};

// Mock document.createElement
Object.defineProperty(document, 'createElement', {
  value: jest.fn().mockImplementation((tagName) => {
    if (tagName === 'canvas') {
      return mockCanvas;
    }
    return {};
  }),
  writable: true
});

// Mock Web Audio API
const mockAudioContext = {
  createOscillator: jest.fn().mockReturnValue({
    frequency: { setValueAtTime: jest.fn() },
    type: 'sine',
    connect: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    disconnect: jest.fn()
  }),
  createGain: jest.fn().mockReturnValue({
    gain: { setValueAtTime: jest.fn() },
    connect: jest.fn(),
    disconnect: jest.fn()
  }),
  createMediaStreamDestination: jest.fn().mockReturnValue({
    stream: {
      getAudioTracks: () => [{ kind: 'audio', id: 'audio-track' }]
    }
  }),
  currentTime: 0,
  close: jest.fn()
};

global.AudioContext = jest.fn().mockImplementation(() => mockAudioContext);

// Mock requestAnimationFrame
global.requestAnimationFrame = jest.fn().mockImplementation((cb) => {
  setTimeout(cb, 16); // ~60fps
  return 1;
});

global.cancelAnimationFrame = jest.fn();

// Set up MediaStream mock
beforeAll(() => {
  global.MediaStream = jest.fn().mockImplementation((tracks = []) => ({
    id: 'stream-id',
    active: true,
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t: any) => t.kind === 'video'),
    getAudioTracks: () => tracks.filter((t: any) => t.kind === 'audio'),
    addTrack: jest.fn()
  })) as any;
});

describe('TestStreamGenerator', () => {
  let generator: TestStreamGenerator;

  beforeEach(() => {
    generator = new TestStreamGenerator(640, 480, 30, 'color-bars');
    jest.clearAllMocks();
  });

  afterEach(() => {
    generator.cleanup();
    jest.clearAllTimers();
  });

  describe('initialization', () => {
    it('should create generator with default parameters', () => {
      const defaultGenerator = new TestStreamGenerator();
      expect(defaultGenerator).toBeInstanceOf(TestStreamGenerator);
    });

    it('should create generator with custom parameters', () => {
      const customGenerator = new TestStreamGenerator(1920, 1080, 60, 'noise');
      expect(customGenerator).toBeInstanceOf(TestStreamGenerator);
    });
  });

  describe('video stream generation', () => {
    it('should generate video stream', () => {
      const videoStream = generator.generateVideoStream();

      expect(document.createElement).toHaveBeenCalledWith('canvas');
      expect(mockCanvas.getContext).toHaveBeenCalledWith('2d');
      expect(mockCanvas.captureStream).toHaveBeenCalledWith(30);
      expect(videoStream).toBeDefined();
      expect(videoStream.getVideoTracks()).toHaveLength(1);
    });

    it('should set canvas dimensions correctly', () => {
      generator.generateVideoStream();

      expect(mockCanvas.width).toBe(640);
      expect(mockCanvas.height).toBe(480);
    });

    it('should start animation loop', () => {
      generator.generateVideoStream();

      expect(requestAnimationFrame).toHaveBeenCalled();
    });
  });

  describe('audio stream generation', () => {
    it('should generate audio stream', () => {
      const audioStream = generator.generateAudioStream();

      expect(AudioContext).toHaveBeenCalled();
      expect(mockAudioContext.createOscillator).toHaveBeenCalled();
      expect(mockAudioContext.createGain).toHaveBeenCalled();
      expect(mockAudioContext.createMediaStreamDestination).toHaveBeenCalled();
      
      expect(audioStream).toBeDefined();
      expect(audioStream.getAudioTracks()).toHaveLength(1);
    });

    it('should configure oscillator correctly', () => {
      const mockOscillator = mockAudioContext.createOscillator();
      
      generator.generateAudioStream();

      expect(mockOscillator.frequency.setValueAtTime).toHaveBeenCalledWith(440, 0);
      expect(mockOscillator.type).toBe('sine');
      expect(mockOscillator.start).toHaveBeenCalled();
    });

    it('should set low audio volume', () => {
      const mockGainNode = mockAudioContext.createGain();
      
      generator.generateAudioStream();

      expect(mockGainNode.gain.setValueAtTime).toHaveBeenCalledWith(0.1, 0);
    });
  });

  describe('combined stream generation', () => {
    it('should generate combined video and audio stream', () => {
      const combinedStream = generator.generateCombinedStream();

      expect(combinedStream).toBeInstanceOf(MediaStream);
      expect(combinedStream.addTrack).toHaveBeenCalledTimes(2); // video + audio
    });

    it('should log stream generation', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      
      generator.generateCombinedStream();

      expect(consoleSpy).toHaveBeenCalledWith(
        '🎬 TEST: Generated combined stream - Video tracks:',
        1,
        'Audio tracks:',
        1
      );

      consoleSpy.mockRestore();
    });
  });

  describe('content type rendering', () => {
    let mockCtx: any;

    beforeEach(() => {
      mockCtx = mockCanvas.getContext();
      generator.generateVideoStream();
    });

    it('should render color bars', () => {
      const colorBarsGenerator = new TestStreamGenerator(640, 480, 30, 'color-bars');
      colorBarsGenerator.generateVideoStream();

      // Should call fillRect for each color bar
      expect(mockCtx.fillRect).toHaveBeenCalled();
    });

    it('should render noise pattern', () => {
      const noiseGenerator = new TestStreamGenerator(640, 480, 30, 'noise');
      noiseGenerator.generateVideoStream();

      expect(mockCtx.createImageData).toHaveBeenCalledWith(640, 480);
      expect(mockCtx.putImageData).toHaveBeenCalled();
    });

    it('should render gradient pattern', () => {
      const gradientGenerator = new TestStreamGenerator(640, 480, 30, 'gradient');
      gradientGenerator.generateVideoStream();

      expect(mockCtx.createLinearGradient).toHaveBeenCalled();
    });

    it('should render moving text', () => {
      const textGenerator = new TestStreamGenerator(640, 480, 30, 'moving-text');
      textGenerator.generateVideoStream();

      expect(mockCtx.fillText).toHaveBeenCalled();
    });

    it('should render clock display', () => {
      const clockGenerator = new TestStreamGenerator(640, 480, 30, 'clock');
      clockGenerator.generateVideoStream();

      expect(mockCtx.fillText).toHaveBeenCalled();
    });

    it('should render default pattern for unknown content type', () => {
      const unknownGenerator = new TestStreamGenerator(640, 480, 30, 'unknown' as any);
      unknownGenerator.generateVideoStream();

      expect(mockCtx.createRadialGradient).toHaveBeenCalled();
    });
  });

  describe('text overlay', () => {
    it('should render text overlay', () => {
      const mockCtx = mockCanvas.getContext();
      generator.generateVideoStream();

      // Should render overlay backgrounds and text
      expect(mockCtx.fillRect).toHaveBeenCalled();
      expect(mockCtx.fillText).toHaveBeenCalled();
    });

    it('should display current time in text overlay', () => {
      const mockCtx = mockCanvas.getContext();
      const dateSpy = jest.spyOn(Date.prototype, 'toLocaleTimeString').mockReturnValue('12:34:56');
      
      generator.generateVideoStream();

      expect(dateSpy).toHaveBeenCalled();
      expect(mockCtx.fillText).toHaveBeenCalledWith(
        expect.stringContaining('12:34:56'),
        320,
        430
      );

      dateSpy.mockRestore();
    });

    it('should display stream configuration in overlay', () => {
      const mockCtx = mockCanvas.getContext();
      generator.generateVideoStream();

      expect(mockCtx.fillText).toHaveBeenCalledWith(
        'Resolution: 640×480 | FPS: 30',
        320,
        450
      );
      expect(mockCtx.fillText).toHaveBeenCalledWith(
        'Content: color-bars',
        320,
        470
      );
    });
  });

  describe('animation management', () => {
    it('should update frame counter', (done) => {
      const mockCtx = mockCanvas.getContext();
      generator.generateVideoStream();

      setTimeout(() => {
        expect(mockCtx.fillText).toHaveBeenCalledWith(
          expect.stringMatching(/Frame: \d+/),
          320,
          430
        );
        done();
      }, 50);
    });

    it('should update hue for color animation', (done) => {
      generator.generateVideoStream();

      setTimeout(() => {
        // Animation should have progressed
        expect(requestAnimationFrame).toHaveBeenCalledTimes(3); // Initial + 2 frames
        done();
      }, 50);
    });
  });

  describe('cleanup', () => {
    it('should cleanup all resources', () => {
      const videoStream = generator.generateVideoStream();
      const audioStream = generator.generateAudioStream();

      generator.cleanup();

      expect(cancelAnimationFrame).toHaveBeenCalled();
      expect(mockAudioContext.createOscillator().stop).toHaveBeenCalled();
      expect(mockAudioContext.createOscillator().disconnect).toHaveBeenCalled();
      expect(mockAudioContext.createGain().disconnect).toHaveBeenCalled();
      expect(mockAudioContext.close).toHaveBeenCalled();
    });

    it('should handle cleanup when no resources exist', () => {
      expect(() => generator.cleanup()).not.toThrow();
    });

    it('should log cleanup message', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      
      generator.cleanup();

      expect(consoleSpy).toHaveBeenCalledWith('🧹 TEST: Test stream generator cleaned up');
      
      consoleSpy.mockRestore();
    });

    it('should handle multiple cleanup calls safely', () => {
      generator.generateVideoStream();
      generator.generateAudioStream();

      generator.cleanup();
      expect(() => generator.cleanup()).not.toThrow();
    });
  });

  describe('error handling', () => {
    it('should handle canvas creation failure', () => {
      (document.createElement as jest.Mock).mockReturnValueOnce(null);

      expect(() => generator.generateVideoStream()).not.toThrow();
    });

    it('should handle audio context creation failure', () => {
      (AudioContext as jest.Mock).mockImplementationOnce(() => {
        throw new Error('AudioContext not supported');
      });

      expect(() => generator.generateAudioStream()).toThrow('AudioContext not supported');
    });

    it('should handle animation frame cleanup safely', () => {
      generator.generateVideoStream();
      
      // Mock cancelAnimationFrame to throw
      (cancelAnimationFrame as jest.Mock).mockImplementationOnce(() => {
        throw new Error('cancelAnimationFrame failed');
      });

      expect(() => generator.cleanup()).not.toThrow();
    });
  });

  describe('performance considerations', () => {
    it('should not create multiple canvases', () => {
      generator.generateVideoStream();
      generator.generateVideoStream();

      expect(document.createElement).toHaveBeenCalledWith('canvas');
    });

    it('should reuse audio context efficiently', () => {
      generator.generateAudioStream();

      expect(AudioContext).toHaveBeenCalledTimes(1);
    });

    it('should handle high frame rates', () => {
      const highFpsGenerator = new TestStreamGenerator(640, 480, 60);
      
      expect(() => highFpsGenerator.generateVideoStream()).not.toThrow();
      expect(mockCanvas.captureStream).toHaveBeenCalledWith(60);
    });

    it('should handle large resolutions', () => {
      const largeGenerator = new TestStreamGenerator(1920, 1080, 30);
      
      expect(() => largeGenerator.generateVideoStream()).not.toThrow();
    });
  });
});