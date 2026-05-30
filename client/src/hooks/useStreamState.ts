import { useEffect, useRef, useState } from 'react';
import {
  StreamStatus,
  INITIAL_STREAM_STATUS,
  UseStreamStateOptions,
  StreamStateResult,
} from './streamState/types';
import { useCooldownTimer } from './streamState/useCooldownTimer';
import { useTakeoverState } from './streamState/useTakeoverState';
import { useStreamSocketListeners } from './streamState/useStreamSocketListeners';

/**
 * Encapsulates the live-stream state that drives the OneStreamer UI
 * shell: who is streaming, the takeover/transition overlays, the
 * cooldown countdown, and the bulk of the socket listeners that flip
 * those values.
 *
 * PR-M4 decomposed the original ~750-line monolith into a thin composer
 * over three sub-hooks under `hooks/streamState/`:
 *
 *   - {@link useCooldownTimer} — owns `cooldownRemaining`, the 1-second
 *     `setInterval`, and `startCooldownTimer`.
 *   - {@link useTakeoverState} — owns the takeover / transition /
 *     force-disconnect overlay state and the "active streamer lost the
 *     socket" effect.
 *   - {@link useStreamSocketListeners} — registers (and tears down) every
 *     pure-stream socket listener (stream-started/-ended,
 *     viewer-count-update, new-streamer, the rotation family, cooldown
 *     events, streaming/takeover approval/denial, streamer-buffs-update,
 *     force-disconnect, stream-takeover, and the reconnect re-emit).
 *
 * Behaviour, effect ordering, dependency arrays, setTimeout durations,
 * the 3s min-switch interval, console.log strings, and the returned API
 * are all preserved verbatim from the pre-decomposition hook.
 *
 * Owns (in the composer / sub-hooks):
 *   - `isStreaming`, `streamStatus`, `streamerBuffs`.
 *   - `cooldownRemaining` plus the 1-second `setInterval` that decrements
 *     it (via `useCooldownTimer`); cleaned up on unmount.
 *   - Takeover plumbing (via `useTakeoverState`).
 *
 * Does NOT own:
 *   - The `stream-status` listener itself — App.tsx implements it in
 *     place using the exposed `setStreamStatus`, `setIsStreaming`,
 *     `setWasStreamingBeforeTakeover` setters.
 *   - `game:started` / `game:ended`, `admin-notification`, `banned`,
 *     `timeout`, `kill-switch-activated`, `stream-denied`,
 *     `time-stats-update`, `points-updated` — App.tsx / other hooks.
 *
 * Cross-cutting mutations surfaced via `options` callbacks:
 *   - `onError(message)` — takeover-denied, takeover-blocked, deny path
 *     of force-disconnect.
 *   - `onClearError()` — streaming-approved, takeover-approved.
 */

export type { StreamStatus, UseStreamStateOptions, StreamStateResult };
export { INITIAL_STREAM_STATUS };

export function useStreamState(options: UseStreamStateOptions): StreamStateResult {
  const { socket, connected, onError, onClearError } = options;

  const [isStreaming, setIsStreaming] = useState(false);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>(INITIAL_STREAM_STATUS);
  const [streamerBuffs, setStreamerBuffs] = useState<any[]>([]);

  // Cooldown countdown + 1-second decrement interval.
  const { cooldownRemaining, setCooldownRemaining, startCooldownTimer, cooldownTimerRef } =
    useCooldownTimer();

  // Takeover / transition / force-disconnect overlay state, plus the
  // active-streamer connection-lost effect.
  const takeover = useTakeoverState({ socket, connected, isStreaming, setIsStreaming });
  const {
    wasStreamingBeforeTakeover,
    setWasStreamingBeforeTakeover,
    forceViewerAfterTakeover,
    setForceViewerAfterTakeover,
    disconnectionReason,
    setDisconnectionReason,
    isForceDisconnected,
    setIsForceDisconnected,
    showTakeoverOverlay,
    setShowTakeoverOverlay,
    takeoverMessage,
    setTakeoverMessage,
    showTransitionOverlay,
    setShowTransitionOverlay,
    transitionMessage,
    setTransitionMessage,
  } = takeover;

  // Refs preserved verbatim from App.tsx.
  const streamSwitchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastStreamSwitchRef = useRef<number>(0);

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

  // Clean up cooldown interval + stream-switch timeout on unmount.
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
  }, [cooldownTimerRef]);

  // Wire all the pure-stream socket listeners.
  useStreamSocketListeners({
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
  });

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
