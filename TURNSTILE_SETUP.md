# Cloudflare Turnstile Integration

## Overview
Cloudflare Turnstile has been integrated into the OneStreamer application to provide bot protection for all user input forms.

## Protected Forms
The following forms are now protected with Turnstile:
1. **User Registration** (`/client/src/components/Signup.tsx`)
2. **User Login** (`/client/src/components/Login.tsx`)
3. **Password Reset** (`/client/src/components/Login.tsx`)
4. **Bug Report** (`/client/src/components/BugReportModal.tsx`)

## Configuration

### Site Key (Client-side)
- **Production Key**: `0x4AAAAAABuXrP2d_bomYOGZ`
- Location: `/client/.env`
- Environment Variable: `REACT_APP_TURNSTILE_SITE_KEY`

### Secret Key (Server-side)
- **Production Key**: `***REMOVED-TURNSTILE-SECRET***`
- Location: `/.env`
- Environment Variable: `TURNSTILE_SECRET_KEY`

## Implementation Details

### Client-Side Components

1. **Turnstile Component** (`/client/src/components/CloudflareTurnstile.tsx`)
   - Reusable React component wrapper for Turnstile widget
   - Handles token generation, expiration, and errors
   - Supports theme customization and various configuration options

2. **Configuration** (`/client/src/config/turnstile.ts`)
   - Centralized configuration for site key
   - Fallback to test keys for development

### Server-Side Verification

1. **Middleware** (`/server/middleware/turnstile.js`)
   - Verifies Turnstile tokens with Cloudflare API
   - Provides both required and optional verification modes
   - Handles various error scenarios with user-friendly messages

2. **Protected Routes**
   - `/auth/signup` - Registration endpoint
   - `/auth/login` - Login endpoint
   - `/auth/forgot-password` - Password reset endpoint
   - `/api/bug-reports` - Bug report submission

## Testing

### Test Keys
For development and testing, you can use these special keys:

**Site Keys:**
- `1x00000000000000000000AA` - Always passes
- `2x00000000000000000000AB` - Always fails
- `3x00000000000000000000FF` - Always challenges

**Secret Keys:**
- `1x0000000000000000000000000000000AA` - Always passes
- `2x0000000000000000000000000000000AB` - Always fails
- `3x0000000000000000000000000000000FF` - Always challenges

### Testing Process
1. Ensure environment variables are set correctly
2. Restart both client and server applications
3. Test each form to verify Turnstile widget appears
4. Submit forms to verify server-side validation works

## Troubleshooting

### Widget Not Appearing
- Check that Turnstile script is loaded in `index.html`
- Verify site key is correctly set in environment variables
- Check browser console for JavaScript errors

### Verification Failing
- Ensure secret key matches the site key pair
- Check server logs for specific error codes
- Verify network connectivity to Cloudflare API

### Common Error Messages
- "Security verification required" - Token not provided
- "Security token expired" - Token older than 5 minutes
- "Invalid security token" - Token validation failed
- "Security verification service unavailable" - Cloudflare API down

## Security Best Practices

1. **Never expose the secret key** in client-side code
2. **Always verify tokens server-side** before processing requests
3. **Implement rate limiting** in addition to Turnstile
4. **Monitor failed verifications** for potential attacks
5. **Keep keys secure** and rotate them periodically

## Monitoring

- Failed verification attempts are logged server-side
- Each verification includes IP address and timestamp
- Monitor `/var/log/onestreamer/` for security events

## Support

For issues with Turnstile integration:
1. Check Cloudflare Turnstile dashboard for widget analytics
2. Review server logs for verification errors
3. Ensure all environment variables are correctly set
4. Contact Cloudflare support for platform-specific issues