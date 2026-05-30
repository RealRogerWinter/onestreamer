import { useState, useEffect } from 'react';
import { Socket } from 'socket.io-client';
import authService from '../../../services/AuthService';
import { InventoryItem, ItemCooldown } from './types';

interface UseInventoryArgs {
  socket: Socket | null;
  isAuthenticated: boolean;
  isOpen: boolean;
}

/**
 * Data + behavior hook for InventoryPanel. Owns inventory/cooldown state,
 * the authenticated fetches (global fetch() + localStorage auth_token), the
 * use/TTS/soundboard/summon handlers, the per-second cooldown ticker, socket
 * wiring and the global updateItemCooldown bridge. Behavior is preserved
 * verbatim from the original component.
 */
export function useInventory({ socket, isAuthenticated, isOpen }: UseInventoryArgs) {
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [cooldowns, setCooldowns] = useState<ItemCooldown[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [ttsModalOpen, setTtsModalOpen] = useState(false);
  const [ttsItem, setTtsItem] = useState<InventoryItem | null>(null);
  const [soundboardModalOpen, setSoundboardModalOpen] = useState(false);
  const [soundboardItem, setSoundboardItem] = useState<InventoryItem | null>(null);
  const [summonBotModalOpen, setSummonBotModalOpen] = useState(false);
  const [summonBotItem, setSummonBotItem] = useState<InventoryItem | null>(null);

  useEffect(() => {
    if (isAuthenticated && isOpen) {
      fetchInventory();
      fetchCooldowns();
      checkAdminStatus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  return {
    inventory,
    cooldowns,
    isLoading,
    error,
    isAdmin,
    ttsModalOpen,
    ttsItem,
    setTtsModalOpen,
    setTtsItem,
    soundboardModalOpen,
    soundboardItem,
    setSoundboardModalOpen,
    setSoundboardItem,
    summonBotModalOpen,
    summonBotItem,
    setSummonBotModalOpen,
    setSummonBotItem,
    handleUseItem,
    handleTTSSubmit,
    handleResetCooldowns,
    handleSoundboardSubmit,
    handleSummonBotSubmit,
    getCooldownForItem,
  };
}
