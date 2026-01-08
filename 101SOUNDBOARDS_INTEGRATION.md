# 101soundboards.com Integration

This document describes the 101soundboards.com integration for OneStreamer.

## Overview

The integration allows users to play any sound from 101soundboards.com directly in the stream. All users will hear the sound when it's played.

## Features

- **101soundboards Item**: A utility item that lets users play sounds from 101soundboards.com
- **URL Input Dialog**: Simple dialog for entering the sound URL
- **Sound Queue**: Multiple sounds are queued and played sequentially (2 seconds between sounds)
- **60-Second Duration Limit**: Long sounds are automatically limited to 60 seconds
- **Chat Integration**: Sound playback is announced in chat
- **Cross-Platform Support**: Works with external audio URLs using CORS

## How to Use

1. **Obtain the Item**: Get the "101 Soundboards" item (📣) from the shop or inventory
2. **Use the Item**: Click on the item in your inventory
3. **Enter URL**: 
   - Visit [101soundboards.com](https://www.101soundboards.com)
   - Find a sound you like
   - Copy the sound's URL (e.g., `https://www.101soundboards.com/sounds/188391-potato`)
   - Paste it in the dialog
4. **Play Sound**: Click "Play Sound" and all users will hear it

## Technical Architecture

### Backend Components

- **SoundFxService** (`/server/services/SoundFxService.js`):
  - `queue101Soundboard()`: Queues sound requests
  - `processSoundboardQueue()`: Processes queued sounds with delays
  - `fetch101SoundboardData()`: Fetches sound data from API
  - 60-second duration limiting

- **Routes** (`/server/routes/soundfx.js`):
  - `POST /api/soundfx/item/soundboard`: Trigger soundboard item
  - `GET /api/soundfx/soundboard/queue`: Get queue status
  - `DELETE /api/soundfx/soundboard/queue`: Clear queue (admin)

- **Item Configuration**:
  - Name: `101soundboards`
  - Type: `utility`
  - Cooldown: 30 seconds
  - Price: 50 points

### Frontend Components

- **SoundboardInputModal** (`/client/src/components/soundfx/SoundboardInputModal.tsx`):
  - URL validation and normalization
  - User-friendly interface
  - Link to 101soundboards.com

- **SoundFxPlayer** (`/client/src/components/soundfx/SoundFxPlayer.tsx`):
  - `play101Soundboard()`: Plays external audio
  - CORS support
  - Automatic duration limiting on client side

### API Integration

The integration uses the 101soundboards.com API v1:
- **Sound Fetching**: `GET https://www.101soundboards.com/api/v1/sounds/{soundId}`
- **Search**: `GET https://www.101soundboards.com/api/v1/sounds?q={searchTerm}`

## Configuration

### Item Properties
```json
{
  "name": "101soundboards",
  "display_name": "101 Soundboards",
  "emoji": "📣",
  "cooldown_seconds": 30,
  "base_price": 50,
  "effect_data": {
    "type": "soundboard",
    "provider": "101soundboards",
    "requiresUrl": true,
    "maxDuration": 60
  }
}
```

### Queue Settings
- Queue delay: 2 seconds between sounds
- Max duration: 60 seconds per sound

## Testing

Run the test script to verify the integration:
```bash
node test-101soundboards-integration.js
```

This tests:
- URL parsing
- API connectivity
- Sound searching
- Duration limiting

## Future Enhancements

The architecture supports adding other soundboard providers:
- Each provider can have its own item
- Shared queue system for all soundboard types
- Provider-specific URL parsing and API integration
- Configurable duration limits per provider

## Troubleshooting

### Sound Not Playing
- Check browser console for CORS errors
- Verify the URL is from 101soundboards.com
- Ensure sound duration is under 60 seconds

### API Issues
- The API may rate limit requests
- Some sounds may be unavailable
- Check network connectivity

### Queue Issues
- Clear the queue using admin controls if needed
- Check server logs for processing errors