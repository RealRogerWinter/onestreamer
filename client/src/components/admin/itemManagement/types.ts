export interface Item {
  id: number;
  name: string;
  display_name: string;
  emoji: string;
  description: string;
  item_type: 'buff' | 'debuff' | 'utility';
  category?: string;
  rarity: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
  cooldown_seconds: number;
  duration_seconds: number;
  max_stack: number;
  created_at: string;
  updated_at: string;
}

export interface ShopItemData {
  shop_item_id: number;
  item_id: number;
  price: number;
  stock: number;
  is_featured: boolean;
  discount_percentage: number | null;
  created_at: string;
  updated_at: string;
  item?: Item;
}

export interface EditableItem extends Item {
  isEditing?: boolean;
}

export interface NewItemForm {
  name: string;
  display_name: string;
  emoji: string;
  description: string;
  item_type: 'buff' | 'debuff' | 'utility';
  category: string;
  rarity: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
  base_price: number;
  cooldown_seconds: number;
  duration_seconds: number;
  max_stack: number;
}

export const getRarityColor = (rarity: string): string => {
  switch (rarity) {
    case 'common': return '#9d9d9d';
    case 'uncommon': return '#1eff00';
    case 'rare': return '#0070dd';
    case 'epic': return '#a335ee';
    case 'legendary': return '#ff8000';
    default: return '#9d9d9d';
  }
};

export const getTypeIcon = (type: string): string => {
  switch (type) {
    case 'buff': return '⚡';
    case 'debuff': return '🔥';
    case 'utility': return '🔧';
    default: return '📦';
  }
};
