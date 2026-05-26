import { useCallback, useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';

/**
 * Drop-by-counter guard for stream-status events.
 *
 * Replaces the 10-second `takeoverTargetRef` lock that used to live in
 * `App.tsx`'s stream-status handler. That lock papered over the
 * cross-channel ordering problem the WebRTC red-team flagged: a
 * stream-status emit that fired before the takeover settled could
 * arrive *after* the new streamer's stream-started, and there was
 * nothing on the client to discard it — so the wall-clock 10-second
 * window approximated "ignore stream-status during a takeover
 * transition." Works most of the time, fails on slow networks where the
 * lag exceeds 10 s, blocks legitimate same-streamer-id updates that
 * happen to arrive inside the window.
 *
 * The structural fix is a monotonic `streamGeneration` counter the
 * server bumps on every `setStreamer` / `clearStreamer` (see
 * `server/services/StreamService.js`, included in every
 * `getStreamStatus()` payload). The client tracks the highest counter
 * it has accepted (`lastSeenGenerationRef`) and drops anything older.
 * Strictly less-than: equal counters are accepted (same generation, new
 * data — viewer count update, display name resolution).
 *
 * **Server-restart handling**: a fresh server starts at generation 0,
 * which is older than whatever the client's last value was — without
 * a reset, the client would lock itself out of every subsequent
 * stream-status. Hence: reset to -1 on socket `connect`, so the next
 * value (≥ 0) is always accepted.
 *
 * **Initial value**: -1, so the first emit (counter = 0) is accepted.
 *
 * **Back-compat**: a payload with no `streamGeneration` field at all
 * (e.g. an older server, or an emit site that hasn't been threaded
 * through `streamService` yet) is treated as "accept" — we can't
 * reason about ordering without the counter, so the safer default is
 * to apply the update.
 */
export function useStreamGenerationGuard(socket: Socket | null) {
  const lastSeenGenerationRef = useRef<number>(-1);

  useEffect(() => {
    if (!socket) return;
    const handleConnect = () => {
      lastSeenGenerationRef.current = -1;
    };
    socket.on('connect', handleConnect);
    return () => {
      socket.off('connect', handleConnect);
    };
  }, [socket]);

  const acceptStreamStatus = useCallback((incoming: number | undefined): boolean => {
    if (typeof incoming !== 'number') return true;
    if (incoming < lastSeenGenerationRef.current) return false;
    lastSeenGenerationRef.current = incoming;
    return true;
  }, []);

  return acceptStreamStatus;
}
