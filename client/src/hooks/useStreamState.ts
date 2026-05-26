import { useCallback, useEffect, useRef, useState } from 'react';
import { Socket } from 'socket.io-client';

/**
 * Encapsulates the live-stream state that drives the OneStreamer UI
 * shell: who is streaming, the takeover/transition overlays, the
 * cooldown countdown, and the bulk of the socket listeners that flip
 * those values.
 *
 * Owns:
 *   - `isStreaming` (am I, the local user, the active broadcaster?)
 *   - `streamStatus` (everything we know about the currently active
 *     stream — streamer id, display name, random-rotation metadata,
 *     rotation timing/lock state, viewer count, game-mode flag).
 *   - `cooldownRemaining` plus the 1-second `setInterval` that decrements
 *     it; cleaned up on unmount.
 *   - Takeover plumbing: `wasStreamingBeforeTakeover`,
 *     `forceViewerAfterTakeover`, `showTakeoverOverlay`, `takeoverMessage`,
 *     `showTransitionOverlay`, `transitionMessage`,
 *     `disconnectionReason`, `isForceDisconnected`.
 *   - `streamerBuffs` (the active streamer's buff array — driven by
 *     `streamer-buffs-update`).
 *   - All the "pure stream" socket listeners: stream-started,
 *     stream-ended, viewer-count-update, new-streamer,
 *     random-rotation-status, rotation-timing / -extended / -reduced /
 *     -locked / -unlocked, global-cooldown, cooldown-status-update,
 *     streaming-approved, takeover-approved, takeover-denied,
 *     takeover-blocked, stream-takeover, force-disconnect,
 *     streamer-buffs-update, and the socket-reconnect re-emit.
 *
 * Does NOT own:
 *   - The `stream-status` listener itself — it touches game-mode state
 *     (`setIsGameActive`) and the post-stream-status auto-stop logic
 *     interacts with `socket.id`. The hook exposes `setStreamStatus`,
 *     `setIsStreaming`, `setWasStreamingBeforeTakeover`, and the
 *     takeover-lock helpers so App.tsx can implement that listener in
 *     place. (Splitting it out cleanly would require pulling
 *     useGameState into this hook, which is a bigger structural change
 *     than PR-M4 wants.)
 *   - The `game:started` / `game:ended` listeners — pure
 *     `useGameState` territory, App.tsx wires them.
 *   - `admin-notification`, `banned`, `timeout`, `kill-switch-activated`,
 *     and `stream-denied` — these only mutate App.tsx's `error` banner.
 *   - `time-stats-update` and `points-updated` — `useAuthState`
 *     territory; App.tsx wires them.
 *
 * Cross-cutting mutations from listeners that DO live in the hook are
 * surfaced via the `options` callbacks:
 *   - `onError(message)` — fired by `takeover-denied`, `takeover-blocked`,
 *     and the deny path of `force-disconnect`. App.tsx routes these into
 *     its `error` banner (with the same auto-clear semantics it had
 *     before).
 *   - `onClearError()` — fired by `streaming-approved` and
 *     `takeover-approved`, matching the original behaviour where a
 *     successful start clears any pending error.
 *
 * Behaviour is preserved verbatim from the original inline listeners in
 * App.tsx with one exception (PR 2.5b): the 10-second
 * `takeoverTargetRef` lock that papered over out-of-order
 * `stream-status` arrivals during a takeover is gone. The replacement
 * is the server-bumped `streamGeneration` counter on every
 * stream-status payload (see `useStreamGenerationGuard` and
 * `server/services/StreamService.js`). Same setTimeout durations, same
 * min-switch interval (3s), same display-name and rotation-timer
 * preservation rules, same console.log strings — everything else is
 * preserved.
 */

