# Visual Effects (VisualFX) Service Guide

## Overview

The VisualFX service provides real-time video stream manipulation capabilities for the OneStreamer platform. It can apply various effects to live video streams including resolution changes, bitrate throttling, visual filters, audio modifications, and network simulation.

## Features

### 🎬 Core Capabilities
- **Real-time video manipulation** through MediaSoup integration
- **30+ built-in effects** including visual, audio, and network simulation
- **Effect combinations and presets** for complex scenarios
- **Resource monitoring** and automatic throttling
- **API and Socket.IO interfaces** for flexible control
- **Buff/Debuff integration** for game-like mechanics

### 🎯 Effect Categories

#### Resolution Effects
- `resolution_240p` - Ultra Low Resolution (426x240)
- `resolution_360p` - Low Resolution (640x360)
- `resolution_480p` - Medium Resolution (854x480)

#### Bitrate Effects
- `bitrate_potato` - Potato Quality (100kbps video, 32kbps audio)
- `bitrate_low` - Low Bitrate (250kbps video, 64kbps audio)
- `bitrate_throttle` - Bandwidth Throttle (500kbps video, 96kbps audio)

#### Frame Rate Effects
- `framerate_slideshow` - Slideshow Mode (1 FPS)
- `framerate_choppy` - Choppy Video (10 FPS)
- `framerate_cinematic` - Cinematic Mode (24 FPS)

#### Network Simulation
- `packet_loss_mild` - Mild Packet Loss (2%)
- `packet_loss_severe` - Severe Packet Loss (10%)
- `jitter` - Network Jitter (100ms ± 50ms)

#### Visual Filters
- `pixelate` - Pixelation effect
- `blur` - Motion blur
- `grayscale` - Black & white
- `sepia` - Sepia tone
- `static_noise` - TV static
- `glitch` - Digital glitch effects

#### Audio Effects
- `audio_pitch_high` - Chipmunk voice
- `audio_pitch_low` - Demon voice
- `audio_echo` - Echo chamber

#### Special Effects
- `freeze_frame` - Freeze video for 3 seconds
- `stutter` - Video stuttering pattern

## API Usage

### Base URL
```
http://localhost:8080/api/visualfx
```

### Endpoints

#### Get Available Effects
```http
GET /api/visualfx/effects
```

**Response:**
```json
{
  "success": true,
  "effects": [
    {
      "id": "resolution_240p",
      "name": "Ultra Low Resolution",
      "type": "resolution",
      "parameters": {
        "width": 426,
        "height": 240,
        "spatialLayer": 0
      },
      "duration": 30000,
      "priority": 5
    }
  ],
  "totalEffects": 30
}
```

#### Apply Effect
```http
POST /api/visualfx/apply
```

**Request Body:**
```json
{
  "effectId": "pixelate",
  "streamId": "optional_stream_id",
  "options": {
    "duration": 15000,
    "customParam": "value"
  }
}
```

**Response:**
```json
{
  "success": true,
  "effect": {
    "id": "pixelate_1234567890",
    "effectId": "pixelate",
    "streamId": "stream_123",
    "startTime": 1234567890000,
    "duration": 15000,
    "status": "active"
  },
  "message": "Applied effect \"Pixelation\" to stream stream_123"
}
```

#### Remove Effect
```http
DELETE /api/visualfx/remove/{effectInstanceId}?streamId=optional
```

#### Clear All Effects
```http
DELETE /api/visualfx/clear/{streamId}
```

#### Get Service Stats
```http
GET /api/visualfx/stats
```

**Response:**
```json
{
  "success": true,
  "stats": {
    "activeEffects": 3,
    "queuedEffects": 1,
    "processingPipelines": 2,
    "rtpInterceptors": 1,
    "cpuUsage": "25.5%",
    "memoryUsage": "256.8 MB",
    "totalEffectsRegistered": 30
  }
}
```

#### Apply Preset
```http
POST /api/visualfx/preset/{presetName}
```

