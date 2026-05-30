import { useState, useEffect, useCallback } from 'react';
import authService from '../../../services/AuthService';
import { EditableItem, ShopItemData } from './types';

interface UseItemManagementData {
  items: EditableItem[];
  setItems: React.Dispatch<React.SetStateAction<EditableItem[]>>;
  shopItems: ShopItemData[];
  setShopItems: React.Dispatch<React.SetStateAction<ShopItemData[]>>;
  isLoading: boolean;
  setIsLoading: React.Dispatch<React.SetStateAction<boolean>>;
  error: string | null;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  fetchItems: () => Promise<void>;
  fetchShopItems: () => Promise<void>;
}

// Owns the items/shop data plus its loading/error state. The data is loaded via
// the authenticated /api/admin/* endpoints (token from authService.getToken()),
// exactly as the original component did.
export function useItemManagementData(
  addLog: (message: string) => void
): UseItemManagementData {
  const [items, setItems] = useState<EditableItem[]>([]);
  const [shopItems, setShopItems] = useState<ShopItemData[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchItems = useCallback(async () => {
    try {
      setIsLoading(true);
      const token = authService.getToken();
      const response = await fetch('/api/admin/items', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to fetch items: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      setItems(data);
      addLog('Items fetched successfully');
    } catch (err: any) {
      setError(err.message);
      addLog(`Error fetching items: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  }, [addLog]);

  const fetchShopItems = useCallback(async () => {
    try {
      const token = authService.getToken();
      const response = await fetch('/api/admin/shop', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to fetch shop items: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      setShopItems(data);
      addLog('Shop items fetched successfully');
    } catch (err: any) {
      addLog(`Error fetching shop items: ${err.message}`);
    }
  }, [addLog]);

  useEffect(() => {
    fetchItems();
    fetchShopItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    items,
    setItems,
    shopItems,
    setShopItems,
    isLoading,
    setIsLoading,
    error,
    setError,
    fetchItems,
    fetchShopItems,
  };
}
