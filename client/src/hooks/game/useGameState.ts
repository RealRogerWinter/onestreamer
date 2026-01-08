/**
 * useGameState - Hook for subscribing to game state
 */

import { useState, useEffect, useCallback } from 'react';
import { Socket } from 'socket.io-client';
import { GameStatus, GameStreamStatus } from '../../types/game';

interface UseGameStateReturn {
  isGameActive: boolean;
  gameStatus: GameStatus | null;
  error: string | null;
  startGame: () => Promise<{ success: boolean; error?: string }>;
  stopGame: () => Promise<{ success: boolean; error?: string }>;
  refreshStatus: () => void;
}

export const useGameState = (socket: Socket | null, isAdmin: boolean = false): UseGameStateReturn => {
  const [isGameActive, setIsGameActive] = useState(false);
  const [gameStatus, setGameStatus] = useState<GameStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Listen for game events
  useEffect(() => {
    if (!socket) return;

    const handleGameStarted = (data: { startedBy: number | null; timestamp: number }) => {
      console.log('[useGameState] Game started');
      setIsGameActive(true);
      setError(null);
    };

    const handleGameEnded = (data: { endedBy: number | null; timestamp: number }) => {
      console.log('[useGameState] Game ended');
      setIsGameActive(false);
      setGameStatus(null);
    };

    const handleStreamStatus = (status: { isGameMode?: boolean }) => {
      if (status.isGameMode !== undefined) {
        setIsGameActive(status.isGameMode);
      }
    };

    socket.on('game:started', handleGameStarted);
    socket.on('game:ended', handleGameEnded);
    socket.on('stream-status', handleStreamStatus);

    return () => {
      socket.off('game:started', handleGameStarted);
      socket.off('game:ended', handleGameEnded);
      socket.off('stream-status', handleStreamStatus);
    };
  }, [socket]);

  // Refresh game status
  const refreshStatus = useCallback(() => {
    if (!socket) return;

    socket.emit('admin:game-status', {}, (response: { success: boolean; status?: GameStreamStatus }) => {
      if (response.success && response.status) {
        setIsGameActive(response.status.isActive);
        setGameStatus(response.status.gameStatus);
      }
    });
  }, [socket]);

  // Initial status check
  useEffect(() => {
    if (socket && isAdmin) {
      refreshStatus();
    }
  }, [socket, isAdmin, refreshStatus]);

  // Start game (admin only)
  const startGame = useCallback(async (): Promise<{ success: boolean; error?: string }> => {
    if (!socket || !isAdmin) {
      return { success: false, error: 'Not authorized' };
    }

    return new Promise((resolve) => {
      socket.emit('admin:start-game', {}, (response: { success: boolean; error?: string }) => {
        if (response.success) {
          setIsGameActive(true);
          setError(null);
        } else {
          setError(response.error || 'Failed to start game');
        }
        resolve(response);
      });
    });
  }, [socket, isAdmin]);

  // Stop game (admin only)
  const stopGame = useCallback(async (): Promise<{ success: boolean; error?: string }> => {
    if (!socket || !isAdmin) {
      return { success: false, error: 'Not authorized' };
    }

    return new Promise((resolve) => {
      socket.emit('admin:stop-game', {}, (response: { success: boolean; error?: string }) => {
        if (response.success) {
          setIsGameActive(false);
          setGameStatus(null);
          setError(null);
        } else {
          setError(response.error || 'Failed to stop game');
        }
        resolve(response);
      });
    });
  }, [socket, isAdmin]);

  return {
    isGameActive,
    gameStatus,
    error,
    startGame,
    stopGame,
    refreshStatus
  };
};

export default useGameState;
