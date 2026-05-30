import { useEffect, useRef, useState } from 'react';
import authService from '../../services/AuthService';
import { UserInfo } from './types';

export interface UseChatBonusResult {
  /** Whether the bonus icon is currently claimable. */
  bonusIconActive: boolean;
  /** Whether the bonus icon is in its post-claim cooldown. */
  bonusIconCooldown: boolean;
  /** Click handler for the bonus icon. No-op when inactive / cooling down. */
  handleBonusClick: () => Promise<void>;
}

/**
 * Owns the chat "bonus points" icon: server-driven availability checks, the
 * cooldown timer, and the claim flow.
 *
 * Extracted verbatim from Chat.tsx — behavior (timers, fetch endpoints,
 * window.showFloatingPoints animation, 429 handling) is unchanged. The hook
 * starts checking availability whenever an authenticated `userInfo` is present
 * and cleans its timer up on unmount.
 */
export function useChatBonus(userInfo: UserInfo | null): UseChatBonusResult {
  const [bonusIconActive, setBonusIconActive] = useState(false);
  const [bonusIconCooldown, setBonusIconCooldown] = useState(false);
  // Preserved from the original (kept for parity even though it is internal).
  const [, setNextBonusTime] = useState<number>(0);
  const bonusTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Check if bonus is available from server
  const checkBonusAvailability = async () => {
    const token = authService.getToken();
    const user = authService.getUser();

    if (!token || !user) return;

    try {
      const apiUrl = process.env.REACT_APP_API_URL || 'http://localhost:8080';
      const response = await fetch(`${apiUrl}/api/internal/bonus-status/${user.id}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        if (data.available) {
          // console.log('🎁 Bonus is available!');
          setBonusIconActive(true);
          setBonusIconCooldown(false);
        } else {
          // console.log(`⏰ Bonus on cooldown for ${data.remainingSeconds}s`);
          setBonusIconActive(false);
          setBonusIconCooldown(true);

          // Set timer to check again when cooldown expires
          if (bonusTimerRef.current) {
            clearTimeout(bonusTimerRef.current);
          }
          bonusTimerRef.current = setTimeout(() => {
            checkBonusAvailability();
          }, data.remainingSeconds * 1000);
        }
      }
    } catch (error) {
      console.error('Error checking bonus availability:', error);
    }
  };

  // Setup bonus timer based on server response
  const setupBonusTimer = (delay?: number) => {
    // Clear existing timer
    if (bonusTimerRef.current) {
      clearTimeout(bonusTimerRef.current);
    }

    // Use provided delay or random 2-6 minutes
    const randomDelay = delay || (Math.floor(Math.random() * 240000) + 120000);
    const nextTime = Date.now() + randomDelay;
    setNextBonusTime(nextTime);

    // console.log(`⏰ Bonus timer set for ${randomDelay}ms (${randomDelay/1000} seconds)`);

    bonusTimerRef.current = setTimeout(() => {
      // console.log('🎁 Checking bonus availability...');
      checkBonusAvailability();
    }, randomDelay);
  };

  // Handle bonus icon click
  const handleBonusClick = async () => {
    if (!bonusIconActive || bonusIconCooldown) {
      // console.log('❌ Bonus icon not active or in cooldown');
      return;
    }

    // Immediately disable the icon
    setBonusIconActive(false);
    setBonusIconCooldown(true);

    try {
      // Get auth token
      const token = authService.getToken();
      const user = authService.getUser();

      if (!token || !user) {
        console.error('No auth token or user available for bonus claim');
        setBonusIconActive(true);
        setBonusIconCooldown(false);
        return;
      }

      // Make API call to claim bonus
      const apiUrl = process.env.REACT_APP_API_URL || 'http://localhost:8080';
      const response = await fetch(`${apiUrl}/api/internal/claim-chat-bonus`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          userId: user.id
        })
      });

      if (response.ok) {
        const data = await response.json();

        // Show floating points animation
        if (window.showFloatingPoints) {
          window.showFloatingPoints(100, 'chat_bonus');
        }

        // Setup next timer with server-provided delay
        if (data.nextBonusDelay) {
          setupBonusTimer(data.nextBonusDelay);
        } else {
          setupBonusTimer();
        }
      } else if (response.status === 429) {
        // Too many requests - bonus still on cooldown
        const errorData = await response.json();

        // Keep icon disabled and set timer for remaining cooldown
        setBonusIconActive(false);
        setBonusIconCooldown(true);

        if (errorData.remainingSeconds) {
          if (bonusTimerRef.current) {
            clearTimeout(bonusTimerRef.current);
          }
          bonusTimerRef.current = setTimeout(() => {
            checkBonusAvailability();
          }, errorData.remainingSeconds * 1000);
        }
      } else {
        const errorData = await response.text();
        console.error('Failed to claim bonus:', response.status, errorData);
        // Re-enable on error
        setBonusIconActive(true);
        setBonusIconCooldown(false);
      }
    } catch (error) {
      console.error('Error claiming bonus:', error);
      // Re-enable on error
      setBonusIconActive(true);
      setBonusIconCooldown(false);
    }
  };

  // Start bonus checks when user is authenticated
  useEffect(() => {
    if (userInfo && authService.getToken()) {
      // Check current bonus status from server first
      checkBonusAvailability();
    }

    // Cleanup timer on unmount
    return () => {
      if (bonusTimerRef.current) {
        clearTimeout(bonusTimerRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userInfo]);

  return {
    bonusIconActive,
    bonusIconCooldown,
    handleBonusClick,
  };
}

export default useChatBonus;
