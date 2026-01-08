import React, { useState } from 'react';
import './ShopQuantitySelector.css';

interface ShopQuantitySelectorProps {
  itemId: number;
  itemName: string;
  emoji: string;
  price: number;
  maxQuantity?: number;
  userPoints: number;
  onPurchase: (itemId: number, quantity: number, itemName: string, emoji: string) => Promise<void>;
  onClose: () => void;
}

const ShopQuantitySelector: React.FC<ShopQuantitySelectorProps> = ({
  itemId,
  itemName,
  emoji,
  price,
  maxQuantity = 99,
  userPoints,
  onPurchase,
  onClose
}) => {
  const [quantity, setQuantity] = useState(1);
  const [isPurchasing, setIsPurchasing] = useState(false);

  const maxAffordable = Math.floor(userPoints / price);
  const actualMax = Math.min(maxQuantity, maxAffordable);
  const totalCost = quantity * price;

  const handleQuantityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = Math.max(1, Math.min(actualMax, parseInt(e.target.value) || 1));
    setQuantity(value);
  };

  const handlePurchase = async () => {
    if (isPurchasing || quantity < 1 || quantity > actualMax) return;
    
    setIsPurchasing(true);
    try {
      await onPurchase(itemId, quantity, itemName, emoji);
      onClose();
    } catch (error) {
      console.error('Purchase failed:', error);
      // Close the dialog so the error message is visible to the user
      onClose();
    } finally {
      setIsPurchasing(false);
    }
  };

  const canAfford = totalCost <= userPoints && quantity > 0;

  return (
    <div className="shop-quantity-overlay" onClick={onClose}>
      <div className="shop-quantity-modal" onClick={(e) => e.stopPropagation()}>
        <button className="shop-quantity-close" onClick={onClose}>×</button>
        
        <div className="shop-quantity-header">
          <span className="shop-quantity-emoji">{emoji}</span>
          <h3 className="shop-quantity-title">{itemName}</h3>
        </div>
        
        <div className="shop-quantity-controls">
          <label className="shop-quantity-label">Quantity:</label>
          <div className="shop-quantity-input-group">
            <button 
              type="button"
              className="shop-quantity-btn"
              onClick={() => setQuantity(Math.max(1, quantity - 1))}
              disabled={quantity <= 1}
            >
              -
            </button>
            <input
              type="number"
              className="shop-quantity-input"
              value={quantity}
              onChange={handleQuantityChange}
              min="1"
              max={actualMax}
            />
            <button 
              type="button"
              className="shop-quantity-btn"
              onClick={() => setQuantity(Math.min(actualMax, quantity + 1))}
              disabled={quantity >= actualMax}
            >
              +
            </button>
          </div>
        </div>
        
        <div className="shop-quantity-summary">
          <div className="shop-quantity-cost">
            <span>Total Cost: </span>
            <span className={`shop-quantity-total ${!canAfford ? 'insufficient' : ''}`}>
              {totalCost.toLocaleString()} points
            </span>
          </div>
          <div className="shop-quantity-balance">
            Your Balance: {userPoints.toLocaleString()} points
          </div>
          {!canAfford && (
            <div className="shop-quantity-warning">
              Insufficient points for this quantity
            </div>
          )}
        </div>
        
        <div className="shop-quantity-actions">
          <button 
            className="shop-quantity-cancel" 
            onClick={onClose}
            disabled={isPurchasing}
          >
            Cancel
          </button>
          <button 
            className="shop-quantity-purchase" 
            onClick={handlePurchase}
            disabled={!canAfford || isPurchasing}
          >
            {isPurchasing ? 'Purchasing...' : `Purchase ${quantity > 1 ? `${quantity}x` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ShopQuantitySelector;