import React from 'react';
import ShopItem from './ShopItem';

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

interface ShopGridProps {
  items: ShopItemData[];
  onPurchaseItem: (itemId: number) => void;
  userPoints: number;
  isAuthenticated: boolean;
  purchasedItemId?: number | null;
}

const ShopGrid: React.FC<ShopGridProps> = ({ 
  items, 
  onPurchaseItem, 
  userPoints, 
  isAuthenticated,
  purchasedItemId
}) => {
  return (
    <div className="shop-grid">
      {items.map((item) => (
        <ShopItem
          key={item.shop_id}
          item={item}
          onPurchase={() => onPurchaseItem(item.item_id)}
          userPoints={userPoints}
          isAuthenticated={isAuthenticated}
          isJustPurchased={purchasedItemId === item.item_id}
        />
      ))}
    </div>
  );
};

export default ShopGrid;