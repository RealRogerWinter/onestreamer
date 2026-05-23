import { useEffect, useRef, useState } from 'react';
import { WebRTCClientAdapter } from '../services/WebRTCClientAdapter';

/**
 * Coarse-grained WebRTC connection state for the viewer.
 *
 * `disconnected` — no peer connection, or it just dropped.
 * `connected`    — receive-transport is up and consuming.
 * `reconnecting` — adapter detected loss and is attempting recovery.
 */
export type WebRTCConnectionState = 'connected' | 'disconnected' | 'reconnecting';

export interface UseWebRTCConnectionOptions {
  /**
   * Ref to the active MediasoupClient (set/cleared by the owning component's
   * initializeViewer / cleanup flow). The hook polls this ref to keep
   * `connectionState` and `reconnectionAttempts` in sync with the adapter.
   *
   * Passed as a ref (not a value) because the underlying client is recreated
   * frequently during stream switches; subscribers should always read the
   * latest instance.
   */
  clientRef: React.MutableRefObject<WebRTCClientAdapter | null>;

  /**
   * Current `isConnected` flag from the owning component. Used to suppress
   * polling-driven state churn while a successful connection is held — the
   * adapter's transient internal states would otherwise flap the UI.
   */
  isConnected: boolean;

  /**
   * Poll interval for the connection-state monitor. Defaults to 1000ms,
   * matching the pre-extraction behavior.
   */
  pollIntervalMs?: number;
}

export interface UseWebRTCConnectionResult {
  /** Coarse connection state, kept in sync with the adapter via polling. */
  connectionState: WebRTCConnectionState;
  /** Number of reconnection attempts the adapter has made on the current client. */
  reconnectionAttempts: number;
  /**
   * The raw RTCPeerConnection, exposed for PerformanceMonitor / diagnostics.
   * Currently always `null` — preserved as part of the public surface so the
   * later PR that wires adapter-side peer-connection plumbing can fill it in
   * without changing this hook's signature.
   */
  peerConnection: RTCPeerConnection | null;
  /**
   * WebRTC-level reconnection attempt counter (separate from the adapter's
   * own counter — this one is owned by the viewer's higher-level recovery
   * logic). Returned as a ref so callers can increment without re-rendering.
   */
  webrtcReconnectAttemptsRef: React.MutableRefObject<number>;

  /** Direct setters — used by the not-yet-extracted initializeViewer/cleanup flow. */
  setConnectionState: React.Dispatch<React.SetStateAction<WebRTCConnectionState>>;
  setReconnectionAttempts: React.Dispatch<React.SetStateAction<number>>;
  setPeerConnection: React.Dispatch<React.SetStateAction<RTCPeerConnection | null>>;
}

/**
 * Observes a MediasoupClient instance via the supplied ref and exposes
 * connection-state primitives suitable for status UI (reconnect banner,
 * performance monitor, etc).
 *
 * This is the MVP slice of the eventual full WebRTC-connection extraction:
 * the heavyweight bits (initializeViewer, retry orchestration, stream-switch
 * cleanup, fallback-mode wiring) remain in WebRTCViewer.tsx because they
 * are deeply coupled to stream-switching state that will be extracted in a
 * later PR (PR-O3). Keeping those in place avoids a refactor that touches
 * media negotiation in the same step as state lifting.
 *
 * The hook's contract is therefore intentionally narrow: it owns the
 * observable connection-status state and the polling effect that keeps it
 * fresh, and returns setters so the existing inline lifecycle can drive
 * transitions until the rest is extracted.
 */
export function useWebRTCConnection(
  opts: UseWebRTCConnectionOptions,
): UseWebRTCConnectionResult {
  const { clientRef, isConnected, pollIntervalMs = 1000 } = opts;

  const [connectionState, setConnectionState] =
    useState<WebRTCConnectionState>('disconnected');
  const [reconnectionAttempts, setReconnectionAttempts] = useState(0);
  const [peerConnection, setPeerConnection] = useState<RTCPeerConnection | null>(null);
  const webrtcReconnectAttemptsRef = useRef(0);

  // Monitor adapter connection state on a steady interval. The guard around
  // `isConnected` mirrors the pre-extraction behavior: once we hold a
  // successful connection, only allow transitions back to 'connected' from
  // the polling source — other transitions are driven by explicit callsites
  // (initializeViewer success, onConnectionLost, cleanup).
  useEffect(() => {
    if (!clientRef.current) return;

    const updateConnectionInfo = () => {
      const client = clientRef.current;
      if (!client) return;

      const clientState = client.connectionState as WebRTCConnectionState;
      if (!isConnected || clientState === 'connected') {
        setConnectionState(clientState);
      }
      setReconnectionAttempts(client.reconnectionInfo.attempts);
    };

    const interval = setInterval(updateConnectionInfo, pollIntervalMs);
    return () => clearInterval(interval);
  }, [clientRef, isConnected, pollIntervalMs]);

  return {
    connectionState,
    reconnectionAttempts,
    peerConnection,
    webrtcReconnectAttemptsRef,
    setConnectionState,
    setReconnectionAttempts,
    setPeerConnection,
  };
}
