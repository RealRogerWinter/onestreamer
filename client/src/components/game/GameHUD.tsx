/**
 * GameHUD - Heads-up display for game information
 */

import React from 'react';
import { PlayerState, InventoryItem } from '../../types/game';

interface GameHUDProps {
  localPlayer: PlayerState | null;
  playerCount: number;
}

export const GameHUD: React.FC<GameHUDProps> = ({
  localPlayer,
  playerCount
}) => {
  if (!localPlayer) return null;

  return (
    <div
      className="game-hud"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        pointerEvents: 'none',
        fontFamily: 'Arial, sans-serif'
      }}
    >
      {/* Player info - top left */}
      <div
        style={{
          position: 'absolute',
          top: '10px',
          left: '10px',
          backgroundColor: 'rgba(0, 0, 0, 0.6)',
          padding: '10px 15px',
          borderRadius: '8px',
          color: '#ffffff'
        }}
      >
        <div style={{ fontSize: '16px', fontWeight: 'bold', marginBottom: '5px' }}>
          {localPlayer.username}
        </div>
        <div style={{ fontSize: '12px', opacity: 0.8 }}>
          Position: {Math.round(localPlayer.x)}, {Math.round(localPlayer.y)}
        </div>
      </div>

      {/* Instructions - top center */}
      <div
        style={{
          position: 'absolute',
          top: '10px',
          left: '50%',
          transform: 'translateX(-50%)',
          backgroundColor: 'rgba(0, 0, 0, 0.6)',
          padding: '8px 16px',
          borderRadius: '8px',
          color: '#ffffff',
          fontSize: '12px',
          textAlign: 'center'
        }}
      >
        <div>WASD or Arrow Keys to move</div>
        <div style={{ opacity: 0.7 }}>E to interact | Space for action</div>
      </div>

      {/* Inventory - bottom left */}
      {localPlayer.inventory && localPlayer.inventory.length > 0 && (
        <div
          style={{
            position: 'absolute',
            bottom: '10px',
            left: '10px',
            backgroundColor: 'rgba(0, 0, 0, 0.6)',
            padding: '10px',
            borderRadius: '8px',
            color: '#ffffff'
          }}
        >
          <div style={{ fontSize: '12px', marginBottom: '8px', opacity: 0.8 }}>
            Inventory
          </div>
          <div style={{ display: 'flex', gap: '5px' }}>
            {localPlayer.inventory.slice(0, 9).map((item, index) => (
              <InventorySlot
                key={item.id}
                item={item}
                slot={index + 1}
              />
            ))}
          </div>
        </div>
      )}

      {/* Game Mode Indicator - bottom center */}
      <div
        style={{
          position: 'absolute',
          bottom: '10px',
          left: '50%',
          transform: 'translateX(-50%)',
          backgroundColor: 'rgba(78, 205, 196, 0.8)',
          padding: '8px 20px',
          borderRadius: '20px',
          color: '#ffffff',
          fontSize: '14px',
          fontWeight: 'bold'
        }}
      >
        GAME MODE ACTIVE
      </div>
    </div>
  );
};

// Inventory slot component
const InventorySlot: React.FC<{ item: InventoryItem; slot: number }> = ({ item, slot }) => {
  const getItemColor = (type: string): string => {
    const colors: Record<string, string> = {
      coin: '#ffd700',
      gem: '#8a2be2',
      powerup: '#00ff7f'
    };
    return colors[type] || '#ffffff';
  };

  return (
    <div
      style={{
        width: '40px',
        height: '40px',
        backgroundColor: 'rgba(255, 255, 255, 0.1)',
        border: '2px solid rgba(255, 255, 255, 0.3)',
        borderRadius: '4px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative'
      }}
    >
      {/* Item icon */}
      <div
        style={{
          width: '24px',
          height: '24px',
          borderRadius: '50%',
          backgroundColor: getItemColor(item.type)
        }}
      />

      {/* Slot number */}
      <div
        style={{
          position: 'absolute',
          top: '2px',
          left: '4px',
          fontSize: '10px',
          opacity: 0.6
        }}
      >
        {slot}
      </div>
    </div>
  );
};

export default GameHUD;
