# Visual effects (VisualFX + CanvasFX)

_Last verified: 2026-05-23 against commit 4a1d325._

OneStreamer ships **two distinct effect systems** that often get conflated. They sit at different layers of the rendering pipeline:

| System | Where it runs | What it modifies | Examples |
|--------|---------------|------------------|----------|
| **VisualFX** | Server (FFmpeg / MediaSoup pipeline manipulation) | The video stream itself — resolution, bitrate, frame rate, pixel filters, network simulation | Pixelate, blur, packet loss, 240p, choppy 1 FPS |
| **CanvasFX** | Client (HTML canvas overlay rendered by every viewer) | An overlay layer *on top of* the video, leaving the underlying stream untouched | Tomato splat, confetti burst, smoke bomb, disco ball |

You'll often trigger a CanvasFX overlay from the same item that triggers a VisualFX effect — but they're independent subsystems with separate code paths.

---

## VisualFX (server-side stream manipulation)

### What it does

Real-time modification of the live video stream via MediaSoup configuration changes and/or FFmpeg processing pipelines. Effects are applied at the server and seen by all viewers automatically.

### Effect catalogue

#### Resolution effects
| ID | Effect |
|----|--------|
| `resolution_240p` | Ultra Low Resolution (426×240) |
| `resolution_360p` | Low Resolution (640×360) |
| `resolution_480p` | Medium Resolution (854×480) |

#### Bitrate effects
| ID | Effect |
|----|--------|
| `bitrate_potato` | Potato Quality (100 kbps video, 32 kbps audio) |
| `bitrate_low` | Low Bitrate (250 kbps video, 64 kbps audio) |
| `bitrate_throttle` | Bandwidth Throttle (500 kbps video, 96 kbps audio) |

#### Frame-rate effects
| ID | Effect |
|----|--------|
| `framerate_slideshow` | Slideshow Mode (1 FPS) |
| `framerate_choppy` | Choppy Video (10 FPS) |
| `framerate_cinematic` | Cinematic Mode (24 FPS) |

#### Network simulation
| ID | Effect |
|----|--------|
| `packet_loss_mild` | 2% packet loss |
| `packet_loss_severe` | 10% packet loss |
| `jitter` | 100 ms ± 50 ms jitter |

#### Visual filters
| ID | Effect |
|----|--------|
| `pixelate` | Pixelation |
| `blur` | Motion blur |
| `grayscale` | Black & white |
| `sepia` | Sepia tone |
| `static_noise` | TV static |
| `glitch` | Digital glitch |

#### Audio effects
| ID | Effect |
|----|--------|
| `audio_pitch_high` | Chipmunk voice |
| `audio_pitch_low` | Demon voice |
| `audio_echo` | Echo chamber |

#### Special
| ID | Effect |
|----|--------|
| `freeze_frame` | Freeze video for 3 seconds |
| `stutter` | Stutter pattern |

### Presets

Pre-composed combinations of effects for thematic chaos:

- `chaos_mode` — maximum degradation
- `retro_mode` — nostalgic pixelated experience
- `lag_fest` — network simulation nightmare
- `artistic` — film-look color grading
- `comedy_hour` — voice-modulation comedy

### HTTP API

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/visualfx/effects` | List available effects |
| `POST` | `/api/visualfx/apply` | Apply an effect: `{ effectId, streamId?, options: { duration?, ... } }` |
| `DELETE` | `/api/visualfx/remove/:effectInstanceId?streamId=...` | Remove a single effect |
| `DELETE` | `/api/visualfx/clear/:streamId` | Remove all effects on a stream |
| `GET` | `/api/visualfx/stats` | Active count, CPU, memory, queue depth |
| `GET` | `/api/visualfx/presets` | List preset names |
| `POST` | `/api/visualfx/preset/:presetName` | Apply a preset |

### Socket.IO API

Client → server:
- `apply-visual-effect` — `{ effectId, options: { duration, ... } }`
- `remove-visual-effect` — `{ effectInstanceId }`
- `get-visual-effects`
- `get-visual-fx-stats`

Server → client:
- `visual-effect-applied` — `{ effectName, duration, effectInstanceId, ... }`
- `visual-effect-removed` — `{ effectInstanceId }`
- `visual-effects-list` — full state of available + active
- `visual-effect-error` — `{ error }`

### Integration with items

The buff/item subsystem maps named items to VisualFX effects, so a viewer using `lag_spike` triggers `packet_loss_severe`. The mapping is in [`VisualFxService.js`](../../server/services/VisualFxService.js):

```js
{
  lag_spike:      'packet_loss_severe',
  potato_mode:    'resolution_240p',
  slow_motion:    'framerate_slideshow',
  glitch_bomb:    'glitch',
  static_storm:   'static_noise',
  voice_modulator:'audio_pitch_high',
  freeze_ray:     'freeze_frame',
}
```

### Resource limits

```js
maxEffectsPerStream:    5,
effectTimeout:          60_000,    // default duration if not specified (ms)
resourceCheckInterval:  5_000,
enableAdvancedProcessing: true,

