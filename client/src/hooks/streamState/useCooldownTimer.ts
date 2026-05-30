import { useCallback, useRef, useState } from 'react';

/**
 * Owns the global-cooldown countdown: the `cooldownRemaining` state, the
 * 1-second `setInterval` that decrements it, and the timer ref. Extracted
 * verbatim from `useStreamState` (PR-M4) — same `startCooldownTimer`
 * body, same `setInterval(…, 1000)` cadence, same teardown.
 *
 * The interval ref is returned so the composer's unmount cleanup can clear
 * it alongside the stream-switch timeout (preserving the original combined
 * cleanup effect).
 */
export interface CooldownTimer {
  cooldownRemaining: number;
  setCooldownRemaining: React.Dispatch<React.SetStateAction<number>>;
  startCooldownTimer: (seconds: number) => void;
  cooldownTimerRef: React.MutableRefObject<NodeJS.Timeout | null>;
}

export function useCooldownTimer(): CooldownTimer {
  const [cooldownRemaining, setCooldownRemaining] = useState(0);
  const cooldownTimerRef = useRef<NodeJS.Timeout | null>(null);

  const startCooldownTimer = useCallback((seconds: number) => {
    if (cooldownTimerRef.current) {
      clearInterval(cooldownTimerRef.current);
    }

    let remaining = seconds;
    setCooldownRemaining(remaining);

    cooldownTimerRef.current = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        setCooldownRemaining(0);
        if (cooldownTimerRef.current) {
          clearInterval(cooldownTimerRef.current);
          cooldownTimerRef.current = null;
        }
      } else {
        setCooldownRemaining(remaining);
      }
    }, 1000);
  }, []);

  return { cooldownRemaining, setCooldownRemaining, startCooldownTimer, cooldownTimerRef };
}
