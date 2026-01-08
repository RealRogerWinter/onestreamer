# OneStreamer

A real-time video streaming service where only one person can stream at a time. Viewers can take over the stream with a simple button click, subject to a 30-second cooldown period.

## Features

- **Single Stream Focus**: Only one streamer broadcasts at any time
- **Stream Takeover**: Anyone can take over the stream with dual cooldown system (global + individual)
- **Real-time Communication**: WebSocket-based signaling for instant stream handoffs
- **WebRTC Streaming**: Low-latency peer-to-peer video streaming
- **Live Chat**: Real-time chat with random animal usernames and colors
- **Responsive Design**: Works on desktop and mobile devices
- **Anonymous Usage**: No registration or authentication required

## Architecture

### Microservices
- **Stream Service**: Manages active streamer and viewer state
- **Takeover Service**: Handles stream takeover logic and cooldown enforcement
- **WebSocket Service**: Real-time communication for stream handoffs
- **Chat Service**: Real-time chat with WebSocket communication (port 8081)
- **Frontend Service**: React application with streaming interface

### Technology Stack
- **Backend**: Node.js, Express, Socket.IO, Redis (optional)
- **Frontend**: React, TypeScript, WebRTC APIs
- **Testing**: Jest for backend, React Testing Library for frontend

## Quick Start

### Prerequisites
- Node.js 18+ 
- npm

### Installation

1. Clone and install dependencies:
```bash
git clone <repository>
cd onestreamer
npm install
cd client && npm install && cd ..
```

2. Set up environment variables:
```bash
cp .env.example .env
```

3. Start the development servers:
```bash
npm run dev
```

This starts:
- Backend server on http://localhost:3001
- React frontend on http://localhost:3000

### Testing

Run all tests:
```bash
# Backend tests
npm test

# Frontend tests  
cd client && npm test
```

## Usage

1. Navigate to http://localhost:3000
2. If no one is streaming, click "Start Streaming" to go live
3. Allow camera/microphone access when prompted
4. Other viewers can click "Take Over Stream" to disconnect you and start their stream
5. There's a 30-second cooldown between stream takeovers

## Deployment

### Free Tier Options
- **Frontend**: Netlify, Vercel, GitHub Pages
- **Backend**: Railway, Render, Heroku (free tiers)
- **Database**: Redis Labs free tier (optional)

### Environment Variables
- `PORT`: Server port (default: 8080)
- `REDIS_URL`: Redis connection string (optional, uses in-memory fallback)
- `NODE_ENV`: Environment mode (development/production)
- `ADMIN_KEY`: Admin panel access key (default: onestreamer-admin-2024)
- `GLOBAL_COOLDOWN_SECONDS`: Time all users must wait after any stream starts (default: 30s production, 1s development)
- `INDIVIDUAL_COOLDOWN_SECONDS`: Time a user must wait after being taken over (default: 60s production, 1s development)

### Production Build
```bash
# Build frontend
cd client && npm run build

# Start production server
NODE_ENV=production npm start
```

## API Endpoints

### REST Endpoints
- `GET /health` - Server health check
- `GET /api/stream/status` - Current stream status

### WebSocket Events

#### Client → Server
- `join-as-viewer` - Join as a viewer
- `request-to-stream` - Request to take over stream
- `offer` - WebRTC offer for streaming
- `answer` - WebRTC answer for viewing
- `ice-candidate` - ICE candidate exchange
- `stop-streaming` - Stop current stream

#### Server → Client  
- `stream-status` - Current stream state
- `viewer-count-update` - Updated viewer count
- `streaming-approved` - Permission to start streaming
- `takeover-denied` - Stream takeover rejected
- `stream-takeover` - Your stream was taken over
- `new-streamer` - New streamer started
- `stream-ended` - Current stream ended

## Development

### Project Structure
```
onestreamer/
├── server/                 # Backend Node.js application
│   ├── services/          # Business logic services
│   ├── tests/             # Backend unit tests
│   └── index.js           # Main server file
├── client/                # React frontend application  
│   ├── src/
│   │   ├── components/    # React components
│   │   └── App.tsx        # Main application
│   └── public/            # Static assets
├── package.json           # Root dependencies & scripts
└── README.md             # This file
```

### Key Design Decisions

1. **WebRTC for Low Latency**: Direct peer-to-peer connections minimize streaming delay
2. **Stateless Server Design**: Stream state can be rebuilt from active connections
3. **Graceful Redis Fallback**: Works with or without Redis for session persistence
4. **Mobile-First UI**: Responsive design works across all device sizes
5. **Anonymous by Default**: No user accounts required for MVP

## Testing Coverage

- **Backend**: 96.7% statement coverage across services
- **Frontend**: Component unit tests for all UI elements
- **Integration**: WebSocket event handling and state management

## Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure all tests pass
5. Submit a pull request

## License

MIT License - see LICENSE file for details.

## Security Considerations

- WebRTC connections use STUN servers for NAT traversal
- No persistent data storage of user content
- Rate limiting should be added for production deployment
- HTTPS required for WebRTC in production environments

## Roadmap

### Phase 1 (Current)
- ✅ Basic streaming functionality
- ✅ Stream takeover with cooldown
- ✅ Responsive UI
- ✅ Unit test coverage

### Phase 2 (Future)
- Stream quality selection
- Chat functionality  
- Stream recording/replay
- User authentication (optional)
- Admin moderation tools
- Geographic load balancing