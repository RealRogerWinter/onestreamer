import React, { useState, useEffect } from 'react';
import { useMainSocket } from '../../contexts/SocketContext';
import './BuffApplication.css';

interface BuffItem {
  id: string;
  name: string;
  displayName: string;
  emoji: string;
  description: string;
  itemType: 'buff' | 'debuff';
  rarity: string;
  basePrice: number;
  cooldownSeconds: number;
  maxStack: number;
  durationSeconds: number;
  effectData?: any;
  stackBehavior: string;
}

interface InventoryItem {
  inventory_id: string;
  item_id: string;
  quantity: number;
  name: string;
  display_name: string;
  emoji: string;
  description: string;
  item_type: string;
  rarity: string;
  cooldown_seconds: number;
  duration_seconds: number;
}

interface BuffApplicationProps {
  targetUserId?: string;
  onBuffApplied?: (buff: any) => void;
  className?: string;
}

const BuffApplication: React.FC<BuffApplicationProps> = ({
  targetUserId,
  onBuffApplied,
  className = ''
}) => {
  const { socket, connected } = useMainSocket();
  const [availableItems, setAvailableItems] = useState<InventoryItem[]>([]);
  const [selectedItem, setSelectedItem] = useState<string | null>(null);
  const [isApplying, setIsApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [cooldowns, setCooldowns] = useState<any[]>([]);

  useEffect(() => {
    if (!socket || !connected) return;

    fetchAvailableItems();
    fetchUserCooldowns();

    socket.on('buff-applied-success', (data: any) => {
      setSuccess(`Applied ${data.buff.displayName} successfully!`);
      setIsApplying(false);
      setSelectedItem(null);
      setTimeout(() => setSuccess(null), 3000);
      
      if (onBuffApplied) {
        onBuffApplied(data.buff);
      }
      
      // Refresh inventory and cooldowns
      fetchAvailableItems();
      fetchUserCooldowns();
    });

    socket.on('buff-error', (data: any) => {
      setError(data.error);
      setIsApplying(false);
      setTimeout(() => setError(null), 5000);
    });

    return () => {
      socket.off('buff-applied-success');
      socket.off('buff-error');
    };
  }, [socket, connected, onBuffApplied]);

  const fetchAvailableItems = async () => {
    try {
      const response = await fetch('/api/inventory', {
        credentials: 'include'
      });
      
      if (response.ok) {
        const data = await response.json();
        // Filter to only buff/debuff items
        const buffItems = data.inventory.filter((item: InventoryItem) => 
          ['buff', 'debuff'].includes(item.item_type)
        );
        setAvailableItems(buffItems);
      }
    } catch (error) {
      console.error('Failed to fetch inventory:', error);
    }
  };

  const fetchUserCooldowns = async () => {
    try {
      const response = await fetch('/api/buffs/cooldowns/me', {
        credentials: 'include'
      });
      
      if (response.ok) {
        const data = await response.json();
        setCooldowns(data.cooldowns || []);
      }
    } catch (error) {
      console.error('Failed to fetch cooldowns:', error);
    }
  };

  const isItemOnCooldown = (itemId: string): { onCooldown: boolean; remaining: number } => {
    const cooldown = cooldowns.find(cd => cd.itemId === itemId);
    if (!cooldown) return { onCooldown: false, remaining: 0 };
    
    const remaining = Math.max(0, cooldown.cooldownRemaining);
    return { onCooldown: remaining > 0, remaining };
  };

  const formatCooldownTime = (seconds: number): string => {
    if (seconds <= 0) return '';
    
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    
    if (minutes > 0) {
      return `${minutes}m ${remainingSeconds}s`;
    }
    return `${remainingSeconds}s`;
  };

  const applyBuff = () => {
    if (!socket || !selectedItem || !targetUserId || isApplying) return;

    const item = availableItems.find(i => i.item_id === selectedItem);
    if (!item) return;

    const { onCooldown } = isItemOnCooldown(selectedItem);
    if (onCooldown) {
      setError('This item is on cooldown');
      return;
    }

    setIsApplying(true);
    setError(null);
    
    socket.emit('apply-buff-item', {
      targetUserId,
      itemId: selectedItem
    });
  };

  const getRarityClass = (rarity: string): string => {
    return `rarity-${rarity.toLowerCase()}`;
  };

  const getItemTypeClass = (itemType: string): string => {
    return itemType === 'buff' ? 'item-buff' : 'item-debuff';
  };

  if (!targetUserId) {
    return (
      <div className={`buff-application ${className}`}>
        <div className="no-target">No target selected</div>
      </div>
    );
  }

  return (
    <div className={`buff-application ${className}`}>
      <div className="buff-header">
        <h3>Apply Effect</h3>
      </div>

      {error && (
        <div className="buff-error">
          ⚠️ {error}
        </div>
      )}

      {success && (
        <div className="buff-success">
          ✅ {success}
        </div>
      )}

      <div className="item-grid">
        {availableItems.length === 0 ? (
          <div className="no-items">No buff/debuff items available</div>
        ) : (
          availableItems.map((item) => {
            const { onCooldown, remaining } = isItemOnCooldown(item.item_id);
            
            return (
              <div
                key={item.inventory_id}
                className={`
                  item-card 
                  ${getRarityClass(item.rarity)} 
                  ${getItemTypeClass(item.item_type)}
                  ${selectedItem === item.item_id ? 'selected' : ''}
                  ${onCooldown ? 'on-cooldown' : ''}
                  ${item.quantity <= 0 ? 'out-of-stock' : ''}
                `}
                onClick={() => !onCooldown && item.quantity > 0 && setSelectedItem(item.item_id)}
                title={`${item.display_name}: ${item.description} (${item.quantity} available)`}
              >
                <div className="item-emoji">{item.emoji}</div>
                <div className="item-info">
                  <div className="item-name">{item.display_name}</div>
                  <div className="item-details">
                    <span className="item-duration">{item.duration_seconds}s</span>
                    <span className="item-quantity">×{item.quantity}</span>
                  </div>
                  {onCooldown && (
                    <div className="item-cooldown">
                      {formatCooldownTime(remaining)}
                    </div>
                  )}
                </div>
                <div className={`item-type-badge ${item.item_type}`}>
                  {item.item_type === 'buff' ? '+' : '-'}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="application-controls">
        <button
          className="apply-button"
          onClick={applyBuff}
          disabled={!selectedItem || isApplying || !targetUserId}
        >
          {isApplying ? 'Applying...' : 'Apply Effect'}
        </button>
        
        {selectedItem && (
          <button
            className="clear-button"
            onClick={() => setSelectedItem(null)}
          >
            Clear Selection
          </button>
        )}
      </div>

      {selectedItem && (
        <div className="selected-item-info">
          {(() => {
            const item = availableItems.find(i => i.item_id === selectedItem);
            return item ? (
              <div>
                <strong>{item.display_name} {item.emoji}</strong>
                <p>{item.description}</p>
                <small>
                  Duration: {item.duration_seconds}s | 
                  Cooldown: {item.cooldown_seconds}s | 
                  Available: {item.quantity}
                </small>
              </div>
            ) : null;
          })()}
        </div>
      )}
    </div>
  );
};

export default BuffApplication;