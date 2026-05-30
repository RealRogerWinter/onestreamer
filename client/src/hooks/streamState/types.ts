import { Socket } from 'socket.io-client';

/**
 * Shared types and constants for the {@link useStreamState} composer and
 * its sub-hooks under `hooks/streamState/`. Extracted verbatim from the
 * original monolithic `useStreamState.ts` (PR-M4 decomposition) — no
 * shape or value changes.
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

export const INITIAL_STREAM_STATUS: StreamStatus = {
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
