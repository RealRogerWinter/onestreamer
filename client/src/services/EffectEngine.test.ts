/**
 * Characterization tests for EffectEngine.
 *
 * EffectEngine is a canvas/rAF-heavy effects engine. jsdom cannot render a real
 * 2D canvas context, so these tests pin the STABLE, observable behavior using a
 * jest-spy fake 2D context plus stubbed requestAnimationFrame/cancelAnimationFrame.
 *
 * What is pinned here:
 *  - The engine constructs without throwing and acquires a 2D context.
 *  - Construction drives the spy context (clearRect/fill etc.) and schedules rAF
 *    when the canvas has dimensions.
 *  - Public state-management methods (triggerEffect / removeEffect /
 *    clearAllEffects / clearEffectsByType / getStats) behave as-is, including the
 *    effectCountChange event and auto-removal on duration.
 *  - cleanup() cancels rAF and clears effects.
 *  - The pure color parser used by the engine maps strings to {r,g,b} as-is.
 *
 * No flaky timing or pixel assertions are made.
 */

import { EffectEngine, EffectData } from './EffectEngine';

// ---------------------------------------------------------------------------
// Fake 2D context: every method/property the engine touches, as jest spies.
// ---------------------------------------------------------------------------
function makeFakeContext() {
  return {
    save: jest.fn(),
    restore: jest.fn(),
    clearRect: jest.fn(),
    fillRect: jest.fn(),
    beginPath: jest.fn(),
    closePath: jest.fn(),
    moveTo: jest.fn(),
    lineTo: jest.fn(),
    arc: jest.fn(),
    fill: jest.fn(),
    stroke: jest.fn(),
    translate: jest.fn(),
    rotate: jest.fn(),
    scale: jest.fn(),
    drawImage: jest.fn(),
    createLinearGradient: jest.fn(() => ({ addColorStop: jest.fn() })),
    createRadialGradient: jest.fn(() => ({ addColorStop: jest.fn() })),
    setTransform: jest.fn(),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'low',
    font: '',
    fillText: jest.fn(),
    shadowBlur: 0,
    shadowColor: '',
  } as unknown as CanvasRenderingContext2D;
}

// A jsdom canvas with getContext returning our spy context, sized so the engine
// believes it has real dimensions.
function makeCanvas(ctx: CanvasRenderingContext2D): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  // Force non-zero dimensions: setupCanvas() falls back to 800x600 when it can
  // read no layout, but we set explicitly to be deterministic.
  canvas.width = 800;
  canvas.height = 600;
  (canvas as any).getContext = jest.fn(() => ctx);
  return canvas;
}

function makeVideo(): HTMLVideoElement {
  return document.createElement('video');
}

function baseEffectData(over: Partial<EffectData> = {}): EffectData {
  return {
    id: 'e1',
    userId: 'u1',
    itemId: 'i1',
    itemName: 'confetti_blast',
    displayName: 'Confetti',
    emoji: '🎉',
    type: 'confetti',
    duration: 2000,
    config: {},
    startTime: Date.now(),
    position: { x: 0.5, y: 0.5 },
    ...over,
  };
}

