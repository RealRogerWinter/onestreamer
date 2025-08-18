# CanvasFx Service - Visual Effects Guide

## Overview
The CanvasFx service adds interactive visual effects to the OneStreamer platform, allowing users to trigger animations that overlay on the stream without disrupting playback.

## Features

### Available Visual Effects
1. **🍅 Tomato** - Splat effect with dripping animation
2. **🎊 Confetti Cannon** - Colorful particle burst
3. **💨 Smoke Bomb** - Smoke cloud overlay
4. **🌈 Rainbow Effect** - Rainbow filter overlay
5. **🪩 Disco Ball** - Rotating lights and sparkles
6. **🌟 Spotlight** - Highlighting effect
7. **🧊 Freeze Frame** - Temporary stream freeze with glitch
8. **⚡ Speed Boost** - Speed lines effect
9. **🐌 Slow Mode** - Time warp effect
10. **🎤 Golden Microphone** - Golden aura effect

## How to Use

### For Users
1. **Purchase Items**: Go to the Shop and buy visual effect items
2. **Use Items**: Open your Inventory and click "Use" on any effect item
3. **Watch Effect**: The effect will appear on the stream for all viewers

### For Testing (Debug Mode)
**Method 1 - Keyboard Shortcut:**
1. While viewing a stream, press **Ctrl+Shift+D** to enable debug mode
2. Click anywhere on the stream to trigger a test tomato splat
3. Debug panel shows active effect count
4. Press **Ctrl+Shift+D** again to disable debug mode

**Method 2 - Console Command (Alternative):**
1. Open browser console (F12)
2. Type `toggleCanvasDebug()` and press Enter
3. Debug mode indicator appears in top-right corner
4. Click anywhere on the stream to test effects
5. Run `toggleCanvasDebug()` again to disable

## Architecture

### Server Components
- `server/services/CanvasFxService.js` - Main service handling effect triggers
- Integrates with ItemService and BuffDebuffService
- Broadcasts effects via Socket.io to all connected clients

### Client Components
- `client/src/components/canvas/CanvasEffectOverlay.tsx` - Canvas overlay component
- `client/src/services/EffectEngine.ts` - Animation engine
- `client/src/services/effects/` - Individual effect renderers

### Effect Flow
1. User uses item → ItemService processes → CanvasFxService triggers
2. Server broadcasts `canvas-effect-trigger` event to all clients
3. Clients render effect on canvas overlay
4. Effect auto-expires after duration

## Performance

### Optimizations
- Canvas uses `requestAnimationFrame` for smooth 60fps animations
- Maximum 10 concurrent effects to prevent overload
- Effects automatically clean up after completion
- Efficient particle pooling for complex animations

### Monitoring
- Real-time FPS counter in debug mode
- Active effect count tracking
- Automatic performance degradation if needed

## Adding New Effects

### Steps to Add a New Effect
1. Add item to `ItemService.createDefaultItems()`
2. Map item to effect in `CanvasFxService.getEffectConfig()`
3. Create effect renderer in `client/src/services/effects/`
4. Add case in `EffectEngine.createEffectRenderer()`

### Effect Configuration
```javascript
{
  type: 'effectType',
  duration: 3000,  // milliseconds
  config: {
    color: '#ff0000',
    particleCount: 50,
    animation: 'burst'
  }
}
```

## Troubleshooting

### Effects Not Appearing
1. Check browser console for errors
2. Verify socket connection is active
3. Ensure item has visual effect mapping
4. Check if max concurrent effects reached

### Performance Issues
1. Reduce concurrent effects limit
2. Lower particle counts
3. Disable complex animations (drips, glows)
4. Use Chrome/Edge for best performance

## Security

- Rate limiting on effect triggers
- User authentication required for item usage
- Effect parameters validated server-side
- No direct canvas manipulation from user input