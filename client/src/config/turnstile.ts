// Cloudflare Turnstile Configuration
// Site key is loaded from environment variable REACT_APP_TURNSTILE_SITE_KEY

export const TURNSTILE_SITE_KEY = process.env.REACT_APP_TURNSTILE_SITE_KEY || '0x4AAAAAABuXrP2d_bomYOGZ';

// Production site key: 0x4AAAAAABuXrP2d_bomYOGZ
// For testing, you can use these test keys:
// Always passes: 1x00000000000000000000AA
// Always fails: 2x00000000000000000000AB
// Always challenges: 3x00000000000000000000FF