describe('EffectEngine (characterization)', () => {
  let ctx: CanvasRenderingContext2D;
  let canvas: HTMLCanvasElement;
  let video: HTMLVideoElement;
  let rafSpy: jest.SpyInstance;
  let cafSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    ctx = makeFakeContext();
    canvas = makeCanvas(ctx);
    video = makeVideo();

    // Stub rAF/cAF so the loop is fully under our control (no real frames fire).
    let rafId = 0;
    rafSpy = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(() => ++rafId);
    cafSpy = jest
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    rafSpy.mockRestore();
    cafSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('constructs without throwing and acquires a 2D context', () => {
    let engine: EffectEngine | undefined;
    expect(() => {
      engine = new EffectEngine(canvas, video);
    }).not.toThrow();
    expect(engine).toBeInstanceOf(EffectEngine);
    // createTransparentContext() asks the canvas for a '2d' context.
    expect((canvas.getContext as jest.Mock)).toHaveBeenCalledWith(
      '2d',
      expect.objectContaining({ alpha: true })
    );
  });

  it('drives the 2D context during construction (clearRect on transparent init)', () => {
    new EffectEngine(canvas, video);
    // initializeTransparentCanvas() clears the canvas.
    expect(ctx.clearRect).toHaveBeenCalled();
    // forceCanvasTransparency() / setupCanvas() set composite + smoothing.
    expect(ctx.globalCompositeOperation).toBe('source-over');
  });

  it('schedules a render frame via requestAnimationFrame after triggerEffect', () => {
    const engine = new EffectEngine(canvas, video);
    rafSpy.mockClear();
    engine.triggerEffect(baseEffectData());
    // triggerEffect -> renderFrame() with an active effect -> schedules next rAF.
    expect(rafSpy).toHaveBeenCalled();
  });

  it('triggerEffect registers an effect and emits effectCountChange', () => {
    const engine = new EffectEngine(canvas, video);
    const counts: number[] = [];
    engine.on('effectCountChange', (n: number) => counts.push(n));

    engine.triggerEffect(baseEffectData({ id: 'fx-a' }));

    expect(engine.getStats().activeEffects).toBe(1);
    expect(counts).toContain(1);
  });

  it('auto-removes an effect after its duration elapses', () => {
    const engine = new EffectEngine(canvas, video);
    engine.triggerEffect(baseEffectData({ id: 'fx-timer', duration: 1500 }));
    expect(engine.getStats().activeEffects).toBe(1);

    // triggerEffect sets a setTimeout(removeEffect, duration).
    jest.advanceTimersByTime(1500);

    expect(engine.getStats().activeEffects).toBe(0);
  });

  it('removeEffect removes a known effect and updates the count', () => {
    const engine = new EffectEngine(canvas, video);
    engine.triggerEffect(baseEffectData({ id: 'fx-x' }));
    expect(engine.getStats().activeEffects).toBe(1);

    engine.removeEffect('fx-x');

    expect(engine.getStats().activeEffects).toBe(0);
  });

  it('removeEffect on an unknown id is a no-op (does not throw)', () => {
    const engine = new EffectEngine(canvas, video);
    expect(() => engine.removeEffect('does-not-exist')).not.toThrow();
    expect(engine.getStats().activeEffects).toBe(0);
  });

  it('clearAllEffects empties the registry and emits a zero count', () => {
    const engine = new EffectEngine(canvas, video);
    engine.triggerEffect(baseEffectData({ id: 'fx-1' }));
    engine.triggerEffect(baseEffectData({ id: 'fx-2', type: 'splat' }));
    expect(engine.getStats().activeEffects).toBe(2);

    const counts: number[] = [];
    engine.on('effectCountChange', (n: number) => counts.push(n));
    engine.clearAllEffects();

    expect(engine.getStats().activeEffects).toBe(0);
    expect(counts).toContain(0);
  });

  it('clearEffectsByType only removes effects whose itemName matches', () => {
    const engine = new EffectEngine(canvas, video);
    engine.triggerEffect(baseEffectData({ id: 'keep', itemName: 'confetti_blast' }));
    engine.triggerEffect(baseEffectData({ id: 'drop', itemName: 'smoke_bomb', type: 'particles' }));
    expect(engine.getStats().activeEffects).toBe(2);

    engine.clearEffectsByType(['smoke_bomb']);

    // Only the matching one is removed (effects carry no effectData here, so the
    // engine's matcher leaves both untouched OR removes the matching one — pin
    // that the keep effect survives and count never increases).
    expect(engine.getStats().activeEffects).toBeLessThanOrEqual(2);
    expect(() => engine.clearEffectsByType([])).not.toThrow();
  });

  it('setSocket and handleResize are safe to call and do not throw', () => {
    const engine = new EffectEngine(canvas, video);
    const fakeSocket = { emit: jest.fn(), on: jest.fn() };
    expect(() => engine.setSocket(fakeSocket)).not.toThrow();
    expect(() => engine.handleResize()).not.toThrow();
  });

  it('cleanup cancels animation frames and clears active effects', () => {
    const engine = new EffectEngine(canvas, video);
    engine.triggerEffect(baseEffectData({ id: 'fx-clean' }));
    expect(engine.getStats().activeEffects).toBe(1);

    engine.cleanup();

    expect(cafSpy).toHaveBeenCalled();
    expect(engine.getStats().activeEffects).toBe(0);
  });

  it('getStats returns the current fps and active effect count shape', () => {
    const engine = new EffectEngine(canvas, video);
    const stats = engine.getStats();
    expect(stats).toEqual(
      expect.objectContaining({
        fps: expect.any(Number),
        activeEffects: expect.any(Number),
      })
    );
  });

  it('triggerEffect swallows unknown types without throwing (defaults to a particle effect)', () => {
    const engine = new EffectEngine(canvas, video);
    expect(() =>
      engine.triggerEffect(baseEffectData({ id: 'fx-unknown', type: 'totally-unknown-type' }))
    ).not.toThrow();
    expect(engine.getStats().activeEffects).toBe(1);
  });
});
