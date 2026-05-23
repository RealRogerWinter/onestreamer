const axios = require('axios');
const requireEnv = require('../config/requireEnv');

const TURNSTILE_SECRET_KEY = requireEnv('TURNSTILE_SECRET_KEY');

// Cloudflare Turnstile verification endpoint
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Middleware to verify Cloudflare Turnstile token
 * @param {boolean} required - Whether the verification is required or optional
 */
const verifyTurnstile = (required = true) => {
  return async (req, res, next) => {
    const token = req.body.turnstileToken || req.headers['cf-turnstile-response'];
    
    // If token is not provided
    if (!token) {
      if (required) {
        return res.status(400).json({ 
          error: 'Security verification required. Please complete the CAPTCHA.' 
        });
      }
      // Skip verification if not required and no token provided
      return next();
    }

    try {
      // Verify token with Cloudflare using form data
      const formData = new URLSearchParams();
      formData.append('secret', TURNSTILE_SECRET_KEY);
      formData.append('response', token);
      
      const remoteIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.ip;
      if (remoteIp) {
        // Extract first IP if there are multiple (from proxy chain)
        const firstIp = remoteIp.split(',')[0].trim();
        formData.append('remoteip', firstIp);
      }
      
      const response = await axios.post(TURNSTILE_VERIFY_URL, formData, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      const { success, 'error-codes': errorCodes, challenge_ts, hostname } = response.data;

      if (!success) {
        console.error('Turnstile verification failed:', errorCodes);
        
        // Map error codes to user-friendly messages
        let errorMessage = 'Security verification failed. Please try again.';
        
        if (errorCodes && errorCodes.length > 0) {
          if (errorCodes.includes('missing-input-secret')) {
            errorMessage = 'Server configuration error. Please contact support.';
          } else if (errorCodes.includes('invalid-input-secret')) {
            errorMessage = 'Invalid server configuration. Please contact support.';
          } else if (errorCodes.includes('missing-input-response')) {
            errorMessage = 'Security token missing. Please refresh and try again.';
          } else if (errorCodes.includes('invalid-input-response')) {
            errorMessage = 'Invalid security token. Please refresh and try again.';
          } else if (errorCodes.includes('bad-request')) {
            errorMessage = 'Invalid request. Please try again.';
          } else if (errorCodes.includes('timeout-or-duplicate')) {
            errorMessage = 'Security token expired or already used. Please refresh and try again.';
          } else if (errorCodes.includes('internal-error')) {
            errorMessage = 'Verification service error. Please try again later.';
          }
        }

        return res.status(400).json({ error: errorMessage });
      }

      // Optional: Check if the challenge is too old (e.g., older than 5 minutes)
      if (challenge_ts) {
        const challengeTime = new Date(challenge_ts).getTime();
        const currentTime = Date.now();
        const timeDiff = currentTime - challengeTime;
        
        // 5 minutes = 300000 milliseconds
        if (timeDiff > 300000) {
          return res.status(400).json({ 
            error: 'Security token expired. Please refresh and try again.' 
          });
        }
      }

      // Add verification result to request for logging purposes
      req.turnstileVerified = true;
      req.turnstileData = {
        challenge_ts,
        hostname,
        ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.ip
      };

      next();
    } catch (error) {
      console.error('Turnstile verification error:', error.message);
      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', error.response.data);
      }
      
      // If verification service is down, decide whether to fail open or closed
      if (required) {
        return res.status(503).json({ 
          error: 'Security verification service unavailable. Please try again later.' 
        });
      } else {
        // Fail open for non-required verification
        console.warn('Turnstile verification failed but allowing request to proceed');
        next();
      }
    }
  };
};

// Export middleware functions
module.exports = {
  verifyTurnstile,
  // Convenience methods
  requireTurnstile: verifyTurnstile(true),
  optionalTurnstile: verifyTurnstile(false)
};