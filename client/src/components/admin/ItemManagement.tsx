import React, { useState } from 'react';
import authService from '../../services/AuthService';
import './ItemManagement.css';
import { Item, ShopItemData, NewItemForm } from './itemManagement/types';
import { useItemManagementData } from './itemManagement/useItemManagementData';
import ItemsView from './itemManagement/ItemsView';
import ShopView from './itemManagement/ShopView';
import CreateItemForm from './itemManagement/CreateItemForm';

interface ItemManagementProps {
  addLog: (message: string) => void;
}

const ItemManagement: React.FC<ItemManagementProps> = ({ addLog }) => {
  const [activeView, setActiveView] = useState<'items' | 'shop' | 'create'>('items');
  const [editingItems, setEditingItems] = useState<Set<number>>(new Set());
  const [editedValues, setEditedValues] = useState<{[key: number]: Partial<Item>}>({});

  const {
    items,
    setItems,
    shopItems,
    isLoading,
    error,
    setError,
    fetchItems,
    fetchShopItems,
  } = useItemManagementData(addLog);

  // Create item form state
  const [newItem, setNewItem] = useState<NewItemForm>({
    name: '',
    display_name: '',
    emoji: '',
    description: '',
    item_type: 'utility',
    category: 'misc',
    rarity: 'common',
    base_price: 100,
    cooldown_seconds: 0,
    duration_seconds: 0,
    max_stack: 0
  });

  const handleCreateItem = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const token = authService.getToken();
      const response = await fetch('/api/admin/items', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(newItem)
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to create item: ${response.status} ${response.statusText}`);
      }

      const createdItem = await response.json();
      setItems([...items, createdItem]);
      setNewItem({
        name: '',
        display_name: '',
        emoji: '',
        description: '',
        item_type: 'utility',
        category: 'misc',
        rarity: 'common',
        base_price: 100,
        cooldown_seconds: 0,
        duration_seconds: 0,
        max_stack: 0
      });
      setActiveView('items');
      addLog(`Item "${createdItem.display_name}" created successfully`);
    } catch (err: any) {
      setError(err.message);
      addLog(`Error creating item: ${err.message}`);
    }
  };

  const handleAddToShop = async (itemId: number, price: number, stock: number) => {
    try {
      const token = authService.getToken();
      const response = await fetch('/api/admin/shop', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          item_id: itemId,
          price,
          stock_limit: stock,
          is_featured: false,
          discount_percentage: 0
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to add item to shop: ${response.status} ${response.statusText}`);
      }

      fetchShopItems();
      addLog('Item added to shop successfully');
    } catch (err: any) {
      setError(err.message);
      addLog(`Error adding item to shop: ${err.message}`);
    }
  };

  const handleUpdateShopItem = async (shopItemId: number, updates: Partial<ShopItemData>) => {
    try {
      const token = authService.getToken();
      const response = await fetch(`/api/admin/shop/${shopItemId}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(updates)
      });

      if (!response.ok) {
        throw new Error('Failed to update shop item');
      }

      fetchShopItems();
      addLog('Shop item updated successfully');
    } catch (err: any) {
      setError(err.message);
      addLog(`Error updating shop item: ${err.message}`);
    }
  };

  const handleRemoveFromShop = async (shopItemId: number) => {
    try {
      const token = authService.getToken();
      const response = await fetch(`/api/admin/shop/${shopItemId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        throw new Error('Failed to remove item from shop');
      }

      fetchShopItems();
      addLog('Item removed from shop successfully');
    } catch (err: any) {
      setError(err.message);
      addLog(`Error removing item from shop: ${err.message}`);
    }
  };

  const handleEditItem = (itemId: number) => {
    const newEditingItems = new Set(editingItems);
    newEditingItems.add(itemId);
    setEditingItems(newEditingItems);

    const item = items.find(i => i.id === itemId);
    if (item) {
      setEditedValues({
        ...editedValues,
        [itemId]: { ...item }
      });
    }
  };

  const handleCancelEdit = (itemId: number) => {
    const newEditingItems = new Set(editingItems);
    newEditingItems.delete(itemId);
    setEditingItems(newEditingItems);

    const newEditedValues = { ...editedValues };
    delete newEditedValues[itemId];
    setEditedValues(newEditedValues);
  };

  const handleSaveItem = async (itemId: number) => {
    try {
      const token = authService.getToken();
      const updates = editedValues[itemId];

      if (!updates) return;

      const response = await fetch(`/api/admin/items/${itemId}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(updates)
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to update item: ${response.status}`);
      }

      const updatedItem = await response.json();
      setItems(items.map(item => item.id === itemId ? updatedItem : item));
      handleCancelEdit(itemId);
      addLog(`Item "${updatedItem.display_name}" updated successfully`);
    } catch (err: any) {
      setError(err.message);
      addLog(`Error updating item: ${err.message}`);
    }
  };

  const handleDeleteItem = async (itemId: number) => {
    if (!window.confirm('Are you sure you want to delete this item? This action cannot be undone.')) {
      return;
    }

    try {
      const token = authService.getToken();
      const response = await fetch(`/api/admin/items/${itemId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to delete item: ${response.status}`);
      }

      setItems(items.filter(item => item.id !== itemId));
      addLog('Item deleted successfully');
    } catch (err: any) {
      setError(err.message);
      addLog(`Error deleting item: ${err.message}`);
    }
  };

  const handleFieldChange = (itemId: number, field: keyof Item, value: any) => {
    setEditedValues({
      ...editedValues,
      [itemId]: {
        ...editedValues[itemId],
        [field]: value
      }
    });
  };

  return (
    <div className="item-management">
      <div className="item-management-header">
        <h3>🛍️ Item & Shop Management</h3>
        <div className="view-tabs">
          <button
            className={`view-tab ${activeView === 'items' ? 'active' : ''}`}
            onClick={() => setActiveView('items')}
          >
            📦 Items
          </button>
          <button
            className={`view-tab ${activeView === 'shop' ? 'active' : ''}`}
            onClick={() => setActiveView('shop')}
          >
            🛒 Shop
          </button>
          <button
            className={`view-tab ${activeView === 'create' ? 'active' : ''}`}
            onClick={() => setActiveView('create')}
          >
            ➕ Create Item
          </button>
        </div>
      </div>

      {error && (
        <div className="error-message">
          {error}
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      <div className="item-management-content">
        {activeView === 'items' && (
          <ItemsView
            items={items}
            isLoading={isLoading}
            onRefresh={fetchItems}
            editingItems={editingItems}
            editedValues={editedValues}
            onEditItem={handleEditItem}
            onCancelEdit={handleCancelEdit}
            onSaveItem={handleSaveItem}
            onDeleteItem={handleDeleteItem}
            onAddToShop={handleAddToShop}
            onFieldChange={handleFieldChange}
          />
        )}

        {activeView === 'shop' && (
          <ShopView
            shopItems={shopItems}
            onRefresh={fetchShopItems}
            onUpdateShopItem={handleUpdateShopItem}
            onRemoveFromShop={handleRemoveFromShop}
          />
        )}

        {activeView === 'create' && (
          <CreateItemForm
            newItem={newItem}
            setNewItem={setNewItem}
            onSubmit={handleCreateItem}
            onCancel={() => setActiveView('items')}
          />
        )}
      </div>
    </div>
  );
};

export default ItemManagement;
