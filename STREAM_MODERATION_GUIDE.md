# Stream Moderation System Guide

## Overview

The Stream Moderation System provides administrators with powerful tools to manage and moderate live streams on OneStreamer. The system includes real-time stream disconnection and IP ban functionality to maintain platform integrity.

## Features

### 1. Moderation Panel UI
- **Location**: `/moderation-panel.html`
- **Access**: Admin authentication required
- **Display Position**: Fixed on the left side of the screen
- **Real-time Updates**: Automatically updates when streams start/end

### 2. Core Functionality

#### Stream Disconnection
- Immediately terminates the current stream
- Cleans up all associated resources
- Notifies the streamer and all viewers
- No cooldown applied (clean disconnect)

#### IP Ban System
- Permanently bans IP addresses from streaming
- Terminates all active connections from banned IP
- Prevents future connections from banned IPs
- Stored persistently in database

## Technical Implementation

### Database Schema

```sql
CREATE TABLE ip_bans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_address TEXT NOT NULL UNIQUE,
  banned_by_user_id INTEGER,
  banned_by_username TEXT,
  banned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  reason TEXT,
  permanent BOOLEAN DEFAULT 1,
  expires_at DATETIME,
  FOREIGN KEY (banned_by_user_id) REFERENCES users(id)
)
```

### API Endpoints

#### Admin Verification
```
GET /api/admin/verify
Headers: Authorization: Bearer <token>
Response: { success: true, isAdmin: true }
```

#### Get Stream Details
```
GET /api/admin/stream-details/:streamerId
Headers: Authorization: Bearer <token>
Response: {
  streamerId: string,
  ipAddress: string,
  startTime: string,
  connectionTime: string
}
```

#### Disconnect Stream
```
POST /api/admin/stream/disconnect
Headers: Authorization: Bearer <token>
Body: { streamerId: string }
Response: { success: true, message: string }
```

#### Ban IP Address
```
POST /api/admin/stream/ban-ip
Headers: Authorization: Bearer <token>
Body: {
  streamerId: string,
  ip?: string,  // Optional, will extract from socket if not provided
  reason?: string
}
Response: { success: true, message: string, ip: string }
```

#### List Banned IPs
```
GET /api/admin/banned-ips
Headers: Authorization: Bearer <token>
Response: { success: true, bannedIPs: array }
```

#### Unban IP Address
```
POST /api/admin/unban-ip
Headers: Authorization: Bearer <token>
Body: { ip: string }
Response: { success: true, message: string }
```

## Services

### IPBanService (`/server/services/IPBanService.js`)

Manages IP bans with the following features:
- In-memory cache for fast ban checking
- Automatic cleanup of expired temporary bans
- IP extraction from socket connections
- Support for IPv4 and IPv6 addresses
- Proxy-aware IP detection

Key Methods:
- `isIPBanned(ip)`: Check if an IP is banned
- `banIP(ip, userId, username, reason, permanent, expiresAt)`: Ban an IP
- `unbanIP(ip)`: Remove an IP ban
- `getBannedIPs()`: List all active bans
- `getIPFromSocket(socket)`: Extract real IP from socket

## Security Features

### Connection-Level Protection
- IP ban check on initial socket connection
- Immediate disconnection of banned IPs
- No resources allocated to banned connections

### Stream Request Protection
- Secondary IP ban check when streaming requested
- Prevents banned IPs from initiating streams
- Protects against ban evasion attempts

### Multi-Layer IP Detection
- Checks `x-forwarded-for` header for proxied connections
- Falls back to `x-real-ip` header
- Handles IPv6 to IPv4 conversion
- Removes IPv6 prefixes for consistency

## Usage Instructions

### For Administrators

1. **Access the Moderation Panel**
   - Navigate to `https://onestreamer.live/moderation-panel.html`
   - Login with admin credentials
   - Panel will appear on the left side of the screen

2. **Monitor Active Streams**
   - View current streamer information
   - See IP address and stream duration
   - Real-time status updates

3. **Disconnect a Stream**
   - Click "Disconnect Stream" button
   - Confirm the action in the modal
   - Stream will be immediately terminated

4. **Ban a Streamer's IP**
   - Click "Ban Streamer IP" button
   - Review the IP address in confirmation modal
   - Confirm to ban and disconnect

### Integration with Existing Systems

The moderation system integrates seamlessly with:
- Authentication system (JWT tokens)
- MediaSoup streaming infrastructure
- Session management
- Takeover service
- ViewBot detection

## Event Flow

### Stream Disconnection Flow
1. Admin clicks disconnect button
2. API validates admin authentication
3. Server clears streamer from StreamService
4. MediaSoup resources cleaned up
5. Socket emits `stream-disconnected-by-admin` to streamer
6. Socket forcefully disconnected
7. All viewers notified with `stream-ended` event

### IP Ban Flow
1. Admin clicks ban button
2. API validates admin authentication
3. IP added to ban database and cache
4. If streaming, stream terminated immediately
5. Socket emits `banned` event to affected connections
6. All sockets from banned IP disconnected
7. Future connections from IP rejected

## Monitoring and Logs

Key log messages to monitor:
- `🔨 MODERATION: Admin disconnecting stream [streamerId]`
- `🚫 MODERATION: IP [ip] banned by [username]`
- `🚫 CONNECTION: Banned IP attempted to connect: [ip]`
- `🚫 STREAMING: Banned IP [ip] attempted to stream`
- `✅ MODERATION: IP [ip] unbanned by [username]`

## Testing

Use the included test script:
```bash
ADMIN_TOKEN=your-token-here node test-moderation.js
```

This will verify:
- Admin authentication
- Stream information retrieval
- Stream details with IP
- Banned IP list access

## Best Practices

1. **Document Ban Reasons**: Always provide clear reasons when banning IPs
2. **Regular Review**: Periodically review banned IPs list
3. **Coordinate with Team**: Communicate moderation actions to team members
4. **Monitor Logs**: Watch for patterns in ban attempts
5. **Test First**: Use test environment before production moderation

## Troubleshooting

### Panel Not Appearing
- Verify admin authentication token
- Check browser console for errors
- Ensure WebSocket connection established

### Disconnect Not Working
- Verify stream is actually active
- Check server logs for errors
- Ensure MediaSoup is running properly

### IP Ban Not Effective
- Check if user is using VPN/proxy
- Verify IP extraction is working correctly
- Review server logs for ban bypass attempts

## Future Enhancements

Potential improvements for the moderation system:
- Temporary ban durations
- Ban reason categories
- Moderation action history
- Pattern-based auto-banning
- Geographic IP blocking
- Rate limiting per IP
- Moderation webhooks
- Audit trail for all actions

## Support

For issues or questions about the moderation system:
1. Check server logs for detailed error messages
2. Review this documentation
3. Test with the provided test script
4. Contact system administrators for assistance