resourceMonitor: {
  maxConcurrentEffects: 10,
  cpuThreshold:         70,        // %
  memoryThreshold:      1024,      // MB
}
```

Service queues effects when limits are hit, drops them when the queue itself is saturated. CPU/memory monitor will automatically throttle when thresholds exceed.

### Adding a new effect

1. Register in [`VisualFxService.js`](../../server/services/VisualFxService.js):
   ```js
   this.registerEffect('my_effect', {
     name: 'My Effect',
     type: 'filter',  // or 'resolution', 'bitrate', 'framerate', 'network', 'audio', 'special'
     parameters: { filter: 'some_ffmpeg_filter' },
     duration: 20_000,
     priority: 5,
     requiresProcessing: true,
   });
   ```
2. Implement the per-type handler (`applyFilterEffect`, `applyResolutionEffect`, etc.).
3. Implement cleanup in the corresponding `removeXxxEffect`.
4. If you want the item subsystem to trigger it, add an entry to the item-to-effect mapping.

---

## CanvasFX (client-side overlay)

### What it does

Renders animated overlays on top of every viewer's video element. The underlying video stream is untouched — these effects are pure client rendering. All viewers see the effect because the server broadcasts a trigger event over Socket.IO; each client's [`CanvasEffectOverlay.tsx`](../../client/src/components/canvas/CanvasEffectOverlay.tsx) draws it locally.

### Available effects

| Effect | Item / emoji | What it looks like |
|--------|--------------|-------------------|
| Tomato splat | 🍅 | Red splatter with drips |
| Confetti cannon | 🎊 | Colorful particle burst |
| Smoke bomb | 💨 | Smoke cloud overlay |
| Rainbow | 🌈 | Rainbow color filter overlay |
| Disco ball | 🪩 | Rotating lights + sparkles |
| Spotlight | 🌟 | Highlight effect |
| Freeze frame | 🧊 | Brief stream freeze with glitch |
| Speed boost | ⚡ | Speed lines |
| Slow mode | 🐌 | Time-warp effect |
| Golden microphone | 🎤 | Golden aura |
| Drawing | 🖌 | User-drawn freehand path, broadcast to all viewers in real time |
| Projectile (click-to-throw) | — | User clicks on video to throw an object at that position |

(The full effect set is implemented in [`client/src/services/effects/`](../../client/src/services/) plus the overlay component.)

### Trigger flow

```
viewer uses item → server runs ItemService → CanvasFxService triggers
                                          → server broadcasts `canvas-effect-trigger`
                                          → every connected client's CanvasEffectOverlay receives the event
                                          → effect plays for its configured duration on each client
                                          → effect auto-cleans up after duration
```

The drawing effect is special: it streams individual stroke segments via `drawing-path-start` / `drawing-path-update` / `drawing-path-complete`, which the server broadcasts so every viewer sees the strokes form in real time.

### Performance

- Canvas uses `requestAnimationFrame` for 60 fps animations.
- Max 10 concurrent effects per client to prevent overload.
- Particle pooling for complex animations.
- Real-time FPS counter visible in debug mode.

### Debug mode

Two ways to enable:

- **Keyboard shortcut**: while viewing a stream, press **Ctrl+Shift+D**. Click anywhere on the stream to trigger a test tomato splat. Debug panel shows the active effect count. Press Ctrl+Shift+D again to disable.
- **Console**: open DevTools, run `toggleCanvasDebug()`. A debug indicator appears top-right. Click on the stream to test effects. Run again to disable.

### Adding a new CanvasFX effect

1. Add the item to [`ItemService.createDefaultItems()`](../../server/services/ItemService.js).
2. Map the item to an effect type in [`CanvasFxService.getEffectConfig()`](../../server/services/CanvasFxService.js).
3. Create the renderer in [`client/src/services/effects/`](../../client/src/services/).
4. Add a case in the client's `EffectEngine.createEffectRenderer()` to wire the renderer in.

Effect config shape:

```js
{
  type: 'effectType',
  duration: 3000,        // ms
  config: {
    color: '#ff0000',
    particleCount: 50,
    animation: 'burst',
  },
}
```

### Server ↔ client events

- `canvas-effect-trigger` — broadcast the effect
- `canvas-effect-complete` — effect finished naturally
- `canvas-effect-cancelled` — effect aborted
- `canvas-effects-clear` — wipe all active effects (admin)
- `canvas-effects-sync` — periodic full state for late-joining viewers

---

## Troubleshooting

| Symptom | First check |
|---------|-------------|
| Effects don't show on viewers | Open browser console; look for `canvas-effect-trigger` events. If missing, check socket connection. |
| High server CPU under VisualFX load | `GET /api/visualfx/stats`; reduce `maxConcurrentEffects` or disable `enableAdvancedProcessing` for FFmpeg-heavy effects. |
| Stuck FFmpeg processes | `pgrep ffmpeg` on the server; kill orphans. The service's cleanup should handle this but doesn't always under crashes. |
| Effect not appearing on one viewer only | Their CanvasEffectOverlay component may be unmounted (mobile bg tab?) or their browser may be throttling rAF. |
| Drawing effect lags | High-frequency `drawing-path-update` events — server-side throttling lives in the broadcaster; check rate-limit config. |

## Code paths

| Concern | File |
|---------|------|
| VisualFX server | [`server/services/VisualFxService.js`](../../server/services/VisualFxService.js) |
| CanvasFX server | [`server/services/CanvasFxService.js`](../../server/services/CanvasFxService.js) |
| VisualFX routes | [`server/routes/visualfx.js`](../../server/routes/visualfx.js) |
| Canvas overlay client | [`client/src/components/canvas/CanvasEffectOverlay.tsx`](../../client/src/components/canvas/CanvasEffectOverlay.tsx) |
| Effect engine client | [`client/src/services/EffectEngine.ts`](../../client/src/services/EffectEngine.ts) |
| VisualFX client hook | [`client/src/hooks/useVisualFxProcessor.ts`](../../client/src/hooks/useVisualFxProcessor.ts) |
| Per-effect renderers | [`client/src/services/effects/`](../../client/src/services/) |

## See also

- [`items-and-buffs.md`](items-and-buffs.md) — how items trigger these effects
- [`streaming-and-takeover.md`](streaming-and-takeover.md) — the underlying stream that effects modify
- [`/docs/architecture/streaming-stack.md`](../architecture/streaming-stack.md) — where in the pipeline VisualFX taps in
