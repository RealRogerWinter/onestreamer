> Archived 2026-05-23 — historical planning doc, not maintained. Plan not yet executed.

# Streamer CPU Optimization Analysis & Improvement Plan

## Executive Summary

Analysis of 6 major client-side components reveals significant CPU optimization opportunities. The biggest offenders are **animation loops running at 60fps** when 30fps or less would suffice, **excessive canvas operations**, and **redundant state updates**.

---

## Components Analyzed

| Component | File | CPU Impact | Priority |
|-----------|------|------------|----------|
| EffectEngine | `services/EffectEngine.ts` | **CRITICAL** | 1 |
| AudioLevelMeter | `components/AudioLevelMeter.tsx` | **HIGH** | 2 |
| VideoCompositor | `services/VideoCompositor.ts` | **HIGH** | 3 |
| CanvasEffectOverlay | `components/canvas/CanvasEffectOverlay.tsx` | **MEDIUM** | 4 |
| WebRTCStreamer | `components/WebRTCStreamer.tsx` | **MEDIUM** | 5 |
| AudioMixer | `services/AudioMixer.ts` | **LOW** | 6 |

---

## Detailed Findings & Recommendations

### 1. EffectEngine (CRITICAL)
**File:** `client/src/services/EffectEngine.ts`

#### Current Issues:
| Issue | Location | Impact |
|-------|----------|--------|
| Debug `getImageData()` in render loop | Lines 1162-1187 | Reads pixels from GPU every 60 frames - **extremely expensive** |
| 5 redundant `setTimeout` resize calls | Lines 1227-1243 | 10+ initialization operations on startup |
| RAF runs even with no active effects | Line 1220 | Constant CPU usage even when idle |
| Multiple `ctx.save()/restore()` per frame | Lines 1148-1215 | 3 separate save/restore pairs |

#### Recommended Changes:
```typescript
// 1. Remove debug pixel reads from production
if (process.env.NODE_ENV === 'development' && this.debugMode) {
  // Only then do getImageData
}

// 2. Stop render loop when no effects active
if (this.activeEffects.size === 0) {
  this.stopRenderLoop();
  return;
}

// 3. Single resize call instead of 5 setTimeout cascade
private setupCanvas(): void {
  // Remove forceCanvasResize() entirely
  // Use ResizeObserver for responsive updates
}

// 4. Batch context operations
this.ctx.save();
// All drawing here
this.ctx.restore(); // Only once
```

**Estimated CPU Reduction:** 40-60% when effects are not active

---

### 2. AudioLevelMeter (HIGH)
**File:** `client/src/components/AudioLevelMeter.tsx`

#### Current Issues:
| Issue | Location | Impact |
|-------|----------|--------|
| FFT size 2048 | Line 79 | Processing 2048 samples per frame |
| 60fps update rate | Line 128 | Unnecessary for visual meter |
| 3 setState calls per frame | Lines 115-127 | Triggers 3 React re-renders |
| `Date.now()` every frame | Line 119 | Unnecessary allocation |

#### Recommended Changes:
```typescript
// 1. Reduce FFT size (256 is plenty for level metering)
analyser.fftSize = 256;  // Was 2048

// 2. Throttle to 30fps (meters don't need 60fps)
const METER_UPDATE_INTERVAL = 33; // ~30fps
let lastUpdate = 0;
const analyze = (timestamp) => {
  if (timestamp - lastUpdate < METER_UPDATE_INTERVAL) {
    animationFrameRef.current = requestAnimationFrame(analyze);
    return;
  }
  lastUpdate = timestamp;
  // ... analysis code
};

// 3. Batch state updates
const [meterState, setMeterState] = useState({ level: 0, db: -60, peak: -60 });
// Single setState instead of 3
setMeterState({ level: normalizedLevel, db: clampedDb, peak: peakDb });

// 4. Use performance.now() from RAF callback instead of Date.now()
```

**Estimated CPU Reduction:** 50-70% for audio metering

---

### 3. VideoCompositor (HIGH)
**File:** `client/src/services/VideoCompositor.ts`

#### Current Issues:
| Issue | Location | Impact |
|-------|----------|--------|
| PiP dimensions recalculated every frame | Lines 203-220 | Unnecessary math operations |
| RAF scheduled even when throttled | Line 198 | Scheduling overhead |
| No `alpha: false` on canvas context | Line 55 | Browser composites transparency unnecessarily |

#### Recommended Changes:
```typescript
// 1. Cache PiP dimensions (only recalc on options change)
private pipDimensions: { x: number, y: number, w: number, h: number } | null = null;

updateOptions(options: Partial<CompositorOptions>): void {
  this.options = { ...this.options, ...options };
  this.pipDimensions = null; // Invalidate cache
}

private getPipDimensions() {
  if (!this.pipDimensions) {
    this.pipDimensions = this.calculatePipDimensions();
  }
  return this.pipDimensions;
}

// 2. Use alpha: false for opaque canvas
this.ctx = this.canvas.getContext('2d', { alpha: false });

// 3. Better frame throttling (skip RAF when not needed)
private scheduleNextFrame(): void {
  if (!this.isActive) return;
  const now = performance.now();
  const timeUntilNextFrame = this.frameInterval - (now - this.lastFrameTime);
  if (timeUntilNextFrame > 0) {
    setTimeout(() => {
      this.animationFrameId = requestAnimationFrame(this.renderFrame);
    }, timeUntilNextFrame);
  } else {
    this.animationFrameId = requestAnimationFrame(this.renderFrame);
  }
}
```

**Estimated CPU Reduction:** 20-30% during screen share with PiP

---

