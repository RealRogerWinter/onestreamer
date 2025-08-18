import React from 'react';
import InventoryItem from './InventoryItem';

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

interface InventoryGridProps {
  items: InventoryItemData[];
  onUseItem: (itemId: number) => void;
  getCooldown: (itemId: number) => number;
}

const InventoryGrid: React.FC<InventoryGridProps> = ({ items, onUseItem, getCooldown }) => {
  return (
    <div className="inventory-grid">
      {items.map((item) => (
        <InventoryItem
          key={item.inventory_id}
          item={item}
          onUse={() => onUseItem(item.item_id)}
          cooldownRemaining={getCooldown(item.item_id)}
        />
      ))}
    </div>
  );
};

export default InventoryGrid;