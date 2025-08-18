# OneStreamer Chat Service

A real-time chat microservice for OneStreamer that provides live chat functionality for stream viewers.

## Features

- **Real-time WebSocket communication** using Socket.io
- **Random animal usernames** with unique colors for each user
- **Chat message history** (last 100 messages stored in memory)
- **Live user count tracking**
- **Message sanitization** and length limits (500 characters max)
- **Automatic reconnection handling**
- **Health check endpoint** for monitoring

## API

### HTTP Endpoints

- `GET /health` - Health check endpoint returning service status

### WebSocket Events

#### Client to Server
- `send-message` - Send a chat message
  ```json
  { "message": "Hello everyone!" }
  ```

#### Server to Client
- `user-assigned` - User assigned username and color
  ```json
  {
    "username": "Lion1234",
    "color": "#FF6B6B",
    "userId": "socket-id"
  }
  ```

- `chat-history` - Recent chat messages (sent on connection)
  ```json
  [
    {
      "id": "uuid",
      "username": "Tiger5678",
      "color": "#4ECDC4",
      "message": "Hello!",
      "timestamp": "14:30",
      "fullTimestamp": "2025-08-08T14:30:00.000Z",
      "userId": "socket-id"
    }
  ]
  ```

- `new-message` - New chat message broadcast
  ```json
  {
    "id": "uuid",
    "username": "Bear9999",
    "color": "#45B7D1",
    "message": "How's everyone doing?",
    "timestamp": "14:31",
    "fullTimestamp": "2025-08-08T14:31:00.000Z",
    "userId": "socket-id"
  }
  ```

- `user-count-update` - Live user count update
  ```json
  {
    "count": 42,
    "timestamp": "2025-08-08T14:31:00.000Z"
  }
  ```

## Configuration

### Environment Variables

- `CHAT_PORT` - Port number (default: 8081)
- `NODE_ENV` - Environment mode

### CORS Configuration

The service is configured to allow connections from:
- `http://localhost:3000` (React development server)
- `http://localhost:8080` (Main OneStreamer server)

## Running the Service

### Development
```bash
npm run dev
```

### Production
```bash
npm start
```

### With OneStreamer
The chat service is automatically started when running OneStreamer:
```bash
npm run dev  # Includes chat service
npm run dev-with-chat  # Explicitly includes chat
npm run dev-no-chat  # Excludes chat service
```

## Username Generation

The service automatically assigns each user a random username consisting of:
- An animal name from a curated list of 50 animals
- A random number from 1-9999
- A random color from a palette of 24 colors

Examples:
- `Lion1234` in red (`#FF6B6B`)
- `Tiger5678` in teal (`#4ECDC4`)
- `Bear9999` in blue (`#45B7D1`)

## Message Format

Chat messages are displayed in the format:
```
[HH:MM] Username: Message content
```

Example:
```
[14:30] Lion1234: Hello everyone!
[14:31] Tiger5678: Hey there!
```

## Architecture

The chat service is designed as a microservice that:
- Runs independently on its own port (8081)
- Communicates with the main OneStreamer frontend via WebSockets
- Maintains its own message history and user session state
- Can be scaled independently if needed

## Monitoring

Health check endpoint provides service status:
```bash
curl http://localhost:8081/health
```

Response:
```json
{
  "status": "ok",
  "service": "onestreamer-chat",
  "connectedUsers": 5,
  "messagesInHistory": 23,
  "timestamp": "2025-08-08T14:30:00.000Z"
}
```