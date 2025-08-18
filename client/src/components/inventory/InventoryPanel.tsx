import React, { useState, useEffect } from 'react';
import { Socket } from 'socket.io-client';
import InventoryGrid from './InventoryGrid';
import authService from '../../services/AuthService';
import TTSInputModal from '../soundfx/TTSInputModal';
import './InventoryStyles.css';

interface InventoryItem {
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

interface ItemCooldown {
  itemId: number;
  name: string;
  displayName: string;
  emoji: string;
  cooldownRemaining: number;
  cooldownEnd: number;
}

interface UserProfile {
  points: number;
}

interface InventoryPanelProps {
  socket: Socket | null;
  isAuthenticated: boolean;
  userProfile?: UserProfile | null;
  isOpen?: boolean;
  onToggle?: () => void;
  onToggleShop?: () => void;
}

const InventoryPanel: React.FC<InventoryPanelProps> = ({ 
  socket, 
  isAuthenticated, 
  userProfile, 
  isOpen = false, 
  onToggle, 
  onToggleShop 
}) => {
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [cooldowns, setCooldowns] = useState<ItemCooldown[]>([]);
  const [inventorySubTab, setInventorySubTab] = useState<'all' | 'buff' | 'debuff' | 'utility' | 'guard' | 'weapon' | 'marker'>('all');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentInventoryPage, setCurrentInventoryPage] = useState(1);
  const [isAdmin, setIsAdmin] = useState(false);
  const [ttsModalOpen, setTtsModalOpen] = useState(false);
  const [ttsItem, setTtsItem] = useState<InventoryItem | null>(null);
  const inventoryItemsPerPage = 18; // Increased from 12 to show more items

  useEffect(() => {
    if (isAuthenticated && isOpen) {
      fetchInventory();
      fetchCooldowns();
      checkAdminStatus();
    }
  }, [isAuthenticated, isOpen]);


  useEffect(() => {
    if (!socket) return;

    const handleInventoryUpdate = (data: any) => {
      fetchInventory();
    };

    const handleItemUsed = (data: any) => {
      // ALWAYS update cooldown if present, regardless of notification handling
      if (data.item && data.item.cooldown) {
        console.log('⏰ INVENTORY: Updating cooldown for item:', data.item.displayName, 'cooldown:', data.item.cooldown);
        setCooldowns(prev => [
          ...prev.filter(cd => cd.itemId !== data.item.id),
          {
            itemId: data.item.id,
            name: data.item.name,
            displayName: data.item.displayName,
            emoji: data.item.emoji,
            cooldownRemaining: data.item.cooldown,
            cooldownEnd: Date.now() + (data.item.cooldown * 1000)
          }
        ]);
      }
      
      // Don't show notifications for interactive items using fallback mode
      if (data.interactiveFallback) {
        console.log('🔇 INVENTORY: Skipping notification for interactive item fallback:', data.item);
        return;
      }
      
      // Don't show notifications for items that were thrown (interactive items)
      if (data.thrown) {
        console.log('🔇 INVENTORY: Skipping notification for thrown interactive item:', data.item?.displayName || data.item?.name);
        return;
      }
      
      // Don't show any notifications - let the individual use handlers manage this
      console.log('🔇 INVENTORY: Skipping all item-used notifications to prevent duplicates');
    };

    socket.on('inventory-updated', handleInventoryUpdate);
    socket.on('item-used', handleItemUsed);

    return () => {
      socket.off('inventory-updated', handleInventoryUpdate);
      socket.off('item-used', handleItemUsed);
    };
  }, [socket]);