### 4. CanvasEffectOverlay (MEDIUM)
**File:** `client/src/components/canvas/CanvasEffectOverlay.tsx`

#### Current Issues:
| Issue | Location | Impact |
|-------|----------|--------|
| 8 inline socket listeners | Lines 415-449 | Re-registered on every render |
| Global click listener on capture | Lines 775-791 | Runs for ALL clicks |
| 100ms resize debounce | Lines 453-515 | Too frequent during resize |

#### Recommended Changes:
```typescript
// 1. Memoize socket handlers
const handleSplatEffect = useCallback((data) => {
  // handler code
}, [/* stable deps */]);

useEffect(() => {
  socket.on('splat-effect', handleSplatEffect);
  return () => socket.off('splat-effect', handleSplatEffect);
}, [socket, handleSplatEffect]);

// 2. Use event delegation instead of global listener
// Remove document.addEventListener('click', ..., true)
// Handle clicks only on canvas element

// 3. Increase resize debounce to 250ms
const RESIZE_DEBOUNCE = 250; // Was 100
```

**Estimated CPU Reduction:** 10-20% during normal streaming

---

### 5. WebRTCStreamer (MEDIUM)
**File:** `client/src/components/WebRTCStreamer.tsx`

#### Current Issues:
| Issue | Location | Impact |
|-------|----------|--------|
| No debounce on device changes | Lines 281-310, 403-431 | Rapid track replacements |
| 500ms hardcoded delay | Line 1066 | Unnecessary wait time |
| Multiple useEffect for related state | Lines 894-917 | Could be combined |

#### Recommended Changes:
```typescript
// 1. Debounce device changes
const debouncedReplaceAudioTrack = useMemo(
  () => debounce(replaceAudioTrack, 300),
  [replaceAudioTrack]
);

// 2. Remove unnecessary 500ms delay or make conditional
// Line 1066: await new Promise(resolve => setTimeout(resolve, 500));
// Only wait if there was an existing client to cleanup

// 3. Combine related effects
useEffect(() => {
  if (!isScreenSharing) return;
  // Handle both gain and PiP updates in one effect
  if (audioMixerRef.current.getIsActive()) {
    audioMixerRef.current.setMicGain(micGain);
    audioMixerRef.current.setSystemGain(systemGain);
  }
  if (videoCompositorRef.current.getIsActive()) {
    videoCompositorRef.current.updateOptions({ pipPosition, pipSize });
  }
}, [isScreenSharing, micGain, systemGain, pipPosition, pipSize]);
```

**Estimated CPU Reduction:** 5-10% during device switching

---

### 6. AudioMixer (LOW)
**File:** `client/src/services/AudioMixer.ts`

#### Current Issues:
| Issue | Location | Impact |
|-------|----------|--------|
| Track cloning | Lines 105-134 | Creates unnecessary copies |
| No source reuse on update | Lines 202-272 | Full reconnect on track change |

#### Recommended Changes:
```typescript
// 1. Connect directly without cloning (if track isn't used elsewhere)
// Test if cloning is actually required

// 2. Reuse MediaStreamSource when possible
updateMicTrack(newTrack: MediaStreamTrack): void {
  if (this.micSource) {
    this.micSource.disconnect();
  }
  // Reuse existing gain node connection
  const stream = new MediaStream([newTrack]);
  this.micSource = this.audioContext.createMediaStreamSource(stream);
  this.micSource.connect(this.micGain);
}
```

**Estimated CPU Reduction:** 2-5% during audio mixing

---

## Implementation Priority

### Phase 1: Quick Wins (No Breaking Changes)
| Change | File | Est. Effort | CPU Savings |
|--------|------|-------------|-------------|
| Remove debug `getImageData()` | EffectEngine.ts | 5 min | 20-30% |
| Reduce AudioLevelMeter FFT to 256 | AudioLevelMeter.tsx | 5 min | 30-40% |
| Throttle AudioLevelMeter to 30fps | AudioLevelMeter.tsx | 10 min | 20-30% |
| Stop EffectEngine when no effects | EffectEngine.ts | 15 min | 30-40% idle |

### Phase 2: Medium Effort
| Change | File | Est. Effort | CPU Savings |
|--------|------|-------------|-------------|
| Cache VideoCompositor PiP dimensions | VideoCompositor.ts | 20 min | 10-15% |
| Remove 5x setTimeout resize cascade | EffectEngine.ts | 30 min | Startup perf |
| Batch AudioLevelMeter state updates | AudioLevelMeter.tsx | 20 min | 10-15% |
| Memoize socket handlers | CanvasEffectOverlay.tsx | 45 min | 5-10% |

### Phase 3: Larger Refactors
| Change | File | Est. Effort | CPU Savings |
|--------|------|-------------|-------------|
| Debounce device changes | WebRTCStreamer.tsx | 1 hr | 5-10% |
| Refactor EffectEngine render loop | EffectEngine.ts | 2 hr | 20-30% |
| Use `alpha: false` canvas contexts | Multiple | 1 hr | 5-10% |

---

## Total Potential CPU Reduction

| Scenario | Current CPU | After Phase 1 | After Phase 2 | After Phase 3 |
|----------|-------------|---------------|---------------|---------------|
| Idle (no effects) | 15-25% | 5-10% | 3-5% | 2-3% |
| With effects | 30-50% | 20-35% | 15-25% | 10-20% |
| Screen share + PiP | 40-60% | 30-45% | 25-35% | 20-30% |

---

## Already Implemented ✅

1. **Dynacast enabled** - Pauses encoding unused simulcast layers
2. **H.264 codec** - Hardware-accelerated encoding (30-50% less CPU than VP8)
