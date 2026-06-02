import { useRef, useState } from 'react';
import {
  StreamSwitchManager,
  StreamSwitchState,
} from '../services/StreamSwitchManager';

export interface UseStreamSwitchOptions {
  /**
   * The current authoritative streamer id from above. Mirrored into
   * `previousStreamerIdRef` by the owning component's per-streamer-change
   * effect so race-handling can distinguish "first render" from "actual
   * transition" without re-running on every render.
   *
   * Passed for documentation / future use; the hook itself doesn't observe
   * it yet — the streamer-change orchestration effect remains inline in
   * WebRTCViewer because it is deeply entangled with initializeViewer, the
   * WebRTC client ref, videoRef, and several component-scoped flags.
   * Extracting that effect cleanly would require threading 10+ callbacks
   * through this hook's surface; deferred to a follow-up PR.
   */
  streamerId: string | null | undefined;
}

export interface UseStreamSwitchResult {
  /** Coarse switch-lifecycle state (idle / switching / retrying / fallback / failed). */
  switchState: StreamSwitchState;
  /** True while the StreamSwitchManager has dropped into a fallback strategy. */
  isFallbackMode: boolean;
  /**
   * True when a switch is in-flight (anything other than `idle`).
   * Convenience derived flag for callers that only care about pending-ness.
   */
  isPending: boolean;

  /**
   * Ref holding the StreamSwitchManager instance for the current
   * WebRTC client. Created/cleaned by the inline initializeViewer
   * flow in WebRTCViewer; owned here so its lifetime is parented to the
   * hook rather than scattered through the component.
   */
  streamSwitchManagerRef: React.MutableRefObject<StreamSwitchManager | null>;

  /**
   * Tracks the previous `streamerId` prop value. `undefined` sentinel marks
   * "before first render observed"; the inline per-streamer-change effect
   * mutates this directly to implement edge-detection for transitions.
   */
  previousStreamerIdRef: React.MutableRefObject<string | null | undefined>;

  /**
   * Sticky flag set whenever the current user IS or WAS the streamer. Used
   * by the inline race-handling to distinguish "user's-own-id transient
   * update" from "real takeover" during fast streamer churn.
   */
  userWasStreamerRef: React.MutableRefObject<boolean>;

  /** Direct setters — drive transitions from the inline lifecycle flow. */
  setSwitchState: React.Dispatch<React.SetStateAction<StreamSwitchState>>;
  setIsFallbackMode: React.Dispatch<React.SetStateAction<boolean>>;
}

/**
 * Owns the StreamSwitchManager-related state for the WebRTC viewer:
 * the public `switchState` machine, the `isFallbackMode` toggle, and the
 * long-lived refs (`streamSwitchManagerRef`, `previousStreamerIdRef`,
 * `userWasStreamerRef`) that the race-handling logic needs to keep around
 * across renders.
 *
 * This is the MVP slice of the eventual full stream-switch extraction.
 * The big per-streamer-change orchestration effect remains in
 * WebRTCViewer.tsx because it directly drives initializeViewer, the
 * video element, the WebRTC client lifecycle, abort controllers, and
 * several component-scoped UI state setters (isLoading / error /
 * isConnected). Pulling that effect in here would require threading
 * 10+ callbacks through the hook's surface and changing media negotiation
 * timing in the same PR as state lifting — a worse trade than the modest
 * scope of this extraction. The hook is laid out to receive that logic in
 * a follow-up without breaking its public shape.
 */
export function useStreamSwitch(
  _opts: UseStreamSwitchOptions,
): UseStreamSwitchResult {
  const [switchState, setSwitchState] = useState<StreamSwitchState>('idle');
  const [isFallbackMode, setIsFallbackMode] = useState(false);

  const streamSwitchManagerRef = useRef<StreamSwitchManager | null>(null);
  const previousStreamerIdRef = useRef<string | null | undefined>(undefined);
  const userWasStreamerRef = useRef<boolean>(false);

  const isPending = switchState !== 'idle';

  return {
    switchState,
    isFallbackMode,
    isPending,
    streamSwitchManagerRef,
    previousStreamerIdRef,
    userWasStreamerRef,
    setSwitchState,
    setIsFallbackMode,
  };
}