  useEffect(() => {
    const interval = setInterval(() => {
      setCooldowns(prev => prev
        .map(cd => ({
          ...cd,
          cooldownRemaining: Math.max(0, Math.ceil((cd.cooldownEnd - Date.now()) / 1000))
        }))
        .filter(cd => cd.cooldownRemaining > 0)
      );
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const fetchInventory = async () => {
    try {
      setIsLoading(true);
      const token = localStorage.getItem('auth_token');
      const response = await fetch('/api/inventory', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        throw new Error('Failed to fetch inventory');
      }

      const data = await response.json();
      setInventory(data);
      setError(null);
    } catch (err: any) {
      setError(err.message);
      console.error('Error fetching inventory:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchCooldowns = async () => {
    try {
      const token = localStorage.getItem('auth_token');
      const response = await fetch('/api/inventory/cooldowns', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        throw new Error('Failed to fetch cooldowns');
      }

      const data = await response.json();
      setCooldowns(data.itemCooldowns || []);
    } catch (err) {
      console.error('Error fetching cooldowns:', err);
    }
  };

  const checkAdminStatus = async () => {
    try {
      const isUserAdmin = await authService.isAdmin();
      setIsAdmin(isUserAdmin);
    } catch (err) {
      console.error('Error checking admin status:', err);
      setIsAdmin(false);
    }
  };

  const handleUseItem = async (itemId: number) => {
    try {
      const token = localStorage.getItem('auth_token');
      const response = await fetch(`/api/inventory/use/${itemId}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        const error = await response.json();
        
        // Check if this is a "no active stream" error for interactive items
        if (error.requiresStream && error.message) {
          // Show a user-friendly notification for no stream errors
          if ((window as any).showItemNotification) {
            (window as any).showItemNotification({
              emoji: '⏸️',
              itemName: error.message,
              type: 'error'
            });
          }
          throw new Error(error.message);
        }
        
        throw new Error(error.error || 'Failed to use item');
      }

      const result = await response.json();
      
      // Debug log for cooldown modifier items
      if (result.cooldownEffects) {
        console.log('🛡️⚔️ INVENTORY: Cooldown modifier item used successfully:', result);
      }
      
      // Check if this is a TTS item that needs input
      if (result.ttsMode) {
        const item = inventory.find(item => item.item_id === itemId);
        if (item) {
          setTtsItem(item);
          setTtsModalOpen(true);
        }
        return;
      }
      
      // Don't show any notifications when using items - interactive items have click-to-throw UI
      // and non-interactive items will show notifications via socket events
      console.log('🔇 INVENTORY: Skipping immediate use notification for item:', inventory.find(item => item.item_id === itemId)?.display_name);
      
      // Update local inventory - only if item was actually consumed
      if (!result.interactiveMode && !result.ttsMode) {
        setInventory(prev => prev.map(item => 
          item.item_id === itemId 
            ? { ...item, quantity: result.remainingQuantity }
            : item
        ).filter(item => item.quantity > 0));
      }

      // Add cooldown if applicable
      if (result.item.cooldown) {
        setCooldowns(prev => [
          ...prev.filter(cd => cd.itemId !== itemId),
          {
            itemId: result.item.id,
            name: result.item.name,
            displayName: result.item.displayName,
            emoji: result.item.emoji,
            cooldownRemaining: result.item.cooldown,
            cooldownEnd: Date.now() + (result.item.cooldown * 1000)
          }
        ]);
      }

      setError(null);
    } catch (err: any) {
      setError(err.message);
      console.error('Error using item:', err);
    }
  };

  const handleTTSSubmit = async (text: string, voiceId: string) => {
    if (!ttsItem) return;

    try {
      const token = localStorage.getItem('auth_token');
      const response = await fetch('/api/soundfx/item/tts', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          itemId: ttsItem.item_id,
          text,
          voiceId
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to send TTS');
      }

      const result = await response.json();
      
      // Update inventory
      setInventory(prev => prev.map(item => 
        item.item_id === ttsItem.item_id 
          ? { ...item, quantity: result.remainingQuantity }
          : item
      ).filter(item => item.quantity > 0));

      // Add cooldown
      if (result.item.cooldown) {
        setCooldowns(prev => [
          ...prev.filter(cd => cd.itemId !== ttsItem.item_id),
          {
            itemId: result.item.id,
            name: result.item.name,
            displayName: result.item.displayName,
            emoji: result.item.emoji,
            cooldownRemaining: result.item.cooldown,
            cooldownEnd: Date.now() + (result.item.cooldown * 1000)
          }
        ]);
      }

      // Show success notification
      if ((window as any).showItemNotification) {
        (window as any).showItemNotification({
          emoji: ttsItem.emoji,
          itemName: `${ttsItem.display_name}: "${text}"`,
          type: 'success'
        });
      }

      setTtsModalOpen(false);
      setTtsItem(null);
    } catch (err: any) {
      console.error('Error sending TTS:', err);
      throw err;
    }
  };

  const handleResetCooldowns = async () => {
    try {
      const token = localStorage.getItem('auth_token');
      const response = await fetch('/api/admin/cooldowns/reset', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to reset cooldowns');
      }

      const result = await response.json();
      
      // Clear local cooldowns state
      setCooldowns([]);
      
      // Show success notification
      if ((window as any).showItemNotification) {
        (window as any).showItemNotification({
          emoji: '⏰',
          itemName: `Reset ${result.itemsAffected} item cooldowns!`,
          type: 'success'
        });
      }
      
      setError(null);
    } catch (err: any) {
      setError(err.message);
      console.error('Error resetting cooldowns:', err);
    }
  };

  // Reset to page 1 when inventory tab changes
  useEffect(() => {
    setCurrentInventoryPage(1);
  }, [inventorySubTab]);

  const filteredInventory = inventorySubTab === 'all' 
    ? inventory 
    : inventory.filter(item => item.item_type === inventorySubTab);

  const getPaginatedInventory = () => {
    const startIndex = (currentInventoryPage - 1) * inventoryItemsPerPage;
    const endIndex = startIndex + inventoryItemsPerPage;
    return filteredInventory.slice(startIndex, endIndex);
  };

  const getInventoryTotalPages = () => {
    return Math.ceil(filteredInventory.length / inventoryItemsPerPage);
  };

  const paginatedInventory = getPaginatedInventory();
  const inventoryTotalPages = getInventoryTotalPages();

  const getCooldownForItem = (itemId: number) => {
    const cooldown = cooldowns.find(cd => cd.itemId === itemId);
    return cooldown ? cooldown.cooldownRemaining : 0;
  };

  // Always show the inventory panel, but adjust content based on authentication

  return (
    <>
      {!isOpen && (
        <button 
          className="inventory-toggle-btn"
          onClick={onToggle}
          title="Open Inventory (B)"
        >
          🎒
        </button>
      )}

      <div className={`inventory-panel ${isOpen ? 'open' : ''}`}>
        <div className="inventory-header">
          <h2>Inventory</h2>
          <button 
            className="inventory-close-btn"
            onClick={onToggle}
          >
            ×
          </button>
        </div>

        <div className="inventory-main-tabs">
          <button 
            className="inventory-main-tab active"
          >
            🎒 Inventory
          </button>
          <button 
            className="inventory-main-tab shop-toggle"
            onClick={onToggleShop}
            title="Open Shop"
          >
            🛒 Shop
          </button>
        </div>

        <>
            <div className="inventory-tabs">
              <button 
                className={`inventory-tab ${inventorySubTab === 'all' ? 'active' : ''}`}
                onClick={() => setInventorySubTab('all')}
              >
                All
              </button>
              <button 
                className={`inventory-tab ${inventorySubTab === 'buff' ? 'active' : ''}`}
                onClick={() => setInventorySubTab('buff')}
              >
                Buff
              </button>
              <button 
                className={`inventory-tab ${inventorySubTab === 'debuff' ? 'active' : ''}`}
                onClick={() => setInventorySubTab('debuff')}
              >
                Debuff
              </button>
              <button 
                className={`inventory-tab ${inventorySubTab === 'utility' ? 'active' : ''}`}
                onClick={() => setInventorySubTab('utility')}
              >
                Utility
              </button>
              <button 
                className={`inventory-tab ${inventorySubTab === 'guard' ? 'active' : ''}`}
                onClick={() => setInventorySubTab('guard')}
                title="Items that protect the current streamer by increasing cooldowns"
              >
                <span>🛡️</span>
                <span>Guard</span>
              </button>
              <button 
                className={`inventory-tab ${inventorySubTab === 'weapon' ? 'active' : ''}`}
                onClick={() => setInventorySubTab('weapon')}
                title="Items that help other viewers by reducing cooldowns"
              >
                <span>⚔️</span>
                <span>Weapon</span>
              </button>
              <button 
                className={`inventory-tab ${inventorySubTab === 'marker' ? 'active' : ''}`}
                onClick={() => setInventorySubTab('marker')}
                title="Markers for highlighting moments"
              >
                <span>📍</span>
                <span>Marker</span>
              </button>
              {isAdmin && (
                <button 
                  className="inventory-admin-button"
                  onClick={handleResetCooldowns}
                  title="Reset all personal item cooldowns (Admin Only)"
                >
                  ⏰ Reset Cooldowns
                </button>
              )}
            </div>

            {!isAuthenticated ? (
              <div className="inventory-guest-prompt">
                <div className="guest-prompt-content">
                  <h4>🎒 Your Personal Inventory</h4>
                  <p>Store and manage your items here once you join!</p>
                  <div className="guest-actions">
                    <p><strong>Sign up or log in to start collecting items!</strong></p>
                    <div className="auth-buttons">
                      <a href="/login" className="auth-button login-button">
                        Login
                      </a>
                      <a href="/signup" className="auth-button signup-button">
                        Sign Up
                      </a>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <>
                {error && (
                  <div className="inventory-error">
                    {error}
                  </div>
                )}

                {isLoading ? (
                  <div className="inventory-loading">
                    Loading inventory...
                  </div>
                ) : filteredInventory.length === 0 ? (
                  <div className="inventory-empty">
                    {inventorySubTab === 'all' 
                      ? 'Your inventory is empty. Visit the shop to get items!'
                      : `No ${inventorySubTab} items in inventory`
                    }
                  </div>
                ) : (
                  <>
                    <InventoryGrid 
                      items={paginatedInventory}
                      onUseItem={handleUseItem}
                      getCooldown={getCooldownForItem}
                    />
                    
                    {inventoryTotalPages > 1 && (
                      <div className="inventory-pagination">
                        <div className="pagination-info">
                          Showing {((currentInventoryPage - 1) * inventoryItemsPerPage) + 1}-{Math.min(currentInventoryPage * inventoryItemsPerPage, filteredInventory.length)} of {filteredInventory.length} items
                        </div>
                        
                        <div className="pagination-controls">
                          <button 
                            className={`pagination-btn ${currentInventoryPage === 1 ? 'disabled' : ''}`}
                            onClick={() => setCurrentInventoryPage(prev => Math.max(1, prev - 1))}
                            disabled={currentInventoryPage === 1}
                          >
                            ← Previous
                          </button>
                          
                          <div className="pagination-pages">
                            {Array.from({ length: inventoryTotalPages }, (_, i) => i + 1).map(page => (
                              <button
                                key={page}
                                className={`pagination-page ${currentInventoryPage === page ? 'active' : ''}`}
                                onClick={() => setCurrentInventoryPage(page)}
                              >
                                {page}
                              </button>
                            ))}
                          </div>
                          
                          <button 
                            className={`pagination-btn ${currentInventoryPage === inventoryTotalPages ? 'disabled' : ''}`}
                            onClick={() => setCurrentInventoryPage(prev => Math.min(inventoryTotalPages, prev + 1))}
                            disabled={currentInventoryPage === inventoryTotalPages}
                          >
                            Next →
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
        </>
      </div>
      
      {ttsItem && (
        <TTSInputModal
          isOpen={ttsModalOpen}
          onClose={() => {
            setTtsModalOpen(false);
            setTtsItem(null);
          }}
          onSubmit={handleTTSSubmit}
          itemId={ttsItem.item_id}
          itemName={ttsItem.display_name}
          itemEmoji={ttsItem.emoji}
        />
      )}
    </>
  );
};

export default InventoryPanel;