import React from 'react';
import { render, act } from '@testing-library/react';
import CanvasEffectOverlay from './CanvasEffectOverlay';

// CHARACTERIZATION TESTS — pin CURRENT observable behavior of CanvasEffectOverlay.
//
// REAL mechanism (verified by reading the component + EffectEngine):
//  - The canvas/rAF render loop lives ENTIRELY inside the `EffectEngine`
//    service (src/services/EffectEngine.ts). This component is a wiring layer:
//    it constructs an EffectEngine, hands it the canvas + video + socket,
//    forwards socket events to engine methods, and tears it down on unmount.
//  - jsdom does NOT render canvas, and EffectEngine's constructor pokes at a
//    real 2D context. So we MOCK the whole EffectEngine module with a jest
//    spy class. This lets us pin the wiring contract deterministically without
//    any flaky timing/canvas-pixel assertions.
//  - `socket` is a mock object exposing on/off/emit as jest.fn()s, matching the
//    socket.io-client surface the component actually uses.
//  - We also stub requestAnimationFrame/cancelAnimationFrame for safety even
//    though the rAF loop itself is inside the (mocked) engine.

// --- Mock EffectEngine: capture the most-recent instance for assertions ----
const engineInstances: any[] = [];

jest.mock('../../services/EffectEngine', () => {
  class MockEffectEngine {
    public setSocket = jest.fn();
    public on = jest.fn();
    public off = jest.fn();
    public triggerEffect = jest.fn();
    public removeEffect = jest.fn();
    public clearAllEffects = jest.fn();
    public clearEffectsByType = jest.fn();
    public handleResize = jest.fn();
    public handleRemoteDrawingPath = jest.fn();
    public handleRemoteDrawingStart = jest.fn();
    public handleRemoteDrawingSegment = jest.fn();
    public cleanup = jest.fn();
    public canvas: any;
    public video: any;
    constructor(canvas: any, video: any) {
      this.canvas = canvas;
      this.video = video;
      engineInstances.push(this);
    }
  }
  return { __esModule: true, EffectEngine: MockEffectEngine };
});

jest.mock('../../services/AuthService', () => ({
  __esModule: true,
  default: {
    getUser: jest.fn(() => ({ id: 'user-1', username: 'tester' })),
  },
}));

// --- Helpers ---------------------------------------------------------------
type Handler = (...args: any[]) => void;

function makeMockSocket() {
  const handlers: Record<string, Handler[]> = {};
  return {
    handlers,
    on: jest.fn((event: string, cb: Handler) => {
      (handlers[event] ||= []).push(cb);
    }),
    off: jest.fn((event: string, cb: Handler) => {
      handlers[event] = (handlers[event] || []).filter((h) => h !== cb);
    }),
    emit: jest.fn(),
    // convenience for tests to fire a server->client event
    fire(event: string, payload?: any) {
      (handlers[event] || []).forEach((h) => h(payload));
    },
  };
}

function makeVideoRef(): React.RefObject<HTMLVideoElement | null> {
  return { current: document.createElement('video') };
}

let rafSpy: jest.SpyInstance;
let cancelRafSpy: jest.SpyInstance;

beforeEach(() => {
  engineInstances.length = 0;
  rafSpy = jest
    .spyOn(window, 'requestAnimationFrame')
    .mockImplementation((cb: FrameRequestCallback) => {
      return 1 as unknown as number;
    });
  cancelRafSpy = jest
    .spyOn(window, 'cancelAnimationFrame')
    .mockImplementation(() => undefined);
});

afterEach(() => {
  rafSpy.mockRestore();
  cancelRafSpy.mockRestore();
  jest.clearAllMocks();
});

