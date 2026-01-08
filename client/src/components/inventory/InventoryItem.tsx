import React, { useState, useMemo } from 'react';
import ItemTooltip from './ItemTooltip';
import MobileItemModal from './MobileItemModal';

interface InventoryItemData {
  inventory_id: number;
  item_id: number;
  quantity: number;
  name: string;
  display_name: string;
  emoji: string;
  description: string;
  item_type: 'buff' | 'debuff' | 'utility' | 'guard' | 'weapon' | 'marker';
  rarity: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
  cooldown_seconds: number;
  max_stack: number;
  last_used_at?: string;
}

interface InventoryItemProps {
  item: InventoryItemData;
  onUse: () => void;
  cooldownRemaining: number;
}

const InventoryItem: React.FC<InventoryItemProps> = ({ item, onUse, cooldownRemaining }) => {
  const [showTooltip, setShowTooltip] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 });
  const [showMobileModal, setShowMobileModal] = useState(false);

  // Detect mobile device
  const isMobile = useMemo(() => {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth <= 768;
  }, []);

  const handleMouseEnter = (e: React.MouseEvent) => {
    if (isMobile) return; // Don't show tooltip on mobile
    const rect = e.currentTarget.getBoundingClientRect();
    setTooltipPosition({
      x: rect.left - 10,
      y: rect.top
    });
    setShowTooltip(true);
  };

  const handleMouseLeave = () => {
    setShowTooltip(false);
  };

  const handleClick = () => {
    if (isMobile) {
      // On mobile, show item details modal instead of directly using
      setShowMobileModal(true);
    } else {
      // On desktop, use item directly (existing behavior)
      if (cooldownRemaining === 0 && item.quantity > 0) {
        onUse();
      }
    }
  };

  const handleMobileUse = () => {
    if (cooldownRemaining === 0 && item.quantity > 0) {
      onUse();
    }
  };

  const getRarityClass = () => {
    return `rarity-${item.rarity}`;
  };

  const isOnCooldown = cooldownRemaining > 0;
  const isEmpty = item.quantity === 0;

  return (
    <>
      <div
        className={`inventory-item ${getRarityClass()} ${isOnCooldown ? 'cooldown' : ''} ${isEmpty ? 'empty' : ''}`}
        data-type={item.item_type}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
      >
        <div className="item-emoji">{item.emoji}</div>
        {item.quantity > 1 && (
          <div className="item-quantity">{item.quantity}</div>
        )}
        {isOnCooldown && (
          <div className="item-cooldown-overlay">
            <div className="cooldown-text">{cooldownRemaining}s</div>
          </div>
        )}
      </div>
      {showTooltip && !isMobile && (
        <ItemTooltip
          item={item}
          position={tooltipPosition}
          cooldownRemaining={cooldownRemaining}
        />
      )}
      {showMobileModal && (
        <MobileItemModal
          item={item}
          cooldownRemaining={cooldownRemaining}
          onUse={handleMobileUse}
          onClose={() => setShowMobileModal(false)}
        />
      )}
    </>
  );
};

export default InventoryItem;