import React, { useState } from 'react';
import ShopItemTooltip from './ShopItemTooltip';

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

interface ShopItemProps {
  item: ShopItemData;
  onPurchase: () => void;
  userPoints: number;
  isAuthenticated: boolean;
  isJustPurchased?: boolean;
}

const ShopItem: React.FC<ShopItemProps> = ({ 
  item, 
  onPurchase, 
  userPoints, 
  isAuthenticated,
  isJustPurchased = false
}) => {
  const [showTooltip, setShowTooltip] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 });

  const canAfford = userPoints >= item.price;
  const isOutOfStock = item.stock_limit < 0;
  const isDisabled = !isAuthenticated || !canAfford || isOutOfStock;

  const handleMouseEnter = (e: React.MouseEvent) => {
    setTooltipPosition({ x: e.clientX, y: e.clientY });
    setShowTooltip(true);
  };

  const handleMouseLeave = () => {
    setShowTooltip(false);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    setTooltipPosition({ x: e.clientX, y: e.clientY });
  };

  const handlePurchase = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!isDisabled) {
      onPurchase();
    }
  };

  const getDiscountedPrice = () => {
    if (item.discount_percentage) {
      return Math.floor(item.price * (1 - item.discount_percentage / 100));
    }
    return item.price;
  };

  const discountedPrice = getDiscountedPrice();
  const hasDiscount = item.discount_percentage > 0;

  return (
    <>
      <div 
        className={`shop-item rarity-${item.rarity} ${isDisabled ? 'disabled' : ''} ${isOutOfStock ? 'out-of-stock' : ''} ${item.is_featured > 0 ? 'featured' : ''} ${isJustPurchased ? 'just-purchased' : ''}`}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onMouseMove={handleMouseMove}
        onClick={handlePurchase}
      >
        {item.is_featured > 0 && (
          <div className="featured-badge">
            ⭐
          </div>
        )}
        
        {hasDiscount && (
          <div className="discount-badge">
            -{item.discount_percentage}%
          </div>
        )}

        <div className="shop-item-emoji">
          {item.emoji}
        </div>

        <div className="shop-item-info">
          <div className="shop-item-name">
            {item.display_name}
          </div>
          
          <div className="shop-item-price">
            {hasDiscount && (
              <span className="original-price">
                {item.price.toLocaleString()}
              </span>
            )}
            <div className="current-price">
              <span className="points-emoji">💎</span>
              <span className="price-value">
                {discountedPrice.toLocaleString()}
              </span>
            </div>
          </div>

          {/* Only show stock info for limited items */}
          {item.stock_limit > 0 ? (
            <div className="shop-item-stock">
              <span className="stock-available">
                Stock: {item.stock_limit}
              </span>
            </div>
          ) : item.stock_limit < 0 ? (
            <div className="shop-item-stock">
              <span className="stock-empty">
                Out of Stock
              </span>
            </div>
          ) : null}

          {!isAuthenticated ? (
            <div className="item-status login-required">
              Login Required
            </div>
          ) : isOutOfStock ? (
            <div className="item-status out-of-stock">
              Out of Stock
            </div>
          ) : !canAfford ? (
            <div className="item-status insufficient-points">
              Insufficient Points
            </div>
          ) : (
            <div className="item-status can-purchase">
              Click to Purchase
            </div>
          )}
        </div>

        {!isDisabled && (
          <div className="shop-item-hover-effect">
            <div className="purchase-hint">
              🛒 Buy Now
            </div>
          </div>
        )}
      </div>

      {showTooltip && (
        <ShopItemTooltip
          item={item}
          position={tooltipPosition}
          userPoints={userPoints}
          canAfford={canAfford}
          isAuthenticated={isAuthenticated}
        />
      )}
    </>
  );
};

export default ShopItem;