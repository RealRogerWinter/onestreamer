/**
 * GameOverlay - Main game container component
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Socket } from 'socket.io-client';
import { GameClient } from '../../services/game/GameClient';
import { GameCanvas } from './GameCanvas';
import { GameControls } from './GameControls';
import { GameHUD } from './GameHUD';
import { PlayerState, WorldState, WorldItem, GameStatus } from '../../types/game';

interface GameOverlayProps {
  isActive: boolean;
  userId: string | number;
  socket: Socket | null;
  containerRef?: React.RefObject<HTMLDivElement>;
}

export const GameOverlay: React.FC<GameOverlayProps> = ({
  isActive,
  userId,
  socket,
  containerRef
}) => {
  const gameClientRef = useRef<GameClient | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [localPlayer, setLocalPlayer] = useState<PlayerState | null>(null);
  const [players, setPlayers] = useState<Record<string, PlayerState>>({});
  const [worldState, setWorldState] = useState<WorldState | null>(null);
  const [items, setItems] = useState<WorldItem[]>([]);
  const [playerCount, setPlayerCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Initialize game client
  useEffect(() => {
    if (!isActive || !socket || !userId) {
      // Clean up if not active
      if (gameClientRef.current) {
        gameClientRef.current.leaveGame();
        gameClientRef.current.destroy();
        gameClientRef.current = null;
        setIsConnected(false);
      }
      return;
    }

    console.log('[GameOverlay] Initializing game client');

    // Create game client
    const gameClient = new GameClient(socket, userId);
    gameClientRef.current = gameClient;

    // Subscribe to state updates
    gameClient.on('state-update', (state: {
      localPlayer: PlayerState | null;
      players: Record<string, PlayerState>;
      world: WorldState | null;
      items: WorldItem[];
      playerCount: number;
    }) => {
      setLocalPlayer(state.localPlayer);
      setPlayers(state.players);
      setWorldState(state.world);
      setItems(state.items);
      setPlayerCount(state.playerCount);
    });

    gameClient.on('player-update', (player: PlayerState | null) => {
      setLocalPlayer(player);
    });

    gameClient.on('joined', () => {
      setIsConnected(true);
      setError(null);
    });

    gameClient.on('error', (err: { message: string; code: string }) => {
      console.error('[GameOverlay] Game error:', err);
      setError(err.message);
    });

    // Join the game
    gameClient.joinGame();

    return () => {
      console.log('[GameOverlay] Cleaning up game client');
      gameClient.leaveGame();
      gameClient.destroy();
      gameClientRef.current = null;
      setIsConnected(false);
    };
  }, [isActive, socket, userId]);

  // Handle window resize
  useEffect(() => {
    const handleResize = () => {
      if (gameClientRef.current && containerRef?.current) {
        const { width, height } = containerRef.current.getBoundingClientRect();
        gameClientRef.current.resizeRenderer(width, height);
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [containerRef]);

  if (!isActive) {
    return null;
  }

  return (
    <div
      className="game-overlay"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        zIndex: 100,
        pointerEvents: 'auto',
        backgroundColor: 'rgba(0, 0, 0, 0.8)'
      }}
    >
      {/* Loading state */}
      {!isConnected && !error && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            color: '#ffffff',
            fontSize: '24px',
            textAlign: 'center'
          }}
        >
          <div>Joining game...</div>
          <div style={{ fontSize: '14px', marginTop: '10px', opacity: 0.7 }}>
            Use WASD or arrow keys to move
          </div>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            color: '#ff6b6b',
            fontSize: '18px',
            textAlign: 'center',
            padding: '20px',
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            borderRadius: '8px'
          }}
        >
          <div style={{ marginBottom: '10px' }}>Game Error</div>
          <div style={{ fontSize: '14px' }}>{error}</div>
        </div>
      )}

      {/* Game canvas */}
      {isConnected && (
        <>
          <GameCanvas
            gameClient={gameClientRef.current}
            localPlayer={localPlayer}
            players={players}
            worldState={worldState}
            items={items}
            containerRef={containerRef}
          />
          <GameHUD
            localPlayer={localPlayer}
            playerCount={playerCount}
          />
          <GameControls
            gameClient={gameClientRef.current}
            enabled={isConnected}
          />
        </>
      )}
    </div>
  );
};

export default GameOverlay;