export interface StreamStatus {
  hasActiveStream: boolean;
  streamerId: string | null;
  streamType: string | null;
  viewerCount: number;
  streamStartTime: number | null;
  streamDuration: number;
  streamerDisplayName?: string | null;
  // Random rotation info
  isRandomRotation?: boolean;
  randomRotationPlatform?: string | null;
  randomRotationStreamerUrl?: string | null;
  randomRotationStreamerUsername?: string | null;
  randomRotationGame?: string | null;
  randomRotationViewers?: number | null;
  randomRotationStartedAt?: number | null;
  // Rotation timing (for countdown timer)
  nextRotationAt?: number | null;
  currentRotationDuration?: number | null;
  // Rotation lock state
  isRotationLocked?: boolean;
  lockedRemainingMs?: number | null;
  // Game mode
  isGameMode?: boolean;
  /**
   * Monotonic stream-identity counter set by `StreamService.streamGeneration`
   * on the server (bumped on every `setStreamer` / `clearStreamer`,
   * included in every `getStreamStatus()` payload). The client uses
   * this — via `useStreamGenerationGuard` — to discard out-of-order
   * `stream-status` arrivals. Optional because (a) older servers
   * predate the field, (b) the `stream-takeover` /
   * `stream-started` / `stream-ended` payloads on this hook don't
   * carry the counter and instead build a partial status.
   */
  streamGeneration?: number;
}

const INITIAL_STREAM_STATUS: StreamStatus = {
  hasActiveStream: false,
  streamerId: null,
  streamType: null,
  viewerCount: 0,
  streamStartTime: null,
  streamDuration: 0,
};

export interface UseStreamStateOptions {
  /** The main app socket. Listeners are bound when this becomes non-null. */
  socket: Socket | null;
  /** True when the main socket is currently connected. Drives the auto-disconnect overlay for an active streamer. */
  connected: boolean;
  /** Called for socket-pushed error/info banners (takeover-denied, takeover-blocked, force-disconnect). */
  onError?: (message: string) => void;
  /** Called when a stream start succeeds and the error banner should be cleared. */
  onClearError?: () => void;
}

export interface StreamStateResult {
  // Active-streamer flag.
  isStreaming: boolean;
  setIsStreaming: (value: boolean) => void;
  // Active-stream metadata (and full setter so App.tsx can keep the
  // `stream-status` listener in place).
  streamStatus: StreamStatus;
  setStreamStatus: React.Dispatch<React.SetStateAction<StreamStatus>>;
  // Cooldown countdown (driven by global-cooldown, cooldown-status-update,
  // takeover-denied, takeover-blocked, stream-takeover).
  cooldownRemaining: number;
  // Takeover plumbing.
  wasStreamingBeforeTakeover: boolean;
  setWasStreamingBeforeTakeover: (value: boolean) => void;
  forceViewerAfterTakeover: boolean;
  showTakeoverOverlay: boolean;
  takeoverMessage: string;
  showTransitionOverlay: boolean;
  transitionMessage: string;
  // Force-disconnect plumbing.
  disconnectionReason: string | null;
  isForceDisconnected: boolean;
  // Active streamer's buffs.
  streamerBuffs: any[];
}

