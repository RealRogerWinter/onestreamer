/**
 * GameControls - Mobile touch controls for the game
 */

import React, { useRef, useCallback, useState } from 'react';
import { GameClient } from '../../services/game/GameClient';

interface GameControlsProps {
  gameClient: GameClient | null;
  enabled: boolean;
}

export const GameControls: React.FC<GameControlsProps> = ({
  gameClient,
  enabled
}) => {
  const joystickRef = useRef<HTMLDivElement>(null);
  const [joystickActive, setJoystickActive] = useState(false);
  const [joystickPos, setJoystickPos] = useState({ x: 0, y: 0 });
  const joystickCenter = useRef({ x: 0, y: 0 });

  const maxDistance = 40;

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (!enabled || !joystickRef.current) return;

    const rect = joystickRef.current.getBoundingClientRect();
    const touch = e.touches[0];

    joystickCenter.current = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    };

    setJoystickActive(true);

    // Calculate initial position
    const dx = touch.clientX - joystickCenter.current.x;
    const dy = touch.clientY - joystickCenter.current.y;
    const distance = Math.min(maxDistance, Math.sqrt(dx * dx + dy * dy));
    const angle = Math.atan2(dy, dx);

    setJoystickPos({
      x: Math.cos(angle) * distance,
      y: Math.sin(angle) * distance
    });
  }, [enabled]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!joystickActive) return;

    const touch = e.touches[0];
    const dx = touch.clientX - joystickCenter.current.x;
    const dy = touch.clientY - joystickCenter.current.y;
    const distance = Math.min(maxDistance, Math.sqrt(dx * dx + dy * dy));
    const angle = Math.atan2(dy, dx);

    const newX = Math.cos(angle) * distance;
    const newY = Math.sin(angle) * distance;

    setJoystickPos({ x: newX, y: newY });

    // The input is already handled by GameInputHandler via touch events
  }, [joystickActive]);

  const handleTouchEnd = useCallback(() => {
    setJoystickActive(false);
    setJoystickPos({ x: 0, y: 0 });
  }, []);

  const handleActionButton = useCallback((action: 'interact' | 'primary') => {
    if (!enabled || !gameClient) return;
    gameClient.interact();
  }, [enabled, gameClient]);

  // Only show on touch devices
  const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

  if (!isTouchDevice || !enabled) {
    return null;
  }

  return (
    <div
      className="game-controls"
      style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: '200px',
        pointerEvents: 'auto'
      }}
    >
      {/* Virtual Joystick - Left side */}
      <div
        ref={joystickRef}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{
          position: 'absolute',
          left: '30px',
          bottom: '30px',
          width: '120px',
          height: '120px',
          borderRadius: '50%',
          backgroundColor: 'rgba(255, 255, 255, 0.1)',
          border: '3px solid rgba(255, 255, 255, 0.3)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        {/* Joystick knob */}
        <div
          style={{
            width: '50px',
            height: '50px',
            borderRadius: '50%',
            backgroundColor: joystickActive
              ? 'rgba(78, 205, 196, 0.8)'
              : 'rgba(255, 255, 255, 0.5)',
            transform: `translate(${joystickPos.x}px, ${joystickPos.y}px)`,
            transition: joystickActive ? 'none' : 'transform 0.2s ease-out',
            boxShadow: joystickActive
              ? '0 0 20px rgba(78, 205, 196, 0.5)'
              : 'none'
          }}
        />
      </div>

      {/* Action Buttons - Right side */}
      <div
        style={{
          position: 'absolute',
          right: '30px',
          bottom: '30px',
          display: 'flex',
          flexDirection: 'column',
          gap: '15px'
        }}
      >
        {/* Primary action button */}
        <button
          onTouchStart={() => handleActionButton('primary')}
          style={{
            width: '70px',
            height: '70px',
            borderRadius: '50%',
            backgroundColor: 'rgba(255, 107, 107, 0.8)',
            border: '3px solid rgba(255, 255, 255, 0.5)',
            color: '#ffffff',
            fontSize: '24px',
            fontWeight: 'bold',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          A
        </button>

        {/* Interact button */}
        <button
          onTouchStart={() => handleActionButton('interact')}
          style={{
            width: '60px',
            height: '60px',
            borderRadius: '50%',
            backgroundColor: 'rgba(78, 205, 196, 0.8)',
            border: '3px solid rgba(255, 255, 255, 0.5)',
            color: '#ffffff',
            fontSize: '20px',
            fontWeight: 'bold',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          B
        </button>
      </div>
    </div>
  );
};

export default GameControls;
