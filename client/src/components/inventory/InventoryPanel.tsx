import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Socket } from 'socket.io-client';
import InventoryGrid from './InventoryGrid';
import authService from '../../services/AuthService';
import TTSInputModal from '../soundfx/TTSInputModal';
import SoundboardInputModal from '../soundfx/SoundboardInputModal';
import SummonBotModal from '../soundfx/SummonBotModal';
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
  category?: string;
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
  onLogin?: () => void;
  onSignup?: () => void;
  hideToggleButton?: boolean;
}

const InventoryPanel: React.FC<InventoryPanelProps> = ({ 
  socket, 
  isAuthenticated, 
  userProfile, 
  isOpen = false, 
  onToggle, 
  onToggleShop,
  onLogin,
  onSignup,
  hideToggleButton = false
}) => {
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [cooldowns, setCooldowns] = useState<ItemCooldown[]>([]);
  const [inventorySubTab, setInventorySubTab] = useState<string>('all');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentInventoryPage, setCurrentInventoryPage] = useState(1);
  const [isAdmin, setIsAdmin] = useState(false);
  const [ttsModalOpen, setTtsModalOpen] = useState(false);
  const [ttsItem, setTtsItem] = useState<InventoryItem | null>(null);
  const [soundboardModalOpen, setSoundboardModalOpen] = useState(false);
  const [soundboardItem, setSoundboardItem] = useState<InventoryItem | null>(null);
  const [summonBotModalOpen, setSummonBotModalOpen] = useState(false);
  const [summonBotItem, setSummonBotItem] = useState<InventoryItem | null>(null);
  const inventoryItemsPerPage = 45; // Show many more items in full height panel

  // Check if mobile - using useMemo to ensure it's available for all hooks
  const isMobile = useMemo(() => {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth <= 768;
  }, []);

  // Swipe gesture handling for mobile with resize
  const panelRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const startYRef = useRef<number>(0);
  const currentYRef = useRef<number>(0);
  const startHeightRef = useRef<number>(40);

  const handleTouchStart = (e: React.TouchEvent) => {
    const target = e.target as HTMLElement;
    const isHeader = target.closest('.inventory-header');
    
    if (isHeader && isOpen) {
      setIsDragging(true);
      startYRef.current = e.touches[0].clientY;
      currentYRef.current = e.touches[0].clientY;
      startHeightRef.current = isExpanded ? 85 : 40;
      
      if (panelRef.current) {
        panelRef.current.style.transition = 'none';
      }
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isDragging) return;

    e.preventDefault(); // Prevent scroll interference
    currentYRef.current = e.touches[0].clientY;
    const distance = currentYRef.current - startYRef.current;

    // Use requestAnimationFrame for smoother updates
    requestAnimationFrame(() => {
      const viewportHeight = window.innerHeight;
      const headerHeight = 56; // Layout header height
      const maxHeightVh = ((viewportHeight - headerHeight) / viewportHeight) * 100; // Max height that won't cover header
      const distanceInVh = (distance / viewportHeight) * 100;
      const newHeight = Math.max(20, Math.min(maxHeightVh, startHeightRef.current - distanceInVh));
      
      if (panelRef.current) {
        panelRef.current.style.height = `${newHeight}vh`;
        
        if (startHeightRef.current === 40 && distance > 100) {
          panelRef.current.style.transform = `translateY(${distance - 100}px)`;
        } else {
          panelRef.current.style.transform = '';
        }
      }
    });
  };

  const handleTouchEnd = () => {
    if (!isDragging) return;

    setIsDragging(false);
    const distance = currentYRef.current - startYRef.current;
    const viewportHeight = window.innerHeight;
    const headerHeight = 56; // Layout header height
    const maxHeightVh = ((viewportHeight - headerHeight) / viewportHeight) * 100; // Max height that won't cover header
    const distanceInVh = (distance / viewportHeight) * 100;
    const currentHeight = startHeightRef.current - distanceInVh;

    if (panelRef.current) {
      panelRef.current.style.transition = 'all 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94)';

      if (startHeightRef.current === 40 && distance > 100) {
        panelRef.current.style.transform = 'translateY(100%)';
        panelRef.current.style.height = '40vh';
        setTimeout(() => {
          if (onToggle) onToggle();
          if (panelRef.current) {
            panelRef.current.style.transform = '';
            setIsExpanded(false);
          }
        }, 300);
      } else if (currentHeight > 60) {
        // Cap at max height that doesn't cover header
        panelRef.current.style.height = `${maxHeightVh}vh`;
        panelRef.current.style.transform = '';
        setIsExpanded(true);
      } else if (currentHeight < 30 && startHeightRef.current >= maxHeightVh - 5) {
        panelRef.current.style.height = '40vh';
        panelRef.current.style.transform = '';
        setIsExpanded(false);
      } else {
        panelRef.current.style.height = isExpanded ? `${maxHeightVh}vh` : '40vh';
        panelRef.current.style.transform = '';
      }
    }
  };

  useEffect(() => {
    if (isOpen && panelRef.current && isMobile) {
      // Only apply initial height and transform on mobile
      panelRef.current.style.transform = 'translateY(0)';
      panelRef.current.style.height = '40vh';
      setIsExpanded(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]); // isMobile won't change during component lifecycle

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
        // console.log('⏰ INVENTORY: Updating cooldown for item:', data.item.displayName, 'cooldown:', data.item.cooldown);
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
        // console.log('🔇 INVENTORY: Skipping notification for interactive item fallback:', data.item);
        return;
      }
      
      // Don't show notifications for items that were thrown (interactive items)
      if (data.thrown) {
        // console.log('🔇 INVENTORY: Skipping notification for thrown interactive item:', data.item?.displayName || data.item?.name);
        return;
      }
      
      // Don't show any notifications - let the individual use handlers manage this
      // console.log('🔇 INVENTORY: Skipping all item-used notifications to prevent duplicates');
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

  // Expose cooldown update function globally for thrown items
  useEffect(() => {
    (window as any).updateItemCooldown = (item: { itemId: number; name: string; displayName: string; emoji: string; cooldown: number }) => {
      // console.log('⏰ INVENTORY: Updating cooldown from throw action:', item.displayName, 'cooldown:', item.cooldown);
      setCooldowns(prev => {
        const newCooldowns = [
          ...prev.filter(cd => cd.itemId !== item.itemId),
          {
            itemId: item.itemId,
            name: item.name,
            displayName: item.displayName,
            emoji: item.emoji,
            cooldownRemaining: item.cooldown,
            cooldownEnd: Date.now() + (item.cooldown * 1000)
          }
        ];
        // console.log('⏰ INVENTORY: Updated cooldowns:', newCooldowns);
        return newCooldowns;
      });
    };

    return () => {
      delete (window as any).updateItemCooldown;
    };
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
      // console.log('📊 Fetched cooldowns from server:', data);
      
      // Transform the cooldowns to include both remaining time and end time
      const transformedCooldowns = (data.itemCooldowns || []).map((cd: any) => ({
        itemId: cd.itemId,
        name: cd.itemName || '',
        displayName: cd.itemName || '',
        emoji: cd.emoji || '',
        cooldownRemaining: cd.cooldownRemaining,
        cooldownEnd: Date.now() + (cd.cooldownRemaining * 1000)
      }));
      
      setCooldowns(transformedCooldowns);
      // console.log('📊 Set cooldowns state:', transformedCooldowns);
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
        // console.log('🛡️⚔️ INVENTORY: Cooldown modifier item used successfully:', result);
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
      
      // Check if this is a soundboard item that needs URL input
      if (result.soundboardMode) {
        const item = inventory.find(item => item.item_id === itemId);
        if (item) {
          setSoundboardItem(item);
          setSoundboardModalOpen(true);
        }
        return;
      }
      
      // Check if this is a summon bot item that needs input
      if (result.summonBotMode) {
        const item = inventory.find(item => item.item_id === itemId);
        if (item) {
          setSummonBotItem(item);
          setSummonBotModalOpen(true);
        }
        return;
      }
      
      // Check if this is an auto-trigger item (like fart)
      if (result.interactionMode === 'auto-trigger') {
        // For auto-trigger items, the server already handled the effect
        // Just update the local inventory
        setInventory(prev => prev.map(item => 
          item.item_id === itemId 
            ? { ...item, quantity: result.remainingQuantity }
            : item
        ).filter(item => item.quantity > 0));
      }
      
      // Don't show any notifications when using items - interactive items have click-to-throw UI
      // and non-interactive items will show notifications via socket events
      // console.log('🔇 INVENTORY: Skipping immediate use notification for item:', inventory.find(item => item.item_id === itemId)?.display_name);
      
      // Update local inventory - only if item was actually consumed
      if (!result.interactiveMode && !result.ttsMode && !result.soundboardMode && result.interactionMode !== 'auto-trigger') {
        setInventory(prev => prev.map(item => 
          item.item_id === itemId 
            ? { ...item, quantity: result.remainingQuantity }
            : item
        ).filter(item => item.quantity > 0));
      }

      // Add cooldown if applicable
      if (result.item.cooldown) {
        // console.log(`🔄 Adding cooldown for item ${itemId}: ${result.item.cooldown}s`);
        setCooldowns(prev => {
          const newCooldowns = [
            ...prev.filter(cd => cd.itemId !== itemId),
            {
              itemId: itemId, // Use the itemId parameter, not result.item.id
              name: result.item.name,
              displayName: result.item.displayName,
              emoji: result.item.emoji,
              cooldownRemaining: result.item.cooldown,
              cooldownEnd: Date.now() + (result.item.cooldown * 1000)
            }
          ];
          // console.log('🔄 Updated cooldowns state after use:', newCooldowns);
          return newCooldowns;
        });
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
        // console.log(`🔄 Adding TTS cooldown for item ${ttsItem.item_id}: ${result.item.cooldown}s`);
        setCooldowns(prev => {
          const newCooldowns = [
            ...prev.filter(cd => cd.itemId !== ttsItem.item_id),
            {
              itemId: ttsItem.item_id, // Use the correct item ID
              name: result.item.name,
              displayName: result.item.displayName,
              emoji: result.item.emoji,
              cooldownRemaining: result.item.cooldown,
              cooldownEnd: Date.now() + (result.item.cooldown * 1000)
            }
          ];
          // console.log('🔄 Updated cooldowns state after TTS use:', newCooldowns);
          return newCooldowns;
        });
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

  const filteredInventory = isMobile || inventorySubTab === 'all' 
    ? inventory 
    : inventory.filter(item => item.category === inventorySubTab);

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

  const handleSoundboardSubmit = async (soundUrl: string) => {
    if (!soundboardItem) return;

    try {
      const token = localStorage.getItem('auth_token');
      const response = await fetch('/api/soundfx/item/soundboard', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          itemId: soundboardItem.item_id,
          soundUrl
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to play soundboard');
      }

      const result = await response.json();
      
      // Update inventory
      setInventory(prev => prev.map(item => 
        item.item_id === soundboardItem.item_id 
          ? { ...item, quantity: result.remainingQuantity }
          : item
      ).filter(item => item.quantity > 0));

      // Add cooldown
      if (result.item.cooldown) {
        setCooldowns(prev => {
          const newCooldowns = [
            ...prev.filter(cd => cd.itemId !== soundboardItem.item_id),
            {
              itemId: soundboardItem.item_id,
              name: result.item.name,
              displayName: result.item.displayName,
              emoji: result.item.emoji,
              cooldownRemaining: result.item.cooldown,
              cooldownEnd: Date.now() + (result.item.cooldown * 1000)
            }
          ];
          return newCooldowns;
        });
      }

      setError(null);
    } catch (err: any) {
      setError(err.message);
      throw err; // Re-throw to notify modal
    }
  };

  const handleSummonBotSubmit = async (botName: string, personalityPrompt: string) => {
    if (!summonBotItem) return;

    try {
      const token = localStorage.getItem('auth_token');
      const response = await fetch(`/api/inventory/summon-bot/${summonBotItem.item_id}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          botName,
          personalityPrompt
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to summon bot');
      }

      const result = await response.json();
      
      // Update inventory
      setInventory(prev => prev.map(item => 
        item.item_id === summonBotItem.item_id 
          ? { ...item, quantity: result.remainingQuantity }
          : item
      ).filter(item => item.quantity > 0));

      // Add cooldown
      if (summonBotItem) {
        setCooldowns(prev => {
          const newCooldowns = [
            ...prev.filter(cd => cd.itemId !== summonBotItem.item_id),
            {
              itemId: summonBotItem.item_id,
              name: summonBotItem.name,
              displayName: summonBotItem.display_name,
              emoji: summonBotItem.emoji,
              cooldownRemaining: 3600, // 1 hour cooldown
              cooldownEnd: Date.now() + (3600 * 1000)
            }
          ];
          return newCooldowns;
        });
      }

      // Show success notification
      if ((window as any).showItemNotification) {
        (window as any).showItemNotification({
          emoji: '🤖',
          itemName: `Bot "${botName}" summoned!`,
          type: 'success'
        });
      }

      setSummonBotModalOpen(false);
      setSummonBotItem(null);
      setError(null);
    } catch (err: any) {
      setError(err.message);
      console.error('Error summoning bot:', err);
      throw err; // Re-throw to notify modal
    }
  };

  const getCooldownForItem = (itemId: number) => {
    const cooldown = cooldowns.find(cd => cd.itemId === itemId);
    const remaining = cooldown ? cooldown.cooldownRemaining : 0;
    if (remaining > 0) {
      // console.log(`⏰ Getting cooldown for item ${itemId}: ${remaining}s`);
    }
    return remaining;
  };

  // Always show the inventory panel, but adjust content based on authentication

  return (
    <>
      {/* Hide floating button on mobile since we have bottom nav, and in theatre mode */}
      {!isOpen && !isMobile && !hideToggleButton && (
        <button
          className="inventory-toggle-btn"
          onClick={onToggle}
          title="Open Backpack (B)"
        >
          🎒
        </button>
      )}

      <div 
        ref={panelRef}
        className={`inventory-panel ${isOpen ? 'open' : ''} ${isExpanded ? 'expanded' : ''} ${isMobile ? 'mobile' : 'desktop'}`}
        onTouchStart={isMobile ? handleTouchStart : undefined}
        onTouchMove={isMobile ? handleTouchMove : undefined}
        onTouchEnd={isMobile ? handleTouchEnd : undefined}
      >
        <div className="inventory-header">
          <h2>Backpack</h2>
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
            🎒 Backpack
          </button>
          <button 
            className="inventory-main-tab shop-toggle"
            onClick={onToggleShop}
            title="Open Shop"
          >
            🛒 Shop
          </button>
        </div>

        {!isMobile && (
          <div className="inventory-tabs">
            <button 
              className={`inventory-tab ${inventorySubTab === 'all' ? 'active' : ''}`}
              onClick={() => setInventorySubTab('all')}
            >
              All
            </button>
            <button 
              className={`inventory-tab ${inventorySubTab === 'sound_effects' ? 'active' : ''}`}
              onClick={() => setInventorySubTab('sound_effects')}
            >
              Sound FX
            </button>
            <button 
              className={`inventory-tab ${inventorySubTab === 'visual_effects' ? 'active' : ''}`}
              onClick={() => setInventorySubTab('visual_effects')}
            >
              Visual FX
            </button>
            <button 
              className={`inventory-tab ${inventorySubTab === 'utility' ? 'active' : ''}`}
              onClick={() => setInventorySubTab('utility')}
            >
              Utility
            </button>
            <button 
              className={`inventory-tab ${inventorySubTab === 'powerups' ? 'active' : ''}`}
              onClick={() => setInventorySubTab('powerups')}
            >
              <span>⚡</span>
              <span>Power-ups</span>
            </button>
            <button 
              className={`inventory-tab ${inventorySubTab === 'protection' ? 'active' : ''}`}
              onClick={() => setInventorySubTab('protection')}
            >
              <span>🛡️</span>
              <span>Protection</span>
            </button>
            <button 
              className={`inventory-tab ${inventorySubTab === 'combat' ? 'active' : ''}`}
              onClick={() => setInventorySubTab('combat')}
            >
              <span>⚔️</span>
              <span>Combat</span>
            </button>
            <button 
              className={`inventory-tab ${inventorySubTab === 'drawing_tools' ? 'active' : ''}`}
              onClick={() => setInventorySubTab('drawing_tools')}
            >
              <span>🎨</span>
              <span>Drawing</span>
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
        )}

        <div className="inventory-content">
          {!isAuthenticated ? (
              <div className="inventory-guest-prompt-v2">
                <div className="guest-icon-header">
                  <div className="locked-icon">🔒</div>
                  <h3>Inventory Locked</h3>
                </div>
                
                <div className="guest-benefits">
                  <div className="benefit-item">
                    <span className="benefit-icon">💎</span>
                    <span>Collect rare items</span>
                  </div>
                  <div className="benefit-item">
                    <span className="benefit-icon">⚡</span>
                    <span>Use powerful buffs</span>
                  </div>
                  <div className="benefit-item">
                    <span className="benefit-icon">🎯</span>
                    <span>Throw effects on stream</span>
                  </div>
                </div>

                <div className="auth-cta-section">
                  <button 
                    className="inventory-login-btn"
                    onClick={(e) => {
                      e.preventDefault();
                      if (onLogin) onLogin();
                    }}
                  >
                    Sign In
                  </button>
                  <div className="divider-text">or</div>
                  <button 
                    className="inventory-signup-btn"
                    onClick={(e) => {
                      e.preventDefault();
                      if (onSignup) onSignup();
                    }}
                  >
                    <span className="signup-text">Create Free Account</span>
                    <span className="signup-bonus">🎁 Get starter items!</span>
                  </button>
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
        </div>
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
      
      {soundboardItem && (
        <SoundboardInputModal
          isOpen={soundboardModalOpen}
          onClose={() => {
            setSoundboardModalOpen(false);
            setSoundboardItem(null);
          }}
          onSubmit={handleSoundboardSubmit}
          itemId={soundboardItem.item_id}
          itemName={soundboardItem.display_name}
          itemEmoji={soundboardItem.emoji}
        />
      )}
      
      {summonBotItem && (
        <SummonBotModal
          isOpen={summonBotModalOpen}
          onClose={() => {
            setSummonBotModalOpen(false);
            setSummonBotItem(null);
          }}
          onSubmit={handleSummonBotSubmit}
          itemName={summonBotItem.display_name}
          itemEmoji={summonBotItem.emoji}
        />
      )}
    </>
  );
};

export default InventoryPanel;