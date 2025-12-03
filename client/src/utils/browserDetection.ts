/**
 * Browser detection utilities for handling platform-specific streaming issues
 */

/**
 * Detects if the device is iOS/iPadOS
 * iPadOS 13+ in desktop mode reports as Mac, so we check maxTouchPoints
 */
const isIOSDevice = (): boolean => {
  const ua = navigator.userAgent;
  // Standard iOS detection
  const isStandardIOS = /iPad|iPhone|iPod/.test(ua) && !(window as any).MSStream;
  // iPadOS 13+ in desktop mode - reports as Mac but has touch support
  const isIPadOSDesktopMode = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  return isStandardIOS || isIPadOSDesktopMode;
};

/**
 * Detects if the browser is Safari on iOS (iPhone, iPad, iPod)
 * Includes iPadOS in desktop mode
 */
export const isIOSSafari = (): boolean => {
  const ua = navigator.userAgent;
  const iOS = isIOSDevice();
  const webkit = /WebKit/.test(ua);
  const safari = /Safari/.test(ua) && !/Chrome/.test(ua) && !/CriOS/.test(ua);
  return iOS && webkit && safari;
};

/**
 * Detects if the browser is any iOS browser (including Chrome on iOS)
 * Includes iPadOS in desktop mode
 */
export const isIOS = (): boolean => {
  return isIOSDevice();
};

/**
 * Detects if the browser is Safari (any platform)
 */
export const isSafari = (): boolean => {
  const ua = navigator.userAgent;
  return /Safari/.test(ua) && !/Chrome/.test(ua) && !/CriOS/.test(ua);
};

/**
 * Detects if the device is on a mobile network
 */
export const isMobileNetwork = (): boolean => {
  const connection = (navigator as any).connection || 
                    (navigator as any).mozConnection || 
                    (navigator as any).webkitConnection;
  
  if (!connection) return false;
  
  const effectiveType = connection.effectiveType;
  return effectiveType === '3g' || effectiveType === '2g' || effectiveType === 'slow-2g';
};

/**
 * Detects if the device is mobile (any mobile browser)
 */
export const isMobile = (): boolean => {
  const ua = navigator.userAgent;
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
};

/**
 * Gets detailed browser info for debugging
 */
export const getBrowserInfo = (): {
  isIOSSafari: boolean;
  isIOS: boolean;
  isSafari: boolean;
  isMobile: boolean;
  isMobileNetwork: boolean;
  userAgent: string;
  platform: string;
} => {
  return {
    isIOSSafari: isIOSSafari(),
    isIOS: isIOS(),
    isSafari: isSafari(),
    isMobile: isMobile(),
    isMobileNetwork: isMobileNetwork(),
    userAgent: navigator.userAgent,
    platform: navigator.platform
  };
};