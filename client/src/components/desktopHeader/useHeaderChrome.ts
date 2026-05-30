import { useState, useEffect } from 'react';

/**
 * Cohesive cluster of header "chrome" state that is independent of the props:
 * the live clock, the scrolled flag (drives the `scrolled` class), and the
 * periodic inventory hint shown to non-authenticated theatre-mode users.
 *
 * Behavior is preserved verbatim from the original DesktopHeaderV2.
 */
export function useHeaderChrome(isAuthenticated: boolean, isTheatreMode: boolean) {
  const [currentTime, setCurrentTime] = useState(new Date());
  const [isScrolled, setIsScrolled] = useState(false);
  const [showInventoryHint, setShowInventoryHint] = useState(false);

  // Update clock every second
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Handle scroll effect
  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 10);
    };

    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Periodic inventory hint for non-authenticated users
  useEffect(() => {
    if (isAuthenticated || !isTheatreMode) return;

    // Show hint after initial delay, then periodically
    const initialDelay = setTimeout(() => {
      setShowInventoryHint(true);
      // Hide after 15 seconds
      setTimeout(() => setShowInventoryHint(false), 15000);
    }, 15000); // First appearance after 15 seconds

    const interval = setInterval(() => {
      setShowInventoryHint(true);
      // Hide after 15 seconds
      setTimeout(() => setShowInventoryHint(false), 15000);
    }, 90000); // Show every 90 seconds

    return () => {
      clearTimeout(initialDelay);
      clearInterval(interval);
    };
  }, [isAuthenticated, isTheatreMode]);

  return { currentTime, isScrolled, showInventoryHint, setShowInventoryHint };
}
