import React, { useState, useEffect } from 'react';
import './ItemNotification.css';

interface ItemNotificationProps {
  emoji: string;
  itemName: string;
  type: 'use' | 'purchase' | 'ready' | 'throw' | 'error';
  quantity?: number;
  show: boolean;
  onComplete: () => void;
}

const ItemNotification: React.FC<ItemNotificationProps> = ({ 
  emoji, 
  itemName, 
  type, 
  quantity = 1,
  show, 
  onComplete 
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);

  useEffect(() => {
    if (show) {
      setIsVisible(true);
      setIsAnimating(true);
      
      // Start exit animation after 2.5 seconds
      const exitTimer = setTimeout(() => {
        setIsAnimating(false);
      }, 2500);

      // Remove component after exit animation completes
      const removeTimer = setTimeout(() => {
        setIsVisible(false);
        onComplete();
      }, 3000);

      return () => {
        clearTimeout(exitTimer);
        clearTimeout(removeTimer);
      };
    }
  }, [show, onComplete]);

  if (!isVisible) return null;

  const getNotificationText = () => {
    switch (type) {
      case 'purchase':
        return quantity > 1 
          ? `Purchased ${quantity}x ${itemName}!`
          : `Purchased ${itemName}!`;
      case 'ready':
        return itemName; // Already formatted on the server side
      case 'throw':
        return itemName; // Already formatted on the server side
      case 'error':
        return itemName; // Already formatted on the server side
      case 'use':
      default:
        // For usage, the itemName already includes the "You used" part
        return itemName.includes('You used') ? itemName : `Used ${itemName}!`;
    }
  };

  const getTypeClass = () => {
    switch (type) {
      case 'purchase':
        return 'purchase';
      case 'ready':
        return 'ready';
      case 'throw':
        return 'throw';
      case 'error':
        return 'error';
      default:
        return 'use';
    }
  };

  return (
    <div className={`item-notification-overlay ${isAnimating ? 'show' : 'hide'}`}>
      <div className={`item-notification ${getTypeClass()}`}>
        <div className="item-notification-emoji">
          {emoji}
        </div>
        <div className="item-notification-text">
          {getNotificationText()}
        </div>
      </div>
    </div>
  );
};

export default ItemNotification;