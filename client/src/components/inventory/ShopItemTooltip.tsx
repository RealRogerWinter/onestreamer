import React from 'react';

interface ShopItemData {
  shop_id: number;
  item_id: number;
  name: string;
  display_name: string;
  emoji: string;
  description: string;
  item_type: 'buff' | 'debuff' | 'utility' | 'guard' | 'weapon' | 'marker';
  rarity: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
  price: number;
  stock_limit: number;
  is_featured: number;
  discount_percentage: number;
}

interface ShopItemTooltipProps {
  item: ShopItemData;
  position: { x: number; y: number };
  userPoints: number;
  canAfford: boolean;
  isAuthenticated: boolean;
}

const ShopItemTooltip: React.FC<ShopItemTooltipProps> = ({ 
  item, 
  position, 
  userPoints, 
  canAfford, 
  isAuthenticated 
}) => {
  const calculateTooltipPosition = () => {
    const tooltipWidth = 350; // Approximate tooltip width (shop tooltips are wider)
    const tooltipHeight = 250; // Approximate tooltip height
    const padding = 10; // Padding from screen edges
    const offset = 20; // Offset from cursor
    
    // Default position: offset from cursor
    let x = position.x + offset;
    let y = position.y + offset;
    
    // Check if tooltip would go off the right edge
    if (x + tooltipWidth > window.innerWidth - padding) {
      x = position.x - tooltipWidth - offset; // Position to the left of cursor
    }
    
    // Check if tooltip would go off the bottom edge
    if (y + tooltipHeight > window.innerHeight - padding) {
      y = position.y - tooltipHeight - offset; // Position above cursor
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

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'buff': return '⚡';
      case 'debuff': return '🔥';
      case 'utility': return '🔧';
      default: return '📦';
    }
  };

  const getRarityColor = (rarity: string) => {
    switch (rarity) {
      case 'common': return '#9d9d9d';
      case 'uncommon': return '#1eff00';
      case 'rare': return '#0070dd';
      case 'epic': return '#a335ee';
      case 'legendary': return '#ff8000';
      default: return '#9d9d9d';
    }
  };

  const getDiscountedPrice = () => {
    if (item.discount_percentage > 0) {
      return Math.floor(item.price * (1 - item.discount_percentage / 100));
    }
    return item.price;
  };

  const discountedPrice = getDiscountedPrice();
  const hasDiscount = item.discount_percentage > 0;

  return (
    <div 
      className="shop-item-tooltip"
      style={{
        left: tooltipPosition.x,
        top: tooltipPosition.y,
      }}
    >
      <div 
        className="tooltip-header"
        style={{ borderColor: getRarityColor(item.rarity) }}
      >
        <span className="tooltip-emoji">{item.emoji}</span>
        <div className="tooltip-title">
          <div 
            className="tooltip-name"
            style={{ color: getRarityColor(item.rarity) }}
          >
            {item.display_name}
          </div>
          {item.is_featured > 0 && (
            <div className="featured-indicator">
              ⭐ Featured Item
            </div>
          )}
        </div>
      </div>

      <div className="tooltip-type">
        <span className="type-icon">{getTypeIcon(item.item_type)}</span>
        <span className="type-text">{item.item_type}</span>
        <span 
          className="rarity-text"
          style={{ color: getRarityColor(item.rarity) }}
        >
          {item.rarity}
        </span>
      </div>

      <div className="tooltip-description">
        {item.description}
      </div>

      <div className="tooltip-stats">
        <div className="stat-row">
          <span className="stat-label">Price:</span>
          <div className="price-info">
            {hasDiscount && (
              <span className="original-price-tooltip">
                {item.price.toLocaleString()} 💎
              </span>
            )}
            <span className="current-price-tooltip">
              {discountedPrice.toLocaleString()} 💎
            </span>
            {hasDiscount && (
              <span className="discount-info">
                ({item.discount_percentage}% off!)
              </span>
            )}
          </div>
        </div>
        
        {/* Only show stock info for limited or out-of-stock items */}
        {item.stock_limit > 0 || item.stock_limit < 0 ? (
          <div className="stat-row">
            <span className="stat-label">Stock:</span>
            <span className={`stat-value ${item.stock_limit < 0 ? 'out-of-stock' : ''}`}>
              {item.stock_limit > 0 ? `${item.stock_limit} available` : 'Out of stock'}
            </span>
          </div>
        ) : null}

        {isAuthenticated && (
          <div className="stat-row">
            <span className="stat-label">Your Points:</span>
            <span className="stat-value">
              {userPoints.toLocaleString()} 💎
            </span>
          </div>
        )}
      </div>

      <div className="tooltip-footer">
        {!isAuthenticated ? (
          <div className="tooltip-hint login-required">
            Please log in to purchase items
          </div>
        ) : item.stock_limit < 0 ? (
          <div className="tooltip-hint out-of-stock">
            This item is currently out of stock
          </div>
        ) : !canAfford ? (
          <div className="tooltip-hint insufficient-points">
            You need {(discountedPrice - userPoints).toLocaleString()} more points
          </div>
        ) : (
          <div className="tooltip-hint can-purchase">
            Click to purchase this item
          </div>
        )}
      </div>
    </div>
  );
};

export default ShopItemTooltip;