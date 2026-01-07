import React from 'react';

interface ItemData {
  item_id: number;
  display_name: string;
  emoji: string;
  description: string;
  item_type: 'buff' | 'debuff' | 'utility' | 'guard' | 'weapon' | 'marker';
  rarity: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
  cooldown_seconds: number;
  quantity: number;
  max_stack: number;
}

interface MobileItemModalProps {
  item: ItemData;
  cooldownRemaining: number;
  onUse: () => void;
  onClose: () => void;
}

const MobileItemModal: React.FC<MobileItemModalProps> = ({
  item,
  cooldownRemaining,
  onUse,
  onClose
}) => {
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

  const isOnCooldown = cooldownRemaining > 0;
  const isEmpty = item.quantity === 0;
  const canUse = !isOnCooldown && !isEmpty;

  const handleUse = () => {
    if (canUse) {
      onUse();
      onClose();
    }
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div className="mobile-item-modal-backdrop" onClick={handleBackdropClick}>
      <div className="mobile-item-modal">
        {/* Header with emoji and name */}
        <div className="mobile-item-modal-header" style={{ borderBottomColor: getRarityColor() }}>
          <span className="mobile-item-emoji">{item.emoji}</span>
          <div className="mobile-item-info">
            <span className="mobile-item-name" style={{ color: getRarityColor() }}>
              {item.display_name}
            </span>
            <span className="mobile-item-meta">
              <span className="type-icon">{getItemTypeIcon()}</span>
              <span className="type-text">{item.item_type}</span>
              <span className="rarity-badge" style={{ backgroundColor: getRarityColor() }}>
                {item.rarity}
              </span>
            </span>
          </div>
        </div>

        {/* Description */}
        <div className="mobile-item-description">
          {item.description}
        </div>

        {/* Stats */}
        <div className="mobile-item-stats">
          <div className="mobile-stat">
            <span className="stat-label">Quantity</span>
            <span className="stat-value">{item.quantity}{item.max_stack > 0 ? `/${item.max_stack}` : ''}</span>
          </div>
          {item.cooldown_seconds > 0 && (
            <div className="mobile-stat">
              <span className="stat-label">Cooldown</span>
              <span className="stat-value">{formatCooldown(item.cooldown_seconds)}</span>
            </div>
          )}
          {isOnCooldown && (
            <div className="mobile-stat cooldown-active">
              <span className="stat-label">Ready in</span>
              <span className="stat-value">{formatCooldown(cooldownRemaining)}</span>
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div className="mobile-item-actions">
          <button
            className="mobile-item-cancel-btn"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className={`mobile-item-use-btn ${!canUse ? 'disabled' : ''}`}
            onClick={handleUse}
            disabled={!canUse}
          >
            {isOnCooldown ? `Cooldown (${formatCooldown(cooldownRemaining)})` :
             isEmpty ? 'No items left' :
             'Use Item'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default MobileItemModal;
