/**
 * Cookie Service for persisting user settings with consent management
 */

import CookieConsentService from './CookieConsentService';

interface CookieOptions {
  expires?: number; // days
  path?: string;
  domain?: string;
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none';
}

// Memory storage fallback for when consent is denied
class MemoryStorage {
  private static storage: Map<string, any> = new Map();

  static set(key: string, value: any): void {
    this.storage.set(key, value);
  }

  static get(key: string): any {
    return this.storage.get(key) || null;
  }

  static remove(key: string): void {
    this.storage.delete(key);
  }

  static has(key: string): boolean {
    return this.storage.has(key);
  }
}

class CookieService {
  /**
   * Set a cookie (checks for consent first)
   */
  static setCookie(name: string, value: any, options: CookieOptions = {}): void {
    // Try to check consent, but if service isn't initialized yet, proceed with cookie setting
    // The CookieConsentService will clear non-consented cookies when initialized
    try {
      if (CookieConsentService.isInitialized() && !CookieConsentService.hasConsent('functional')) {
        // Use memory storage as fallback
        MemoryStorage.set(name, value);
        return;
      }
    } catch (e) {
      // If consent service isn't ready, proceed with setting cookie
      // It will be managed when consent is initialized
    }

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
   * Get a cookie value (checks memory storage if no consent)
   */
  static getCookie(name: string): any {
    // Try to check consent, but if service isn't initialized, try to get cookie normally
    try {
      if (CookieConsentService.isInitialized() && !CookieConsentService.hasConsent('functional')) {
        return MemoryStorage.get(name);
      }
    } catch (e) {
      // If consent service isn't ready, try to get cookie normally
    }

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
    
    // Fallback to memory storage if cookie not found
    return MemoryStorage.get(name);
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
    try {
      if (CookieConsentService.isInitialized() && !CookieConsentService.hasConsent('functional')) {
        return MemoryStorage.has(name);
      }
    } catch (e) {
      // If consent service isn't ready, check cookie normally
    }
    return CookieService.getCookie(name) !== null;
  }
}

// Specific cookie names for our settings
export const COOKIE_NAMES = {
  VOLUME: 'onestreamer_volume',
  MUTED: 'onestreamer_muted',
  STREAMER_SETTINGS: 'onestreamer_settings',
  AUDIO_SETTINGS: 'onestreamer_audio_settings',
  VIDEO_SETTINGS: 'onestreamer_video_settings',
  CHAT_SETTINGS: 'onestreamer_chat_settings',
  STATUS_EFFECTS_VISIBLE: 'onestreamer_status_effects_visible'
};

export default CookieService;