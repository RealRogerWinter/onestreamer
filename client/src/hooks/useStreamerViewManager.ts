import { useEffect, useRef, useState } from 'react';
import { Socket } from 'socket.io-client';
import { StreamerViewManager, StreamerViewState } from '../services/StreamerViewManager';

/**
 * Custom hook for managing streamer's view mode
 * Automatically switches between local preview and self-stream viewing based on active effects
 */
export const useStreamerViewManager = (
  videoRef: React.RefObject<HTMLVideoElement | null>,
  socket: Socket | null,
  isStreaming: boolean
) => {
  const managerRef = useRef<StreamerViewManager | null>(null);
  const [viewState, setViewState] = useState<StreamerViewState>({
    mode: 'local-preview',
    activeEffects: [],
    hasStreamProcessingEffects: false,
    lastSwitchTime: 0
  });

  useEffect(() => {
    // Only initialize if we have all required dependencies and are streaming
    if (!videoRef.current || !socket || !isStreaming) {
      // Clean up if conditions no longer met
      if (managerRef.current && !isStreaming) {
        // console.log('🎬 STREAMER VIEW HOOK: Cleaning up due to streaming stopped');
        managerRef.current.cleanup();
        managerRef.current = null;
      }
      return;
    }

    // Initialize StreamerViewManager only once
    if (!managerRef.current) {
      // console.log('🎬 STREAMER VIEW HOOK: Initializing StreamerViewManager', {
      //   hasSocket: !!socket,
      //   socketId: socket.id,
      //   hasVideoElement: !!videoRef.current,
      //   isStreaming
      // });
      managerRef.current = new StreamerViewManager(socket, videoRef.current);
    }
    
    // Update state periodically
    const updateInterval = setInterval(() => {
      if (managerRef.current) {
        setViewState(managerRef.current.getState());
      }
    }, 1000);

    return () => {
      clearInterval(updateInterval);
    };
  }, [videoRef, socket, isStreaming]);

  useEffect(() => {
    // Cleanup when component unmounts or streaming stops
    return () => {
      if (managerRef.current) {
        // console.log('🎬 STREAMER VIEW HOOK: Cleaning up StreamerViewManager');
        managerRef.current.cleanup();
        managerRef.current = null;
      }
    };
  }, []);

  // Cleanup when streaming stops
  useEffect(() => {
    if (!isStreaming && managerRef.current) {
      // console.log('🎬 STREAMER VIEW HOOK: Streaming stopped, forcing local preview');
      managerRef.current.forceLocalPreview();
    }
  }, [isStreaming]);

  return {
    viewState,
    manager: managerRef.current,
    forceLocalPreview: () => {
      if (managerRef.current) {
        managerRef.current.forceLocalPreview();
      }
    },
    forceSelfStream: () => {
      if (managerRef.current) {
        managerRef.current.forceSelfStream();
      }
    },
    getStats: () => {
      if (managerRef.current) {
        return managerRef.current.getStats();
      }
      return null;
    }
  };
};