Available presets:
- `chaos_mode` - Maximum chaos with multiple degradation effects
- `retro_mode` - Nostalgic pixelated experience
- `lag_fest` - Network simulation nightmare
- `artistic` - Artistic film look
- `comedy_hour` - Comedy effects with voice modulation

#### Get Available Presets
```http
GET /api/visualfx/presets
```

## Socket.IO Usage

### Events to Emit

#### Apply Effect
```javascript
socket.emit('apply-visual-effect', {
  effectId: 'pixelate',
  options: {
    duration: 10000
  }
});
```

#### Remove Effect
```javascript
socket.emit('remove-visual-effect', {
  effectInstanceId: 'pixelate_1234567890'
});
```

#### Get Effects List
```javascript
socket.emit('get-visual-effects');
```

#### Get Stats
```javascript
socket.emit('get-visual-fx-stats');
```

### Events to Listen For

#### Effect Applied
```javascript
socket.on('visual-effect-applied', (data) => {
  console.log(`Effect applied: ${data.effectName} for ${data.duration}ms`);
});
```

#### Effect Removed
```javascript
socket.on('visual-effect-removed', (data) => {
  console.log(`Effect removed: ${data.effectInstanceId}`);
});
```

#### Effects List
```javascript
socket.on('visual-effects-list', (data) => {
  console.log(`Available: ${data.availableEffects.length}, Active: ${data.activeEffects.length}`);
});
```

#### Error Handling
```javascript
socket.on('visual-effect-error', (error) => {
  console.error('Visual effect error:', error.error);
});
```

## Integration with Existing Systems

### Buff/Debuff Integration

The VisualFX service automatically integrates with the existing buff system. When certain items are used, they trigger corresponding visual effects:

```javascript
// Item name -> Effect mapping
const effectMapping = {
  'lag_spike': 'packet_loss_severe',
  'potato_mode': 'resolution_240p',
  'slow_motion': 'framerate_slideshow',
  'glitch_bomb': 'glitch',
  'static_storm': 'static_noise',
  'voice_modulator': 'audio_pitch_high',
  'freeze_ray': 'freeze_frame'
};
```

### Adding New Effects

To add a new effect to the service:

1. **Register the effect** in `VisualFxService.js`:
```javascript
this.registerEffect('my_new_effect', {
  name: 'My New Effect',
  type: 'filter', // or 'resolution', 'bitrate', etc.
  parameters: { 
    filter: 'some_ffmpeg_filter_here'
  },
  duration: 20000,
  priority: 5,
  requiresProcessing: true // if needs FFmpeg processing
});
```

2. **Implement the effect handler** in the appropriate `apply*Effect` method.

3. **Add cleanup logic** in the corresponding `remove*Effect` method.

### Service Architecture

```
VisualFxService
├── Effect Registry (Map of all available effects)
├── Active Effects (Map of currently running effects per stream)
├── Effect Queue (Queue for resource-limited scenarios)
├── RTP Interceptors (Network simulation handlers)
├── Processing Pipelines (FFmpeg instances for complex effects)
└── Resource Monitor (CPU/Memory tracking)
```

## Testing

Run the comprehensive test suite:

```bash
node test-visual-effects.js
```

The test suite covers:
- ✅ API endpoint functionality
- ✅ Socket.IO event handling
- ✅ Effect application and removal
- ✅ Preset combinations
- ✅ Statistics endpoints
- ✅ Stress testing with multiple effects
- ✅ Error handling

## Configuration

Key configuration options in `VisualFxService.js`:

```javascript
this.config = {
  maxEffectsPerStream: 5,        // Max concurrent effects per stream
  effectTimeout: 60000,          // Default effect timeout (60s)
  resourceCheckInterval: 5000,   // Resource monitoring interval
  enableAdvancedProcessing: true // Enable FFmpeg processing
};

this.resourceMonitor = {
  maxConcurrentEffects: 10,      // Global effect limit
  cpuThreshold: 70,              // CPU usage limit (%)
  memoryThreshold: 1024          // Memory limit (MB)
};
```

## Performance Considerations

### Resource Usage
- **CPU**: Effects using FFmpeg processing are CPU-intensive
- **Memory**: Video processing requires significant memory
- **Network**: Some effects modify network characteristics

