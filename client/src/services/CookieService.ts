/**
 * Cookie Service for persisting user settings
 */

interface CookieOptions {
  expires?: number; // days
  path?: string;
  domain?: string;
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none';
}

class CookieService {
  /**
   * Set a cookie
   */
  static setCookie(name: string, value: any, options: CookieOptions = {}): void {
    const {
      expires = 365, // Default to 1 year
      path = '/',
      domain,
      secure = window.location.protocol === 'https:',
      sameSite = 'lax'
    } = options;

    let cookieString = `${encodeURIComponent(name)}=${encodeURIComponent(JSON.stringify(value))}`;
    
    // Add expiry date
    const date = new Date();
    date.setTime(date.getTime() + (expires * 24 * 60 * 60 * 1000));
    cookieString += `; expires=${date.toUTCString()}`;
    
    // Add path
    cookieString += `; path=${path}`;
    
    // Add domain if specified
    if (domain) {
      cookieString += `; domain=${domain}`;
    }
    
    // Add secure flag if needed
    if (secure) {
      cookieString += '; secure';
    }
    
    // Add SameSite attribute
    cookieString += `; SameSite=${sameSite}`;
    
    document.cookie = cookieString;
  }

  /**
   * Get a cookie value
   */
  static getCookie(name: string): any {
    const nameEQ = encodeURIComponent(name) + '=';
    const cookies = document.cookie.split(';');
    
    for (let cookie of cookies) {
      cookie = cookie.trim();
      if (cookie.indexOf(nameEQ) === 0) {
        try {
          const value = decodeURIComponent(cookie.substring(nameEQ.length));
          return JSON.parse(value);
        } catch (e) {
          // If JSON parsing fails, return the raw value
          return decodeURIComponent(cookie.substring(nameEQ.length));
        }
      }
    }
    
    return null;
  }

  /**
   * Delete a cookie
   */
  static deleteCookie(name: string, path: string = '/'): void {
    document.cookie = `${encodeURIComponent(name)}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=${path}`;
  }

  /**
   * Check if a cookie exists
   */
  static hasCookie(name: string): boolean {
    return CookieService.getCookie(name) !== null;
  }
}

// Specific cookie names for our settings
export const COOKIE_NAMES = {
  VOLUME: 'onestreamer_volume',
  MUTED: 'onestreamer_muted',
  STREAMER_SETTINGS: 'onestreamer_settings',
  AUDIO_SETTINGS: 'onestreamer_audio_settings',
  VIDEO_SETTINGS: 'onestreamer_video_settings'
};

export default CookieService;