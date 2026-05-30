import { useEffect, useState } from 'react';
import { Socket } from 'socket.io-client';

/**
 * Owns the takeover / transition / force-disconnect overlay state plus the
 * "active streamer lost the socket" effect. Extracted verbatim from
 * `useStreamState` (PR-M4): same initial values, same effect body, same
 * `[connected, isStreaming, isForceDisconnected, socket]` dependency array,
 * and the same setTimeout durations (3s overlay hide, 15s reason clear).
 *
 * `isStreaming` / `setIsStreaming` are threaded in because the
 * connection-lost effect both reads and clears the active-streamer flag,
 * which is owned by the composer.
 */
export interface UseTakeoverStateParams {
  socket: Socket | null;
  connected: boolean;
  isStreaming: boolean;
  setIsStreaming: (value: boolean) => void;
}

export interface TakeoverState {
  wasStreamingBeforeTakeover: boolean;
  setWasStreamingBeforeTakeover: React.Dispatch<React.SetStateAction<boolean>>;
  forceViewerAfterTakeover: boolean;
  setForceViewerAfterTakeover: React.Dispatch<React.SetStateAction<boolean>>;
  disconnectionReason: string | null;
  setDisconnectionReason: React.Dispatch<React.SetStateAction<string | null>>;
  isForceDisconnected: boolean;
  setIsForceDisconnected: React.Dispatch<React.SetStateAction<boolean>>;
  showTakeoverOverlay: boolean;
  setShowTakeoverOverlay: React.Dispatch<React.SetStateAction<boolean>>;
  takeoverMessage: string;
  setTakeoverMessage: React.Dispatch<React.SetStateAction<string>>;
  showTransitionOverlay: boolean;
  setShowTransitionOverlay: React.Dispatch<React.SetStateAction<boolean>>;
  transitionMessage: string;
  setTransitionMessage: React.Dispatch<React.SetStateAction<string>>;
}

export function useTakeoverState(params: UseTakeoverStateParams): TakeoverState {
  const { socket, connected, isStreaming, setIsStreaming } = params;

  const [wasStreamingBeforeTakeover, setWasStreamingBeforeTakeover] = useState(false);
  const [forceViewerAfterTakeover, setForceViewerAfterTakeover] = useState(false);
  const [disconnectionReason, setDisconnectionReason] = useState<string | null>(null);
  const [isForceDisconnected, setIsForceDisconnected] = useState(false);
  const [showTakeoverOverlay, setShowTakeoverOverlay] = useState(false);
  const [takeoverMessage, setTakeoverMessage] = useState<string>('');
  const [showTransitionOverlay, setShowTransitionOverlay] = useState(false);
  const [transitionMessage, setTransitionMessage] = useState<string>('');

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
  }, [connected, isStreaming, isForceDisconnected, socket]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
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
  };
}
