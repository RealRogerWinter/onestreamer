import { useEffect } from 'react';
import { Socket } from 'socket.io-client';
import { StreamStatus } from './types';

/**
 * Registers (and tears down) all the "pure stream" socket listeners that
 * drive `useStreamState`: stream-started/-ended, viewer-count-update,
 * new-streamer, the random-rotation family, cooldown events, the
 * streaming/takeover approval/denial events, streamer-buffs-update,
 * force-disconnect and stream-takeover, plus the socket-reconnect re-emit.
 *
 * Extracted verbatim from the monolithic `useStreamState` (PR-M4). The
 * effect body, every listener, every setTimeout duration, the 3s
 * min-switch interval, and the `[socket, startCooldownTimer]` dependency
 * array are all preserved exactly. All mutable state lives in the
 * composer and is threaded in via `deps` (setters + latest-value refs).
 */
export interface StreamSocketListenerDeps {
  socket: Socket | null;
  startCooldownTimer: (seconds: number) => void;

  // setters owned by the composer / sub-hooks
  setStreamStatus: React.Dispatch<React.SetStateAction<StreamStatus>>;
  setIsStreaming: (value: boolean) => void;
  setCooldownRemaining: React.Dispatch<React.SetStateAction<number>>;
  setWasStreamingBeforeTakeover: React.Dispatch<React.SetStateAction<boolean>>;
  setForceViewerAfterTakeover: React.Dispatch<React.SetStateAction<boolean>>;
  setDisconnectionReason: React.Dispatch<React.SetStateAction<string | null>>;
  setIsForceDisconnected: React.Dispatch<React.SetStateAction<boolean>>;
  setShowTakeoverOverlay: React.Dispatch<React.SetStateAction<boolean>>;
  setTakeoverMessage: React.Dispatch<React.SetStateAction<string>>;
  setShowTransitionOverlay: React.Dispatch<React.SetStateAction<boolean>>;
  setTransitionMessage: React.Dispatch<React.SetStateAction<string>>;
  setStreamerBuffs: React.Dispatch<React.SetStateAction<any[]>>;

  // refs holding latest values / timers (read inside stable listeners)
  streamSwitchTimeoutRef: React.MutableRefObject<NodeJS.Timeout | null>;
  lastStreamSwitchRef: React.MutableRefObject<number>;
  isStreamingRef: React.MutableRefObject<boolean>;
  wasStreamingBeforeTakeoverRef: React.MutableRefObject<boolean>;
  streamerIdRef: React.MutableRefObject<string | null>;
  onErrorRef: React.MutableRefObject<((message: string) => void) | undefined>;
  onClearErrorRef: React.MutableRefObject<(() => void) | undefined>;
}

export function useStreamSocketListeners(deps: StreamSocketListenerDeps): void {
  const {
    socket,
    startCooldownTimer,
    setStreamStatus,
    setIsStreaming,
    setCooldownRemaining,
    setWasStreamingBeforeTakeover,
    setForceViewerAfterTakeover,
    setDisconnectionReason,
    setIsForceDisconnected,
    setShowTakeoverOverlay,
    setTakeoverMessage,
    setShowTransitionOverlay,
    setTransitionMessage,
    setStreamerBuffs,
    streamSwitchTimeoutRef,
    lastStreamSwitchRef,
    isStreamingRef,
    wasStreamingBeforeTakeoverRef,
    streamerIdRef,
    onErrorRef,
    onClearErrorRef,
  } = deps;

  // Wire all the pure-stream socket listeners. Bound once per socket
  // instance so registration doesn't churn on every state flip.
  useEffect(() => {
    if (!socket) return;

    socket.emit('join-as-viewer');

    // Track every (event, handler) pair we register so cleanup can pass the
    // SAME references to socket.off. A bare socket.off('stream-started')
    // removes every other component's listeners for that event on the shared
    // App-level socket — e.g. WebRTCViewer's stream-ended handler — killing
    // takeover/stream-end handling app-wide (audit Plan 05, C4).
    const registered: Array<[string, (...args: any[]) => void]> = [];
    const on = (event: string, handler: (...args: any[]) => void): void => {
      registered.push([event, handler]);
      socket.on(event, handler);
    };

    const handleConnect = () => {
      console.log('🔌 CLIENT: Socket (re)connected - requesting stream status');
      socket.emit('join-as-viewer');
    };
    on('connect', handleConnect);

    on('stream-started', (data: any) => {
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

    on('stream-ended', (data?: { reason?: string; previousStreamer?: string; newStreamer?: string; newStreamerDisplayName?: string; isRandomRotation?: boolean; isUrlStream?: boolean }) => {
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

    on('viewer-count-update', (count: number) => {
      setStreamStatus(prev => ({ ...prev, viewerCount: count }));
    });

    // CRITICAL: Listen for new-streamer events to update streamer display name
    on('new-streamer', (data: {
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
    on('random-rotation-status', (data: {
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

    on('rotation-timing', (data: {
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

    on('rotation-extended', (data: {
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

    on('rotation-reduced', (data: {
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

    on('rotation-locked', (data: {
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

    on('rotation-unlocked', (data: {
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

    on('global-cooldown', (data: { cooldownRemaining: number }) => {
      setCooldownRemaining(data.cooldownRemaining);
      startCooldownTimer(data.cooldownRemaining);
    });

    on('cooldown-status-update', (data: { globalCooldown: any, timestamp: number }) => {
      if (data.globalCooldown) {
        const remaining = data.globalCooldown.remainingSeconds || data.globalCooldown.remaining || 0;
        setCooldownRemaining(Math.ceil(remaining));
        startCooldownTimer(Math.ceil(remaining));
      }
    });

    on('streaming-approved', () => {
      setIsStreaming(true);
      onClearErrorRef.current?.();

      setShowTransitionOverlay(true);
      setTransitionMessage('Starting your stream...');

      setTimeout(() => {
        setShowTransitionOverlay(false);
      }, 2000);
    });

    on('takeover-approved', () => {
      setIsStreaming(true);
      onClearErrorRef.current?.();

      setShowTransitionOverlay(true);
      setTransitionMessage('Taking over the stream...');

      setTimeout(() => {
        setShowTransitionOverlay(false);
      }, 2500);
    });

    on('takeover-denied', (data: { reason: string, cooldownRemaining: number }) => {
      setCooldownRemaining(data.cooldownRemaining);
      startCooldownTimer(data.cooldownRemaining);
      onErrorRef.current?.(data.reason);
    });

    on('takeover-blocked', (data: { message: string, cooldownRemaining: number }) => {
      setCooldownRemaining(data.cooldownRemaining);
      startCooldownTimer(data.cooldownRemaining);
      onErrorRef.current?.(data.message);
    });

    on('streamer-buffs-update', (data: { buffs: any[] }) => {
      setStreamerBuffs(data.buffs || []);
    });

    // Handle force disconnect from killswitch or admin
    on('force-disconnect', (data: { reason: string; activatedBy?: string; message: string }) => {
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
    on('stream-takeover', (data: { newStreamerId: string; newStreamerDisplayName?: string; cooldownRemaining: number }) => {
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
      // Remove exactly the handlers this hook registered (see `on` above) —
      // never the bare-event form, which strips other components' listeners.
      registered.forEach(([event, handler]) => socket.off(event, handler));
    };
  }, [socket, startCooldownTimer]); // eslint-disable-line react-hooks/exhaustive-deps
}
