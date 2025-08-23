/**
 * Device detection utilities for responsive behavior
 */

/**
 * Detects if the current device is a mobile device
 * Uses both user agent detection and viewport width
 */
export const isMobileDevice = (): boolean => {
  // Check user agent for mobile devices
  const userAgentCheck = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent
  );
  
  // Also check viewport width for responsive behavior
  const viewportCheck = window.innerWidth <= 768;
  
  return userAgentCheck || viewportCheck;
};

/**
 * Detects if the current device is a tablet
 */
export const isTabletDevice = (): boolean => {
  const userAgent = navigator.userAgent;
  const isIPad = /iPad/i.test(userAgent) || 
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroidTablet = /Android/i.test(userAgent) && !/Mobile/i.test(userAgent);
  
  // Also check viewport width for tablet range
  const viewportCheck = window.innerWidth > 768 && window.innerWidth <= 1024;
  
  return isIPad || isAndroidTablet || viewportCheck;
};

/**
 * Detects if the device supports touch
 */
export const isTouchDevice = (): boolean => {
  return (
    'ontouchstart' in window ||
    navigator.maxTouchPoints > 0 ||
    (navigator as any).msMaxTouchPoints > 0
  );
};

/**
 * Gets the current device type
 */
export type DeviceType = 'mobile' | 'tablet' | 'desktop';

export const getDeviceType = (): DeviceType => {
  if (isMobileDevice()) return 'mobile';
  if (isTabletDevice()) return 'tablet';
  return 'desktop';
};

/**
 * Detects if the browser is Chrome on mobile
 * This is useful for detecting the specific canvas rendering issue
 */
export const isMobileChrome = (): boolean => {
  const userAgent = navigator.userAgent;
  return /Chrome/i.test(userAgent) && isMobileDevice();
};

/**
 * Detects if the browser is Safari on iOS
 */
export const isIOSSafari = (): boolean => {
  const userAgent = navigator.userAgent;
  return /iPhone|iPad|iPod/i.test(userAgent) && /Safari/i.test(userAgent);
};

/**
 * Check if canvas effects should be enabled
 * Disabled by default on mobile for performance
 */
export const shouldEnableCanvasEffects = (): boolean => {
  // Check if user has explicitly enabled canvas effects on mobile
  const userPreference = localStorage.getItem('enableMobileCanvasEffects');
  if (userPreference === 'true' && isMobileDevice()) {
    return true;
  }
  
  // Disable on mobile by default
  if (isMobileDevice()) {
    return false;
  }
  
  // Enable on desktop/tablet
  return true;
};

/**
 * Get optimal video settings based on device
 */
export const getOptimalVideoSettings = () => {
  const deviceType = getDeviceType();
  
  switch (deviceType) {
    case 'mobile':
      return {
        resolution: '480p',
        frameRate: 24,
        bitrate: 800000,
      };
    case 'tablet':
      return {
        resolution: '720p',
        frameRate: 30,
        bitrate: 1500000,
      };
    default:
      return {
        resolution: '1080p',
        frameRate: 30,
        bitrate: 2500000,
      };
  }
};

/**
 * Check if the device has sufficient performance for effects
 */
export const hasHighPerformance = (): boolean => {
  // Check for hardware concurrency (number of CPU cores)
  const cores = navigator.hardwareConcurrency || 2;
  
  // Check device memory if available
  const memory = (navigator as any).deviceMemory || 4;
  
  // High performance if 4+ cores and 4+ GB RAM
  return cores >= 4 && memory >= 4 && !isMobileDevice();
};