### Optimization Tips
1. **Limit concurrent effects** to prevent resource exhaustion
2. **Use priority system** to ensure important effects are applied
3. **Monitor resource usage** and implement automatic throttling
4. **Clean up effects promptly** when they expire

### MediaSoup Integration
The service works directly with MediaSoup's:
- **Producers** for source stream manipulation
- **Consumers** for viewer-specific effects
- **Transports** for network-level simulation
- **RTP Parameters** for codec and quality control

## Troubleshooting

### Common Issues

#### Effect Not Applied
- Check if there's an active stream
- Verify resource limits aren't exceeded
- Check MediaSoup service status

#### High CPU Usage
- Reduce concurrent effects
- Disable advanced processing for some effects
- Check for stuck FFmpeg processes

#### MediaSoup Errors
- Ensure MediaSoup service is properly initialized
- Check transport and producer states
- Verify RTP parameter compatibility

#### Network Effects Not Working
- Check if RTP interceptors are properly registered
- Verify transport access for packet manipulation
- Ensure proper cleanup of interceptors

### Debug Logging
Enable debug logging by setting:
```javascript
console.log('🎬 VISUALFX: Effect applied...'); // Service logs
console.log('📡 MEDIASOUP: Transport state...'); // MediaSoup logs
console.log('🔧 FFMPEG: Processing pipeline...'); // FFmpeg logs
```

## Advanced Usage

### Custom Effect Development

Create a custom effect by extending the service:

```javascript
// 1. Register the effect
visualFxService.registerEffect('custom_rainbow', {
  name: 'Rainbow Effect',
  type: 'filter',
  parameters: {
    filter: 'hue=H=2*PI*t'
  },
  duration: 30000,
  priority: 4,
  requiresProcessing: true
});

// 2. Apply via API or Socket
await visualFxService.applyEffect(streamId, 'custom_rainbow');
```

### Effect Combinations
```javascript
// Apply multiple effects in sequence
const effects = ['pixelate', 'grayscale', 'audio_pitch_high'];
for (const effectId of effects) {
  await visualFxService.applyEffect(streamId, effectId, {
    duration: 20000
  });
  await sleep(2000); // 2 second delay between effects
}
```

### Real-time Control Panel
Create a web interface for effect control:

```html
<!DOCTYPE html>
<html>
<head>
    <title>Visual Effects Control Panel</title>
    <script src="/socket.io/socket.io.js"></script>
</head>
<body>
    <div id="effects-panel">
        <!-- Effects will be populated here -->
    </div>
    
    <script>
        const socket = io();
        
        // Get available effects
        socket.emit('get-visual-effects');
        
        socket.on('visual-effects-list', (data) => {
            const panel = document.getElementById('effects-panel');
            data.availableEffects.forEach(effect => {
                const button = document.createElement('button');
                button.textContent = effect.name;
                button.onclick = () => {
                    socket.emit('apply-visual-effect', {
                        effectId: effect.id
                    });
                };
                panel.appendChild(button);
            });
        });
    </script>
</body>
</html>
```

## Future Enhancements

### Planned Features
- 🎨 **Real-time effect parameters** - Adjust effects while they're running
- 🎮 **Game integration** - Trigger effects based on game events
- 👥 **Viewer voting** - Let viewers vote on which effects to apply
- 📊 **Analytics** - Track effect usage and viewer engagement
- 🎯 **Targeted effects** - Apply effects to specific viewers
- 🎪 **Effect marketplace** - User-generated effects
- 🤖 **AI-driven effects** - Automatic effect suggestions based on content

### Extension Points
- **Custom RTP processing** for network effects
- **GPU acceleration** for intensive visual filters
- **WebRTC statistics** integration for adaptive effects
- **Machine learning** for intelligent effect timing

---

## Support

For issues or questions about the VisualFX service:

1. Check the debug logs for error details
2. Run the test suite to verify functionality
3. Review MediaSoup service status
4. Monitor resource usage and limits

The VisualFX service is designed to be robust and handle edge cases gracefully, but proper monitoring and configuration are essential for optimal performance.