import React from 'react';

interface ItemData {
  display_name: string;
  emoji: string;
  description: string;
  item_type: 'buff' | 'debuff' | 'utility' | 'guard' | 'weapon' | 'marker';
  rarity: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
  cooldown_seconds: number;
  quantity: number;
  max_stack: number;
}

interface ItemTooltipProps {
  item: ItemData;
  position: { x: number; y: number };
  cooldownRemaining?: number;
}

const ItemTooltip: React.FC<ItemTooltipProps> = ({ item, position, cooldownRemaining = 0 }) => {
  const calculateTooltipPosition = () => {
    const tooltipWidth = 280; // Approximate tooltip width
    const tooltipHeight = 200; // Approximate tooltip height
    const padding = 10; // Padding from screen edges
    
    // Default position: to the right of the element
    let x = position.x + 60; // Offset to the right of the item
    let y = position.y;
    
    // Check if tooltip would go off the right edge
    if (x + tooltipWidth > window.innerWidth - padding) {
      x = position.x - tooltipWidth - 10; // Position to the left of the element
    }
    
    // Check if tooltip would go off the bottom edge
    if (y + tooltipHeight > window.innerHeight - padding) {
      y = position.y - tooltipHeight + 60; // Position above, but keep some of the element visible
    }
    
    // Ensure tooltip doesn't go off the left edge
    if (x < padding) {
      x = padding;
    }
    
    // Ensure tooltip doesn't go off the top edge
    if (y < padding) {
      y = padding;
    }
    
    return { x, y };
  };

  const tooltipPosition = calculateTooltipPosition();

  const getRarityColor = () => {
    switch (item.rarity) {
      case 'common': return '#9d9d9d';
      case 'uncommon': return '#1eff00';
      case 'rare': return '#0070dd';
      case 'epic': return '#a335ee';
      case 'legendary': return '#ff8000';
      default: return '#ffffff';
    }
  };

  const getItemTypeIcon = () => {
    switch (item.item_type) {
      case 'buff': return '⬆️';
      case 'debuff': return '⬇️';
      case 'utility': return '🔧';
      case 'guard': return '🛡️';
      case 'weapon': return '⚔️';
      default: return '❓';
    }
  };

  const formatCooldown = (seconds: number) => {
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  };

  return (
    <div 
      className="item-tooltip"
      style={{
        left: `${tooltipPosition.x}px`,
        top: `${tooltipPosition.y}px`
      }}
    >
      <div className="tooltip-header" style={{ borderColor: getRarityColor() }}>
        <span className="tooltip-emoji">{item.emoji}</span>
        <span className="tooltip-name" style={{ color: getRarityColor() }}>
          {item.display_name}
        </span>
      </div>
      
      <div className="tooltip-type">
        <span className="type-icon">{getItemTypeIcon()}</span>
        <span className="type-text">{item.item_type}</span>
        <span className="rarity-text" style={{ color: getRarityColor() }}>
          {item.rarity}
        </span>
      </div>

      <div className="tooltip-description">
        {item.description}
      </div>

      <div className="tooltip-stats">
        <div className="stat-row">
          <span className="stat-label">Quantity:</span>
          <span className="stat-value">{item.quantity}/{item.max_stack === 0 ? 'Unlimited' : item.max_stack}</span>
        </div>
        {item.cooldown_seconds > 0 && (
          <div className="stat-row">
            <span className="stat-label">Cooldown:</span>
            <span className="stat-value">{formatCooldown(item.cooldown_seconds)}</span>
          </div>
        )}
        {cooldownRemaining > 0 && (
          <div className="stat-row cooldown-active">
            <span className="stat-label">Ready in:</span>
            <span className="stat-value">{formatCooldown(cooldownRemaining)}</span>
          </div>
        )}
      </div>

      <div className="tooltip-footer">
        {cooldownRemaining === 0 && item.quantity > 0 ? (
          <span className="tooltip-hint">Click to use</span>
        ) : cooldownRemaining > 0 ? (
          <span className="tooltip-hint cooldown">On cooldown</span>
        ) : (
          <span className="tooltip-hint empty">No items remaining</span>
        )}
      </div>
    </div>
  );
};

export default ItemTooltip;