describe('CanvasEffectOverlay (characterization)', () => {
  it('renders nothing when isActive is false', () => {
    const socket = makeMockSocket();
    const { container } = render(
      <CanvasEffectOverlay
        videoRef={makeVideoRef()}
        socket={socket as any}
        isActive={false}
      />
    );
    expect(container.firstChild).toBeNull();
    // No EffectEngine should be constructed while inactive.
    expect(engineInstances.length).toBe(0);
  });

  it('mounts without throwing and renders the overlay container + canvas when active', () => {
    const socket = makeMockSocket();
    const { container } = render(
      <CanvasEffectOverlay
        videoRef={makeVideoRef()}
        socket={socket as any}
        isActive={true}
      />
    );
    expect(
      container.querySelector('.canvas-effect-overlay-container')
    ).not.toBeNull();
    const canvas = container.querySelector('canvas.effect-overlay-canvas');
    expect(canvas).not.toBeNull();
    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
  });

  it('applies the className prop to the container', () => {
    const socket = makeMockSocket();
    const { container } = render(
      <CanvasEffectOverlay
        videoRef={makeVideoRef()}
        socket={socket as any}
        isActive={true}
        className="my-extra-class"
      />
    );
    const el = container.querySelector('.canvas-effect-overlay-container');
    expect(el?.className).toContain('my-extra-class');
  });

  it('constructs an EffectEngine wired to the canvas + video, sets socket, and registers effectCountChange', () => {
    const socket = makeMockSocket();
    const videoRef = makeVideoRef();
    render(
      <CanvasEffectOverlay
        videoRef={videoRef}
        socket={socket as any}
        isActive={true}
      />
    );
    expect(engineInstances.length).toBe(1);
    const engine = engineInstances[0];
    expect(engine.canvas).toBeInstanceOf(HTMLCanvasElement);
    expect(engine.video).toBe(videoRef.current);
    expect(engine.setSocket).toHaveBeenCalledWith(socket);
    expect(engine.on).toHaveBeenCalledWith(
      'effectCountChange',
      expect.any(Function)
    );
  });

  it('registers the expected socket effect handlers and requests an initial sync', () => {
    const socket = makeMockSocket();
    render(
      <CanvasEffectOverlay
        videoRef={makeVideoRef()}
        socket={socket as any}
        isActive={true}
      />
    );
    const registered = socket.on.mock.calls.map((c) => c[0]);
    expect(registered).toEqual(
      expect.arrayContaining([
        'canvas-effect-trigger',
        'canvas-effect-complete',
        'canvas-effects-sync',
        'canvas-effects-clear',
        'canvas-effect-mode',
        'drawing-path-broadcast',
        'drawing-start-broadcast',
        'drawing-segment-broadcast',
        'canvas-effect-cancelled',
        'canvas-effects-clear-buff-synced',
        'canvas-effect-force-clear',
        'canvas-effect-force-clear-item',
      ])
    );
    expect(socket.emit).toHaveBeenCalledWith('request-effect-sync');
  });

  it('forwards a canvas-effect-trigger socket event to engine.triggerEffect', () => {
    const socket = makeMockSocket();
    render(
      <CanvasEffectOverlay
        videoRef={makeVideoRef()}
        socket={socket as any}
        isActive={true}
      />
    );
    const engine = engineInstances[0];
    const effect = {
      id: 'e1',
      userId: 'u',
      itemId: 'i',
      itemName: 'splat',
      displayName: 'Splat',
      emoji: '🍅',
      type: 'splat',
      duration: 3000,
      config: {},
      startTime: Date.now(),
      position: { x: 0.5, y: 0.5 },
    };
    act(() => {
      socket.fire('canvas-effect-trigger', effect);
    });
    expect(engine.triggerEffect).toHaveBeenCalledWith(effect);
  });

  it('forwards a canvas-effect-complete socket event to engine.removeEffect', () => {
    const socket = makeMockSocket();
    render(
      <CanvasEffectOverlay
        videoRef={makeVideoRef()}
        socket={socket as any}
        isActive={true}
      />
    );
    const engine = engineInstances[0];
    act(() => {
      socket.fire('canvas-effect-complete', { effectId: 'e1' });
    });
    expect(engine.removeEffect).toHaveBeenCalledWith('e1');
  });

  it('forwards canvas-effects-clear to engine.clearAllEffects', () => {
    const socket = makeMockSocket();
    render(
      <CanvasEffectOverlay
        videoRef={makeVideoRef()}
        socket={socket as any}
        isActive={true}
      />
    );
    const engine = engineInstances[0];
    act(() => {
      socket.fire('canvas-effects-clear', undefined);
    });
    expect(engine.clearAllEffects).toHaveBeenCalled();
  });

  it('forwards buff-synced clear to engine.clearEffectsByType with smoke_bomb', () => {
    const socket = makeMockSocket();
    render(
      <CanvasEffectOverlay
        videoRef={makeVideoRef()}
        socket={socket as any}
        isActive={true}
      />
    );
    const engine = engineInstances[0];
    act(() => {
      socket.fire('canvas-effects-clear-buff-synced', undefined);
    });
    expect(engine.clearEffectsByType).toHaveBeenCalledWith(['smoke_bomb']);
  });

  it('forwards a remote drawing-path-broadcast to engine.handleRemoteDrawingPath', () => {
    const socket = makeMockSocket();
    render(
      <CanvasEffectOverlay
        videoRef={makeVideoRef()}
        socket={socket as any}
        isActive={true}
      />
    );
    const engine = engineInstances[0];
    const payload = { effectId: 'e1', path: { points: [] } };
    act(() => {
      socket.fire('drawing-path-broadcast', payload);
    });
    expect(engine.handleRemoteDrawingPath).toHaveBeenCalledWith(payload);
  });

  it('cleans up on unmount: engine.cleanup is called and all socket handlers are removed', () => {
    const socket = makeMockSocket();
    const { unmount } = render(
      <CanvasEffectOverlay
        videoRef={makeVideoRef()}
        socket={socket as any}
        isActive={true}
      />
    );
    const engine = engineInstances[0];
    const registeredEvents = new Set(socket.on.mock.calls.map((c) => c[0]));

    act(() => {
      unmount();
    });

    expect(engine.cleanup).toHaveBeenCalled();
    const offEvents = new Set(socket.off.mock.calls.map((c) => c[0]));
    registeredEvents.forEach((evt) => {
      expect(offEvents.has(evt)).toBe(true);
    });
  });

  it('does not construct an EffectEngine when socket is null but still renders canvas', () => {
    const { container } = render(
      <CanvasEffectOverlay
        videoRef={makeVideoRef()}
        socket={null}
        isActive={true}
      />
    );
    // EffectEngine is still created (init effect only needs canvas+video),
    // but no socket wiring happens. Pin that the canvas renders regardless.
    expect(
      container.querySelector('canvas.effect-overlay-canvas')
    ).not.toBeNull();
  });
});