export function useStreamState(options: UseStreamStateOptions): StreamStateResult {
  const { socket, connected, onError, onClearError } = options;

  const [isStreaming, setIsStreaming] = useState(false);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>(INITIAL_STREAM_STATUS);
  const [cooldownRemaining, setCooldownRemaining] = useState(0);
  const [wasStreamingBeforeTakeover, setWasStreamingBeforeTakeover] = useState(false);
  const [forceViewerAfterTakeover, setForceViewerAfterTakeover] = useState(false);
  const [disconnectionReason, setDisconnectionReason] = useState<string | null>(null);
  const [isForceDisconnected, setIsForceDisconnected] = useState(false);
  const [showTakeoverOverlay, setShowTakeoverOverlay] = useState(false);
  const [takeoverMessage, setTakeoverMessage] = useState<string>('');
  const [showTransitionOverlay, setShowTransitionOverlay] = useState(false);
  const [transitionMessage, setTransitionMessage] = useState<string>('');
  const [streamerBuffs, setStreamerBuffs] = useState<any[]>([]);

  // Refs preserved verbatim from App.tsx.
  const streamSwitchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastStreamSwitchRef = useRef<number>(0);
  const cooldownTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Keep refs to the latest values for listeners that close over them
  // (mirrors the original listener bodies which read these via React
  // state in a useEffect with full dep array — but we want a stable
  // listener registration that doesn't tear down on every state flip).
  const isStreamingRef = useRef(isStreaming);
  const wasStreamingBeforeTakeoverRef = useRef(wasStreamingBeforeTakeover);
  const isForceDisconnectedRef = useRef(isForceDisconnected);
  const streamerIdRef = useRef<string | null>(streamStatus.streamerId);
  useEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);
  useEffect(() => {
    wasStreamingBeforeTakeoverRef.current = wasStreamingBeforeTakeover;
  }, [wasStreamingBeforeTakeover]);
  useEffect(() => {
    isForceDisconnectedRef.current = isForceDisconnected;
  }, [isForceDisconnected]);
  useEffect(() => {
    streamerIdRef.current = streamStatus.streamerId;
  }, [streamStatus.streamerId]);

  const onErrorRef = useRef(onError);
  const onClearErrorRef = useRef(onClearError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);
  useEffect(() => {
    onClearErrorRef.current = onClearError;
  }, [onClearError]);

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

  // Clean up cooldown interval on unmount.
  useEffect(() => {
    return () => {
      if (cooldownTimerRef.current) {
        clearInterval(cooldownTimerRef.current);
        cooldownTimerRef.current = null;
      }
      if (streamSwitchTimeoutRef.current) {
        clearTimeout(streamSwitchTimeoutRef.current);
        streamSwitchTimeoutRef.current = null;
      }
    };
  }, []);

  // Handle socket disconnection for an active streamer. Mirrors the
  // original effect verbatim.
  useEffect(() => {
    if (!connected && isStreaming) {
      setIsStreaming(false);
      setIsForceDisconnected(true);

      setShowTakeoverOverlay(true);
      setTakeoverMessage('⚠️ Connection Lost!');

      setTimeout(() => {
        setShowTakeoverOverlay(false);
        setDisconnectionReason('Connection lost - Server unavailable');
      }, 3000);

      setTimeout(() => {
        setDisconnectionReason(null);
        setIsForceDisconnected(false);
      }, 15000);
    }

    if (connected && isForceDisconnected && socket) {
      console.log('🔌 CLIENT: Reconnected after force disconnect - requesting stream status');
      setIsForceDisconnected(false);
      setDisconnectionReason(null);
      socket.emit('join-as-viewer');
    }
  }, [connected, isStreaming, isForceDisconnected, socket]);

  // Wire all the pure-stream socket listeners. Bound once per socket
  // instance so registration doesn't churn on every state flip.
  useEffect(() => {
    if (!socket) return;

    socket.emit('join-as-viewer');

    const handleConnect = () => {
      console.log('🔌 CLIENT: Socket (re)connected - requesting stream status');
      socket.emit('join-as-viewer');
    };
    socket.on('connect', handleConnect);

    socket.on('stream-started', (data: any) => {
      // Clear any pending stream switch timeout
      if (streamSwitchTimeoutRef.current) {
        clearTimeout(streamSwitchTimeoutRef.current);
        streamSwitchTimeoutRef.current = null;
      }

      // PR 2.5b: the takeoverTargetRef "lock" used to clear here on
      // confirmation. That lock is gone — drop-by-streamGeneration on
      // the stream-status handler in App.tsx now handles the ordering
      // problem the lock used to paper over.

      setStreamStatus(prev => ({
        ...prev,
        hasActiveStream: true,
        streamerId: data.streamerId,
        streamType: data.streamType || 'unknown',
        streamStartTime: data.streamStartTime || Date.now(),
        streamDuration: 0,
        streamerDisplayName: data.streamerDisplayName || prev.streamerDisplayName,
      }));

      if (data.streamerId !== socket.id && isStreamingRef.current) {
        setIsStreaming(false);
        setWasStreamingBeforeTakeover(true);

        setShowTakeoverOverlay(true);
        setTakeoverMessage(`${data.streamerDisplayName || 'Another user'} has taken over your stream!`);

        setTimeout(() => {
          setShowTakeoverOverlay(false);
        }, 3000);
      } else {
        setWasStreamingBeforeTakeover(false);
      }
    });

    socket.on('stream-ended', (data?: { reason?: string; previousStreamer?: string; newStreamer?: string; newStreamerDisplayName?: string; isRandomRotation?: boolean; isUrlStream?: boolean }) => {
      // CRITICAL: Handle takeover differently - there IS an active stream (the new one)
      if (data?.reason === 'takeover' && data.newStreamer) {
        console.log(`🛑 CLIENT: Stream ended due to takeover by ${data.newStreamer} (${data.newStreamerDisplayName}) - updating to new streamer`);

        // PR 2.5b: the 10s `takeoverTargetRef` lock set here is gone.
        // Out-of-order `stream-status` arrivals are now discarded by
        // `streamGeneration` in `useStreamGenerationGuard` (used by the
        // App.tsx stream-status handler).

        setStreamStatus(prev => ({
          ...prev,
          hasActiveStream: true,
          streamerId: data.newStreamer!,
          streamerDisplayName: data.newStreamerDisplayName || prev.streamerDisplayName,
          streamStartTime: Date.now(),
          streamDuration: 0,
        }));
        setWasStreamingBeforeTakeover(false);
        return;
      }

      // CRITICAL: During random rotation transitions, preserve the display name
      const isTransitionEvent = data?.reason === 'random_rotation_starting' ||
                                data?.reason === 'random_rotation_stopped' ||
                                data?.reason?.startsWith('url_stream_') ||
                                data?.reason === 'webrtc_disconnect' ||
                                data?.isRandomRotation === true;

      if (isTransitionEvent) {
        console.log(`🔄 CLIENT: Stream transition event (${data?.reason}) - preserving display name and timer`);
        setStreamStatus(prev => ({
          ...prev,
          hasActiveStream: false,
          streamerId: null,
          streamType: null,
          streamStartTime: null,
          streamDuration: 0,
        }));
        return;
      }

      // Normal stream end - clear stream info but preserve timer values
      console.log(`🛑 CLIENT: Normal stream end (${data?.reason}) - preserving timer values`);
      setStreamStatus(prev => ({
        hasActiveStream: false,
        streamerId: null,
        streamType: null,
        viewerCount: 0,
        streamStartTime: null,
        streamDuration: 0,
        streamerDisplayName: null,
        nextRotationAt: prev.nextRotationAt,
        currentRotationDuration: prev.currentRotationDuration,
        isRotationLocked: prev.isRotationLocked,
        lockedRemainingMs: prev.lockedRemainingMs,
        isRandomRotation: prev.isRandomRotation,
        randomRotationPlatform: prev.randomRotationPlatform,
        randomRotationStreamerUrl: prev.randomRotationStreamerUrl,
        randomRotationStreamerUsername: prev.randomRotationStreamerUsername,
        randomRotationGame: prev.randomRotationGame,
        randomRotationViewers: prev.randomRotationViewers,
        randomRotationStartedAt: prev.randomRotationStartedAt,
      }));

      const minSwitchInterval = 3000;
      const now = Date.now();
      const timeSinceLastSwitch = now - lastStreamSwitchRef.current;

      if (wasStreamingBeforeTakeoverRef.current && timeSinceLastSwitch > minSwitchInterval) {
        lastStreamSwitchRef.current = now;

        if (streamSwitchTimeoutRef.current) {
          clearTimeout(streamSwitchTimeoutRef.current);
        }

        streamSwitchTimeoutRef.current = setTimeout(() => {
          setWasStreamingBeforeTakeover(false);
          setIsStreaming(true);
        }, 2000);
      }
    });

    socket.on('viewer-count-update', (count: number) => {
      setStreamStatus(prev => ({ ...prev, viewerCount: count }));
    });

    // CRITICAL: Listen for new-streamer events to update streamer display name
    socket.on('new-streamer', (data: {
      streamer?: {
        odyseeId?: string;
        odysee_username?: string;
        userId?: string;
        isUrlStream?: boolean;
        isRandomRotation?: boolean;
        platform?: string;
        game?: string;
        originalStreamer?: string;
      };
      streamerId?: string;
      isViewbot?: boolean;
    }) => {
      console.log('🆕 CLIENT: new-streamer event received:', data);

      const displayName = data.streamer?.odysee_username || null;
      const streamerId = data.streamer?.odyseeId || data.streamer?.userId || data.streamerId || null;
      const isRandomRotation = data.streamer?.isRandomRotation || false;
      const platform = data.streamer?.platform || null;

      if (streamerId) {
        setStreamStatus(prev => ({
          ...prev,
          hasActiveStream: true,
          streamerId: streamerId,
          streamerDisplayName: displayName || prev.streamerDisplayName,
          isRandomRotation: isRandomRotation || prev.isRandomRotation,
          randomRotationPlatform: isRandomRotation ? platform : prev.randomRotationPlatform,
          streamStartTime: Date.now(),
        }));
      }
    });

    // Random rotation status updates
    socket.on('random-rotation-status', (data: {
      enabled: boolean;
      currentStream?: {
        displayName: string;
        platform: string;
        streamerUsername: string;
        url: string;
        game?: string;
        viewers?: number;
        startedAt?: number;
      };
      rotationTiming?: {
        nextRotationAt: number;
        currentRotationDuration: number;
        serverTime: number;
      };
    }) => {
      console.log('🎲 CLIENT: Random rotation status update:', data);
      if (data.enabled && data.currentStream) {
        let nextRotationAt: number | null = null;
        let currentRotationDuration: number | null = null;
        if (data.rotationTiming) {
          const timeDiff = Date.now() - data.rotationTiming.serverTime;
          nextRotationAt = data.rotationTiming.nextRotationAt + timeDiff;
          currentRotationDuration = data.rotationTiming.currentRotationDuration;
        }
        setStreamStatus(prev => ({
          ...prev,
          isRandomRotation: true,
          randomRotationPlatform: data.currentStream!.platform,
          randomRotationStreamerUrl: data.currentStream!.url,
          randomRotationStreamerUsername: data.currentStream!.streamerUsername,
          randomRotationGame: data.currentStream!.game || null,
          randomRotationViewers: data.currentStream!.viewers ?? null,
          randomRotationStartedAt: data.currentStream!.startedAt || null,
          streamerDisplayName: data.currentStream!.displayName,
          nextRotationAt: nextRotationAt ?? prev.nextRotationAt,
          currentRotationDuration: currentRotationDuration ?? prev.currentRotationDuration,
        }));
      } else {
        setStreamStatus(prev => ({
          ...prev,
          isRandomRotation: false,
          randomRotationPlatform: null,
          randomRotationStreamerUrl: null,
          randomRotationStreamerUsername: null,
          randomRotationGame: null,
          randomRotationViewers: null,
          randomRotationStartedAt: null,
          nextRotationAt: null,
          currentRotationDuration: null,
        }));
      }
    });

    socket.on('rotation-timing', (data: {
      nextRotationAt: number;
      currentRotationDuration: number;
      serverTime: number;
    }) => {
      console.log('⏱️ CLIENT: Rotation timing update:', data);
      const timeDiff = Date.now() - data.serverTime;
      setStreamStatus(prev => ({
        ...prev,
        nextRotationAt: data.nextRotationAt + timeDiff,
        currentRotationDuration: data.currentRotationDuration,
      }));
    });

    socket.on('rotation-extended', (data: {
      extendedBy: number;
      extendedByMinutes: number;
      newNextRotationAt: number;
    }) => {
      console.log('⏰ CLIENT: Rotation extended by', data.extendedByMinutes, 'minutes');
      setStreamStatus(prev => ({
        ...prev,
        nextRotationAt: data.newNextRotationAt,
        isRotationLocked: false,
        lockedRemainingMs: null,
      }));
    });

    socket.on('rotation-reduced', (data: {
      reducedBy: number;
      reducedByMinutes: number;
      newNextRotationAt: number;
      currentRotationDuration: number;
      serverTime: number;
    }) => {
      console.log('⏰ CLIENT: Rotation reduced by', data.reducedByMinutes, 'minutes');
      const timeDiff = Date.now() - data.serverTime;
      setStreamStatus(prev => ({
        ...prev,
        nextRotationAt: data.newNextRotationAt + timeDiff,
        currentRotationDuration: data.currentRotationDuration,
        isRotationLocked: false,
        lockedRemainingMs: null,
      }));
    });

    socket.on('rotation-locked', (data: {
      locked: boolean;
      remainingMs: number;
    }) => {
      console.log('🔒 CLIENT: Rotation locked with', Math.round(data.remainingMs / 1000), 'seconds remaining');
      setStreamStatus(prev => ({
        ...prev,
        isRotationLocked: true,
        lockedRemainingMs: data.remainingMs,
      }));
    });

    socket.on('rotation-unlocked', (data: {
      locked: boolean;
      remainingMs: number;
      nextRotationAt: number;
    }) => {
      console.log('🔓 CLIENT: Rotation unlocked, resuming with', Math.round(data.remainingMs / 1000), 'seconds');
      setStreamStatus(prev => ({
        ...prev,
        isRotationLocked: false,
        lockedRemainingMs: null,
        nextRotationAt: data.nextRotationAt,
      }));
    });

    socket.on('global-cooldown', (data: { cooldownRemaining: number }) => {
      setCooldownRemaining(data.cooldownRemaining);
      startCooldownTimer(data.cooldownRemaining);
    });

    socket.on('cooldown-status-update', (data: { globalCooldown: any, timestamp: number }) => {
      if (data.globalCooldown) {
        const remaining = data.globalCooldown.remainingSeconds || data.globalCooldown.remaining || 0;
        setCooldownRemaining(Math.ceil(remaining));
        startCooldownTimer(Math.ceil(remaining));
      }
    });

    socket.on('streaming-approved', () => {
      setIsStreaming(true);
      onClearErrorRef.current?.();

      setShowTransitionOverlay(true);
      setTransitionMessage('Starting your stream...');

      setTimeout(() => {
        setShowTransitionOverlay(false);
      }, 2000);
    });

    socket.on('takeover-approved', () => {
      setIsStreaming(true);
      onClearErrorRef.current?.();

      setShowTransitionOverlay(true);
      setTransitionMessage('Taking over the stream...');

      setTimeout(() => {
        setShowTransitionOverlay(false);
      }, 2500);
    });

    socket.on('takeover-denied', (data: { reason: string, cooldownRemaining: number }) => {
      setCooldownRemaining(data.cooldownRemaining);
      startCooldownTimer(data.cooldownRemaining);
      onErrorRef.current?.(data.reason);
    });

    socket.on('takeover-blocked', (data: { message: string, cooldownRemaining: number }) => {
      setCooldownRemaining(data.cooldownRemaining);
      startCooldownTimer(data.cooldownRemaining);
      onErrorRef.current?.(data.message);
    });

    socket.on('streamer-buffs-update', (data: { buffs: any[] }) => {
      setStreamerBuffs(data.buffs || []);
    });

    // Handle force disconnect from killswitch or admin
    socket.on('force-disconnect', (data: { reason: string; activatedBy?: string; message: string }) => {
      console.log('💥 CLIENT: Force disconnect received:', data);

      // CRITICAL: If this is a stream_takeover, DON'T clear the stream status or show disconnect UI
      if (data.reason === 'stream_takeover') {
        console.log('💥 CLIENT: Force disconnect is from takeover - skipping (stream-takeover handler handles this)');
        setIsForceDisconnected(true);
        setTimeout(() => {
          setIsForceDisconnected(false);
        }, 5000);
        return;
      }

      if (isStreamingRef.current) {
        setIsStreaming(false);
        setIsForceDisconnected(true);
        setDisconnectionReason(data.message || data.reason);

        // Clear our stream from status if we were the streamer (but not during takeover)
        if (streamerIdRef.current === socket.id) {
          setStreamStatus(prev => ({
            ...prev,
            hasActiveStream: false,
            streamerId: null,
            streamType: null,
            streamerDisplayName: null,
          }));
        }

        setShowTakeoverOverlay(true);
        if (data.reason.includes('Kill Switch')) {
          setTakeoverMessage('💥 Kill Switch Activated!');
        } else {
          setTakeoverMessage(data.message || `Disconnected: ${data.reason}`);
        }

        setTimeout(() => {
          setShowTakeoverOverlay(false);
          setDisconnectionReason(data.message || data.reason);
        }, 3000);

        setTimeout(() => {
          setDisconnectionReason(null);
          setIsForceDisconnected(false);
        }, 15000);
      }
    });

    // Stream takeover event (sent to the current streamer being taken over)
    socket.on('stream-takeover', (data: { newStreamerId: string; newStreamerDisplayName?: string; cooldownRemaining: number }) => {
      console.log('🔄 CLIENT: Stream takeover event received:', data);
      if (isStreamingRef.current) {
        console.log('🔄 CLIENT: I was streaming, transitioning to viewer mode');

        // PR 2.5b: the takeover-target lock previously set here is
        // gone — drop-by-streamGeneration replaces it.

        setStreamStatus(prev => ({
          ...prev,
          hasActiveStream: true,
          streamerId: data.newStreamerId,
          streamerDisplayName: data.newStreamerDisplayName || prev.streamerDisplayName,
          streamStartTime: Date.now(),
          streamDuration: 0,
        }));

        setForceViewerAfterTakeover(true);

        setIsStreaming(false);
        setWasStreamingBeforeTakeover(false);

        setCooldownRemaining(data.cooldownRemaining);
        startCooldownTimer(data.cooldownRemaining);

        console.log('🔄 CLIENT: Transitioning to view new streamer:', data.newStreamerId);

        setShowTakeoverOverlay(true);
        setTakeoverMessage('Your stream is being taken over!');

        setTimeout(() => {
          setShowTakeoverOverlay(false);
          setTimeout(() => {
            setForceViewerAfterTakeover(false);
            console.log('🔄 CLIENT: Takeover transition complete, cleared force viewer mode');
          }, 2000);
        }, 3000);
      }
    });

    return () => {
      socket.off('connect', handleConnect);
      socket.off('stream-started');
      socket.off('stream-ended');
      socket.off('viewer-count-update');
      socket.off('new-streamer');
      socket.off('random-rotation-status');
      socket.off('rotation-timing');
      socket.off('rotation-extended');
      socket.off('rotation-reduced');
      socket.off('rotation-locked');
      socket.off('rotation-unlocked');
      socket.off('global-cooldown');
      socket.off('cooldown-status-update');
      socket.off('streaming-approved');
      socket.off('takeover-approved');
      socket.off('takeover-denied');
      socket.off('takeover-blocked');
      socket.off('streamer-buffs-update');
      socket.off('force-disconnect');
      socket.off('stream-takeover');
    };
  }, [socket, startCooldownTimer]);

  return {
    isStreaming,
    setIsStreaming,
    streamStatus,
    setStreamStatus,
    cooldownRemaining,
    wasStreamingBeforeTakeover,
    setWasStreamingBeforeTakeover,
    forceViewerAfterTakeover,
    showTakeoverOverlay,
    takeoverMessage,
    showTransitionOverlay,
    transitionMessage,
    disconnectionReason,
    isForceDisconnected,
    streamerBuffs,
  };
}

export default useStreamState;
