/**
 * GameCanvas - Canvas rendering component for the game
 */

import React, { useEffect, useRef } from 'react';
import { GameClient } from '../../services/game/GameClient';
import { PlayerState, WorldState, WorldItem } from '../../types/game';

interface GameCanvasProps {
  gameClient: GameClient | null;
  localPlayer: PlayerState | null;
  players: Record<string, PlayerState>;
  worldState: WorldState | null;
  items: WorldItem[];
  containerRef?: React.RefObject<HTMLDivElement>;
}

export const GameCanvas: React.FC<GameCanvasProps> = ({
  gameClient,
  localPlayer,
  players,
  worldState,
  items,
  containerRef
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const initialized = useRef(false);

  // Initialize renderer when canvas is ready
  useEffect(() => {
    if (!canvasRef.current || !gameClient || initialized.current) return;

    const canvas = canvasRef.current;

    // Set initial size
    if (containerRef?.current) {
      const rect = containerRef.current.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = rect.height;
    } else {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }

    // Initialize the renderer
    gameClient.initRenderer(canvas);
    initialized.current = true;

    console.log('[GameCanvas] Renderer initialized');

    return () => {
      initialized.current = false;
    };
  }, [gameClient, containerRef]);

  // Handle resize
  useEffect(() => {
    const handleResize = () => {
      if (!canvasRef.current || !gameClient) return;

      let width: number, height: number;

      if (containerRef?.current) {
        const rect = containerRef.current.getBoundingClientRect();
        width = rect.width;
        height = rect.height;
      } else {
        width = window.innerWidth;
        height = window.innerHeight;
      }

      canvasRef.current.width = width;
      canvasRef.current.height = height;
      gameClient.resizeRenderer(width, height);
    };

    window.addEventListener('resize', handleResize);
    handleResize(); // Initial call

    return () => window.removeEventListener('resize', handleResize);
  }, [gameClient, containerRef]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        display: 'block'
      }}
    />
  );
};

export default GameCanvas;
