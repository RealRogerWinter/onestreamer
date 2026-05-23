import { useState, useEffect } from 'react';

/**
 * Tracks viewport-based responsive layout flags.
 *
 * - `isMobile`: true when viewport width is <= 768px OR the user agent
 *   matches a known mobile string.
 * - `isLandscape`: true only when on mobile AND viewport width exceeds
 *   viewport height.
 *
 * Recomputes on `resize` and `orientationchange`. Listeners are cleaned
 * up on unmount. Behavior preserved verbatim from the original inline
 * effect in App.tsx so detection thresholds remain unchanged.
 */
export function useResponsiveLayout(): { isMobile: boolean; isLandscape: boolean } {
  const [isMobile, setIsMobile] = useState(false);
  const [isLandscape, setIsLandscape] = useState(false);

  // Reliable mobile detection and orientation
  useEffect(() => {
    const checkMobileAndOrientation = () => {
      const mobileCheck = window.innerWidth <= 768 ||
        /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
      setIsMobile(mobileCheck);

      // Check if in landscape mode
      const landscapeCheck = window.innerWidth > window.innerHeight && mobileCheck;
      setIsLandscape(landscapeCheck);
    };

    checkMobileAndOrientation();
    window.addEventListener('resize', checkMobileAndOrientation);
    window.addEventListener('orientationchange', checkMobileAndOrientation);
    return () => {
      window.removeEventListener('resize', checkMobileAndOrientation);
      window.removeEventListener('orientationchange', checkMobileAndOrientation);
    };
  }, []);

  return { isMobile, isLandscape };
}

export default useResponsiveLayout;
