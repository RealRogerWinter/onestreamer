import { Socket } from 'socket.io-client';

export interface InventoryItem {
  inventory_id: number;
  item_id: number;
  quantity: number;
  name: string;
  display_name: string;
  emoji: string;
  description: string;
  item_type: 'buff' | 'debuff' | 'utility' | 'guard' | 'weapon' | 'marker';
  category?: string;
  rarity: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
  cooldown_seconds: number;
  max_stack: number;
  last_used_at?: string;
}

export interface ItemCooldown {
  itemId: number;
  name: string;
  displayName: string;
  emoji: string;
  cooldownRemaining: number;
  cooldownEnd: number;
}

export interface UserProfile {
  points: number;
}

export interface InventoryPanelProps {
  socket: Socket | null;
  isAuthenticated: boolean;
  userProfile?: UserProfile | null;
  isOpen?: boolean;
  onToggle?: () => void;
  onToggleShop?: () => void;
  onLogin?: () => void;
  onSignup?: () => void;
  hideToggleButton?: boolean;
  hideHeader?: boolean;
}
