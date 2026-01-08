# 🎵 Audio Settings UI - User Guide

## Overview

The streaming interface now includes configurable audio settings that allow you to control audio processing in real-time. These settings are accessible through the **Audio Settings** button in the streaming interface.

## How to Access

1. Open the OneStreamer app in your browser
2. When on the streaming page, look for the **🎵 Audio Settings** button in the top-left corner
3. Click to toggle the settings panel open/closed

## Available Settings

### Quick Presets

Choose from 4 pre-configured profiles:

1. **Raw Audio** (Default)
   - All processing disabled
   - Best for music, testing, or when you want unprocessed audio
   - No echo cancellation, noise suppression, or gain control
   - May include background noise and echo

2. **Voice Chat**
   - Optimized for speaking
   - Echo cancellation: ON
   - Noise suppression: ON
   - Auto gain control: ON
   - Lower sample rate (16 kHz) for efficient voice transmission

3. **Music**
   - High quality for music streaming
   - All processing disabled to preserve audio fidelity
   - 48 kHz sample rate
   - Stereo channels

4. **Streaming**
   - Balanced settings for general streaming
   - Echo cancellation: ON
   - Noise suppression: ON
   - Auto gain control: OFF (to prevent distortion)
   - 48 kHz stereo

### Individual Controls

Fine-tune each setting:

- **Echo Cancellation**: Removes echo/feedback from speakers
- **Noise Suppression**: Reduces background noise
- **Auto Gain Control**: Automatically adjusts volume levels
- **Sample Rate**: Choose from 16/24/44.1/48 kHz
- **Channels**: Mono (1) or Stereo (2)

## Important Notes

### Settings Persistence
- Your settings are automatically saved to browser localStorage
- Settings persist between sessions
- Each browser/device maintains its own settings

### When Settings Apply
- **Before streaming**: Changes apply immediately when you start streaming
- **During streaming**: Changes will apply on the next stream (shown as warning)
- You must stop and restart streaming for changes to take effect while live

### Chrome-Specific Settings
The following Chrome-specific settings are automatically managed based on your choices:
- `googEchoCancellation`
- `googNoiseSuppression`
- `googAutoGainControl`
- `googNoiseReduction`

Voice Activity Detection (VAD) is always disabled to prevent audio cutoff issues.

## Troubleshooting

### Audio Still Cutting Out?
1. Ensure you've restarted the server after the initial fix
2. Verify "Raw Audio" preset is selected
3. Clear browser cache (Ctrl+Shift+R)
4. Check Windows audio enhancements are disabled

### Echo Issues?
1. Enable "Echo Cancellation"
2. Use headphones instead of speakers
3. Reduce speaker volume
4. Move microphone away from speakers

### Too Much Background Noise?
1. Enable "Noise Suppression"
2. Switch from "Raw Audio" to "Streaming" preset
3. Consider using the "Voice Chat" preset for speaking

### Volume Too Low/High?
1. Toggle "Auto Gain Control"
2. Adjust microphone gain in system settings
3. Use "Voice Chat" preset for consistent levels

## Best Practices

### For Music Streaming
- Use "Music" or "Raw Audio" preset
- Disable all processing
- Use 48 kHz sample rate
- Select Stereo channels

### For Gaming/Chatting
- Use "Voice Chat" or "Streaming" preset
- Enable echo cancellation if not using headphones
- Enable noise suppression for cleaner audio
- Consider Mono for bandwidth efficiency

### For Professional Recording
- Use "Raw Audio" preset
- Record at 48 kHz stereo
- Apply processing in post-production
- Monitor levels with the audio meter

## Technical Details

### Default Settings (Raw Audio)
```javascript
{
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  sampleRate: 48000,
  channelCount: 2,
  profile: 'raw'
}
```

### Server-Side Configuration
The server has been configured with:
- DTX (Discontinuous Transmission): **DISABLED**
- VAD (Voice Activity Detection): **DISABLED**
- Opus codec optimized for streaming
- No server-side audio processing

This ensures your client-side settings have full control over audio processing.

## Updates

### Version 1.0 (Current)
- Initial implementation
- 4 presets (Raw, Voice, Music, Streaming)
- Individual control toggles
- Settings persistence
- Real-time UI updates

### Planned Features
- Visual EQ display
- Advanced codec settings
- Per-preset customization
- Import/export settings
- Keyboard shortcuts

## Support

If you experience issues:
1. Try the "Raw Audio" preset first
2. Clear browser cache
3. Restart the streaming server
4. Check browser console for errors (F12)

For persistent problems, check the server logs:
```bash
tail -f C:/onestreamer/server/server.log
```