/**
 * GameControlPanel - Admin panel section for controlling game mode
 */

import React, { useState, useEffect, useCallback } from 'react';
import SocketManager from '../services/SocketManager';
import { GameStatus } from '../types/game';

interface GameControlPanelProps {
  addLog?: (message: string) => void;
}

const GameControlPanel: React.FC<GameControlPanelProps> = ({ addLog }) => {
  const [isGameActive, setIsGameActive] = useState(false);
  const [gameStatus, setGameStatus] = useState<GameStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch game status
  const fetchStatus = useCallback(() => {
    const socket = SocketManager.getMainSocket();
    if (!socket) {
      setError('Socket not connected');
      return;
    }

    socket.emit('admin:game-status', {}, (response: { success: boolean; status?: any; error?: string }) => {
      if (response.success && response.status) {
        setIsGameActive(response.status.isActive);
        setGameStatus(response.status.gameStatus);
        setError(null);
      } else {
        setError(response.error || 'Failed to fetch status');
      }
    });
  }, []);

  // Initial fetch and periodic refresh
  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  // Listen for game events
  useEffect(() => {
    const socket = SocketManager.getMainSocket();
    if (!socket) return;

    const handleGameStarted = () => {
      setIsGameActive(true);
      addLog?.('Game started');
      fetchStatus();
    };

    const handleGameEnded = () => {
      setIsGameActive(false);
      setGameStatus(null);
      addLog?.('Game ended');
    };

    socket.on('game:started', handleGameStarted);
    socket.on('game:ended', handleGameEnded);

    return () => {
      socket.off('game:started', handleGameStarted);
      socket.off('game:ended', handleGameEnded);
    };
  }, [addLog, fetchStatus]);

  // Start game
  const handleStartGame = async () => {
    const socket = SocketManager.getMainSocket();
    if (!socket) {
      setError('Socket not connected');
      return;
    }

    setIsLoading(true);
    setError(null);

    socket.emit('admin:start-game', {}, (response: { success: boolean; error?: string }) => {
      setIsLoading(false);
      if (response.success) {
        setIsGameActive(true);
        addLog?.('Game started successfully');
      } else {
        setError(response.error || 'Failed to start game');
        addLog?.(`Failed to start game: ${response.error}`);
      }
    });
  };

  // Stop game
  const handleStopGame = async () => {
    const socket = SocketManager.getMainSocket();
    if (!socket) {
      setError('Socket not connected');
      return;
    }

    setIsLoading(true);
    setError(null);

    socket.emit('admin:stop-game', {}, (response: { success: boolean; error?: string }) => {
      setIsLoading(false);
      if (response.success) {
        setIsGameActive(false);
        setGameStatus(null);
        addLog?.('Game stopped successfully');
      } else {
        setError(response.error || 'Failed to stop game');
        addLog?.(`Failed to stop game: ${response.error}`);
      }
    });
  };

  const formatUptime = (ms: number): string => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  };

  return (
    <div className="game-control-panel" style={{ padding: '20px' }}>
      <h2 style={{ marginBottom: '20px', color: '#4ecdc4' }}>
        Game Control
      </h2>

      {/* Status Card */}
      <div
        style={{
          backgroundColor: 'rgba(255, 255, 255, 0.05)',
          borderRadius: '12px',
          padding: '20px',
          marginBottom: '20px'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '15px' }}>
          <div
            style={{
              width: '12px',
              height: '12px',
              borderRadius: '50%',
              backgroundColor: isGameActive ? '#4ecdc4' : '#666',
              marginRight: '10px',
              boxShadow: isGameActive ? '0 0 10px #4ecdc4' : 'none'
            }}
          />
          <span style={{ fontSize: '18px', fontWeight: 'bold' }}>
            {isGameActive ? 'Game Active' : 'Game Inactive'}
          </span>
        </div>

        {gameStatus && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '15px' }}>
            <div style={{ backgroundColor: 'rgba(0, 0, 0, 0.2)', padding: '15px', borderRadius: '8px' }}>
              <div style={{ fontSize: '12px', color: '#888', marginBottom: '5px' }}>Players</div>
              <div style={{ fontSize: '24px', fontWeight: 'bold' }}>{gameStatus.playerCount}</div>
              <div style={{ fontSize: '12px', color: '#666' }}>Peak: {gameStatus.peakPlayers}</div>
            </div>

            <div style={{ backgroundColor: 'rgba(0, 0, 0, 0.2)', padding: '15px', borderRadius: '8px' }}>
              <div style={{ fontSize: '12px', color: '#888', marginBottom: '5px' }}>Uptime</div>
              <div style={{ fontSize: '24px', fontWeight: 'bold' }}>{formatUptime(gameStatus.uptime)}</div>
            </div>

            <div style={{ backgroundColor: 'rgba(0, 0, 0, 0.2)', padding: '15px', borderRadius: '8px' }}>
              <div style={{ fontSize: '12px', color: '#888', marginBottom: '5px' }}>Items in World</div>
              <div style={{ fontSize: '24px', fontWeight: 'bold' }}>{gameStatus.itemCount}</div>
            </div>

            <div style={{ backgroundColor: 'rgba(0, 0, 0, 0.2)', padding: '15px', borderRadius: '8px' }}>
              <div style={{ fontSize: '12px', color: '#888', marginBottom: '5px' }}>Total Players</div>
              <div style={{ fontSize: '24px', fontWeight: 'bold' }}>{gameStatus.totalPlayers}</div>
            </div>
          </div>
        )}
      </div>

      {/* Control Buttons */}
      <div style={{ display: 'flex', gap: '15px', marginBottom: '20px' }}>
        {!isGameActive ? (
          <button
            onClick={handleStartGame}
            disabled={isLoading}
            style={{
              flex: 1,
              padding: '15px 30px',
              fontSize: '16px',
              fontWeight: 'bold',
              backgroundColor: '#4ecdc4',
              color: '#1a1a2e',
              border: 'none',
              borderRadius: '8px',
              cursor: isLoading ? 'not-allowed' : 'pointer',
              opacity: isLoading ? 0.7 : 1,
              transition: 'all 0.2s'
            }}
          >
            {isLoading ? 'Starting...' : 'Start Game'}
          </button>
        ) : (
          <button
            onClick={handleStopGame}
            disabled={isLoading}
            style={{
              flex: 1,
              padding: '15px 30px',
              fontSize: '16px',
              fontWeight: 'bold',
              backgroundColor: '#ff6b6b',
              color: '#ffffff',
              border: 'none',
              borderRadius: '8px',
              cursor: isLoading ? 'not-allowed' : 'pointer',
              opacity: isLoading ? 0.7 : 1,
              transition: 'all 0.2s'
            }}
          >
            {isLoading ? 'Stopping...' : 'Stop Game'}
          </button>
        )}

        <button
          onClick={fetchStatus}
          disabled={isLoading}
          style={{
            padding: '15px 20px',
            fontSize: '16px',
            backgroundColor: 'rgba(255, 255, 255, 0.1)',
            color: '#ffffff',
            border: '1px solid rgba(255, 255, 255, 0.2)',
            borderRadius: '8px',
            cursor: isLoading ? 'not-allowed' : 'pointer'
          }}
        >
          Refresh
        </button>
      </div>

      {/* Error Display */}
      {error && (
        <div
          style={{
            backgroundColor: 'rgba(255, 107, 107, 0.2)',
            border: '1px solid #ff6b6b',
            borderRadius: '8px',
            padding: '15px',
            color: '#ff6b6b',
            marginBottom: '20px'
          }}
        >
          {error}
        </div>
      )}

      {/* Info Section */}
      <div
        style={{
          backgroundColor: 'rgba(78, 205, 196, 0.1)',
          borderRadius: '8px',
          padding: '15px',
          fontSize: '14px',
          color: '#888'
        }}
      >
        <div style={{ fontWeight: 'bold', color: '#4ecdc4', marginBottom: '10px' }}>
          About Game Mode
        </div>
        <ul style={{ margin: 0, paddingLeft: '20px', lineHeight: '1.8' }}>
          <li>Starting the game will interrupt any active stream</li>
          <li>While game is active, no one can take over the stream</li>
          <li>All logged-in users can join and play</li>
          <li>Use WASD or arrow keys to move</li>
          <li>Game state is saved when stopped</li>
        </ul>
      </div>
    </div>
  );
};

export default GameControlPanel;
