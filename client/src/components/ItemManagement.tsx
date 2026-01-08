import React, { useState, useEffect } from 'react';
import authService from '../services/AuthService';
import './ItemManagement.css';

interface Item {
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

interface ShopItemData {
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

interface ItemManagementProps {
  addLog: (message: string) => void;
}

interface EditableItem extends Item {
  isEditing?: boolean;
}

const ItemManagement: React.FC<ItemManagementProps> = ({ addLog }) => {
  const [activeView, setActiveView] = useState<'items' | 'shop' | 'create'>('items');
  const [items, setItems] = useState<EditableItem[]>([]);
  const [shopItems, setShopItems] = useState<ShopItemData[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingItems, setEditingItems] = useState<Set<number>>(new Set());
  const [editedValues, setEditedValues] = useState<{[key: number]: Partial<Item>}>({});
  
  // Search and filter states
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'buff' | 'debuff' | 'utility'>('all');
  const [filterRarity, setFilterRarity] = useState<'all' | 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary'>('all');
  const [sortBy, setSortBy] = useState<'name' | 'type' | 'rarity' | 'cooldown' | 'created'>('name');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  // Create item form state
  const [newItem, setNewItem] = useState({
    name: '',
    display_name: '',
    emoji: '',
    description: '',
    item_type: 'utility' as 'buff' | 'debuff' | 'utility',
    category: 'misc',
    rarity: 'common' as 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary',
    base_price: 100,
    cooldown_seconds: 0,
    duration_seconds: 0,
    max_stack: 0
  });

  useEffect(() => {
    fetchItems();
    fetchShopItems();
  }, []);

  const fetchItems = async () => {
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
  };

  const fetchShopItems = async () => {
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
  };

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

  const getRarityColor = (rarity: string) => {
    switch (rarity) {
      case 'common': return '#9d9d9d';
      case 'uncommon': return '#1eff00';
      case 'rare': return '#0070dd';
      case 'epic': return '#a335ee';
      case 'legendary': return '#ff8000';
      default: return '#9d9d9d';
    }
  };

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'buff': return '⚡';
      case 'debuff': return '🔥';
      case 'utility': return '🔧';
      default: return '📦';
    }
  };

  // Filter and sort items
  const getFilteredAndSortedItems = () => {
    let filtered = [...items];
    
    // Apply search filter
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter(item => 
        item.name.toLowerCase().includes(term) ||
        item.display_name.toLowerCase().includes(term) ||
        item.description.toLowerCase().includes(term)
      );
    }
    
    // Apply type filter
    if (filterType !== 'all') {
      filtered = filtered.filter(item => item.item_type === filterType);
    }
    
    // Apply rarity filter
    if (filterRarity !== 'all') {
      filtered = filtered.filter(item => item.rarity === filterRarity);
    }
    
    // Apply sorting
    filtered.sort((a, b) => {
      let comparison = 0;
      
      switch (sortBy) {
        case 'name':
          comparison = a.display_name.localeCompare(b.display_name);
          break;
        case 'type':
          comparison = a.item_type.localeCompare(b.item_type);
          break;
        case 'rarity':
          const rarityOrder = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
          comparison = rarityOrder.indexOf(a.rarity) - rarityOrder.indexOf(b.rarity);
          break;
        case 'cooldown':
          comparison = a.cooldown_seconds - b.cooldown_seconds;
          break;
        case 'created':
          comparison = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
          break;
      }
      
      return sortOrder === 'asc' ? comparison : -comparison;
    });
    
    return filtered;
  };
  
  const clearFilters = () => {
    setSearchTerm('');
    setFilterType('all');
    setFilterRarity('all');
    setSortBy('name');
    setSortOrder('asc');
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
          <div className="items-view">
            <div className="section-header">
              <h4>All Items ({getFilteredAndSortedItems().length} of {items.length})</h4>
              <button onClick={fetchItems} className="refresh-btn">
                🔄 Refresh
              </button>
            </div>
            
            {/* Search and Filter Controls */}
            <div className="items-controls">
              <div className="search-bar">
                <input
                  type="text"
                  placeholder="🔍 Search items by name or description..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="search-input"
                />
                {searchTerm && (
                  <div className="active-filters-indicator">
                    Searching for: <strong>"{searchTerm}"</strong>
                  </div>
                )}
              </div>
              
              <div className="filter-controls">
                <div className="filter-group">
                  <label>Type:</label>
                  <select 
                    value={filterType} 
                    onChange={(e) => setFilterType(e.target.value as any)}
                    className="filter-select"
                  >
                    <option value="all">All Types</option>
                    <option value="buff">⚡ Buff</option>
                    <option value="debuff">🔥 Debuff</option>
                    <option value="utility">🔧 Utility</option>
                  </select>
                </div>
                
                <div className="filter-group">
                  <label>Rarity:</label>
                  <select 
                    value={filterRarity} 
                    onChange={(e) => setFilterRarity(e.target.value as any)}
                    className="filter-select"
                  >
                    <option value="all">All Rarities</option>
                    <option value="common" style={{ color: getRarityColor('common') }}>Common</option>
                    <option value="uncommon" style={{ color: getRarityColor('uncommon') }}>Uncommon</option>
                    <option value="rare" style={{ color: getRarityColor('rare') }}>Rare</option>
                    <option value="epic" style={{ color: getRarityColor('epic') }}>Epic</option>
                    <option value="legendary" style={{ color: getRarityColor('legendary') }}>Legendary</option>
                  </select>
                </div>
                
                <div className="filter-group">
                  <label>Sort by:</label>
                  <select 
                    value={sortBy} 
                    onChange={(e) => setSortBy(e.target.value as any)}
                    className="filter-select"
                  >
                    <option value="name">Name</option>
                    <option value="type">Type</option>
                    <option value="rarity">Rarity</option>
                    <option value="cooldown">Cooldown</option>
                    <option value="created">Date Created</option>
                  </select>
                </div>
                
                <div className="filter-group">
                  <button 
                    onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
                    className="sort-order-btn"
                    title={sortOrder === 'asc' ? 'Sort Ascending' : 'Sort Descending'}
                  >
                    {sortOrder === 'asc' ? '↑' : '↓'}
                  </button>
                </div>
                
                <div className="filter-group">
                  <button onClick={clearFilters} className="clear-filters-btn">
                    ✖ Clear
                  </button>
                </div>
              </div>
            </div>
            
            {isLoading ? (
              <div className="loading">Loading items...</div>
            ) : getFilteredAndSortedItems().length === 0 ? (
              <div className="no-items-message">
                <div className="no-items-icon">🔍</div>
                <h3>No items found</h3>
                <p>Try adjusting your search or filters</p>
                <button onClick={clearFilters} className="clear-filters-btn">
                  Clear all filters
                </button>
              </div>
            ) : (
              <div className="items-grid">
                {getFilteredAndSortedItems().map((item) => {
                  const isEditing = editingItems.has(item.id);
                  const editValues = editedValues[item.id] || item;
                  
                  return (
                    <div key={item.id} className="item-card">
                      <div className="item-header">
                        {isEditing ? (
                          <input
                            type="text"
                            value={editValues.emoji}
                            onChange={(e) => handleFieldChange(item.id, 'emoji', e.target.value)}
                            className="emoji-input"
                            maxLength={2}
                            style={{ width: '50px', fontSize: '24px', textAlign: 'center' }}
                          />
                        ) : (
                          <span className="item-emoji">{item.emoji}</span>
                        )}
                        <div className="item-info">
                          {isEditing ? (
                            <>
                              <input
                                type="text"
                                value={editValues.display_name}
                                onChange={(e) => handleFieldChange(item.id, 'display_name', e.target.value)}
                                className="name-input"
                                style={{ color: getRarityColor(editValues.rarity || 'common'), fontWeight: 'bold' }}
                              />
                              <div className="item-meta">
                                <select
                                  value={editValues.item_type}
                                  onChange={(e) => handleFieldChange(item.id, 'item_type', e.target.value)}
                                  className="type-select"
                                >
                                  <option value="buff">⚡ Buff</option>
                                  <option value="debuff">🔥 Debuff</option>
                                  <option value="utility">🔧 Utility</option>
                                </select>
                                <select
                                  value={editValues.category || 'misc'}
                                  onChange={(e) => handleFieldChange(item.id, 'category', e.target.value)}
                                  className="category-select"
                                  title="Shop category"
                                >
                                  <option value="utility">Utility</option>
                                  <option value="powerups">Powerups</option>
                                  <option value="debuffs">Debuffs</option>
                                  <option value="visual_effects">Visual Effects</option>
                                  <option value="sound_effects">Sound Effects</option>
                                  <option value="drawing_tools">Drawing Tools</option>
                                  <option value="protection">Protection</option>
                                  <option value="combat">Combat</option>
                                  <option value="general">General</option>
                                  <option value="misc">Misc</option>
                                </select>
                                <select
                                  value={editValues.rarity}
                                  onChange={(e) => handleFieldChange(item.id, 'rarity', e.target.value)}
                                  className="rarity-select"
                                  style={{ color: getRarityColor(editValues.rarity || 'common') }}
                                >
                                  <option value="common">Common</option>
                                  <option value="uncommon">Uncommon</option>
                                  <option value="rare">Rare</option>
                                  <option value="epic">Epic</option>
                                  <option value="legendary">Legendary</option>
                                </select>
                              </div>
                            </>
                          ) : (
                            <>
                              <h5 style={{ color: getRarityColor(item.rarity) }}>
                                {item.display_name}
                              </h5>
                              <div className="item-meta">
                                <span className="item-type">
                                  {getTypeIcon(item.item_type)} {item.item_type}
                                </span>
                                <span className="item-category" title="Shop category">
                                  📁 {item.category || 'misc'}
                                </span>
                                <span className="item-rarity" style={{ color: getRarityColor(item.rarity) }}>
                                  {item.rarity}
                                </span>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                      
                      <div className="item-description">
                        {isEditing ? (
                          <textarea
                            value={editValues.description}
                            onChange={(e) => handleFieldChange(item.id, 'description', e.target.value)}
                            className="description-input"
                            rows={3}
                            style={{ width: '100%', resize: 'vertical' }}
                          />
                        ) : (
                          item.description
                        )}
                      </div>
                      
                      <div className="item-stats">
                        <div className="stat">
                          <span>Cooldown:</span>
                          {isEditing ? (
                            <input
                              type="number"
                              value={editValues.cooldown_seconds}
                              onChange={(e) => handleFieldChange(item.id, 'cooldown_seconds', parseInt(e.target.value) || 0)}
                              min="0"
                              style={{ width: '60px' }}
                            />
                          ) : (
                            <span>{item.cooldown_seconds}s</span>
                          )}
                        </div>
                        <div className="stat">
                          <span>Duration:</span>
                          {isEditing ? (
                            <input
                              type="number"
                              value={editValues.duration_seconds || 0}
                              onChange={(e) => handleFieldChange(item.id, 'duration_seconds', parseInt(e.target.value) || 0)}
                              min="0"
                              style={{ width: '60px' }}
                              title="Effect duration in seconds"
                            />
                          ) : (
                            <span>{item.duration_seconds || 0}s</span>
                          )}
                        </div>
                        <div className="stat">
                          <span>Max Stack:</span>
                          {isEditing ? (
                            <input
                              type="number"
                              value={editValues.max_stack}
                              onChange={(e) => handleFieldChange(item.id, 'max_stack', parseInt(e.target.value) || 0)}
                              min="0"
                              style={{ width: '60px' }}
                              placeholder="0 = ∞"
                            />
                          ) : (
                            <span>{item.max_stack === 0 ? 'Unlimited' : item.max_stack}</span>
                          )}
                        </div>
                      </div>

                      <div className="item-actions">
                        {isEditing ? (
                          <>
                            <button 
                              onClick={() => handleSaveItem(item.id)}
                              className="save-btn"
                              style={{ backgroundColor: '#4CAF50' }}
                            >
                              💾 Save
                            </button>
                            <button 
                              onClick={() => handleCancelEdit(item.id)}
                              className="cancel-btn"
                              style={{ backgroundColor: '#f44336' }}
                            >
                              ❌ Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button 
                              onClick={() => handleEditItem(item.id)}
                              className="edit-btn"
                              style={{ backgroundColor: '#2196F3' }}
                            >
                              ✏️ Edit
                            </button>
                            <button 
                              onClick={() => {
                                const price = prompt('Enter price:');
                                const stock = prompt('Enter stock (0 for unlimited):');
                                if (price && stock) {
                                  handleAddToShop(item.id, parseInt(price), parseInt(stock));
                                }
                              }}
                              className="add-to-shop-btn"
                              style={{ backgroundColor: '#FF9800' }}
                            >
                              🛒 Shop
                            </button>
                            <button 
                              onClick={() => handleDeleteItem(item.id)}
                              className="delete-btn"
                              style={{ backgroundColor: '#f44336' }}
                            >
                              🗑️ Delete
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {activeView === 'shop' && (
          <div className="shop-view">
            <div className="section-header">
              <h4>Shop Items ({shopItems.length})</h4>
              <button onClick={fetchShopItems} className="refresh-btn">
                🔄 Refresh
              </button>
            </div>
            
            <div className="shop-items-grid">
              {shopItems.map((shopItem) => (
                <div key={shopItem.shop_item_id} className="shop-item-card">
                  <div className="shop-item-header">
                    <span className="item-emoji">{shopItem.item?.emoji}</span>
                    <div className="item-info">
                      <h5 style={{ color: getRarityColor(shopItem.item?.rarity || 'common') }}>
                        {shopItem.item?.display_name}
                      </h5>
                      <div className="item-meta">
                        <span className="item-type">
                          {getTypeIcon(shopItem.item?.item_type || 'utility')} {shopItem.item?.item_type}
                        </span>
                        {shopItem.is_featured && (
                          <span className="featured-badge">⭐ Featured</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="shop-item-pricing">
                    <div className="price">
                      <span>Price:</span>
                      <span>💎 {shopItem.price.toLocaleString()}</span>
                    </div>
                    <div className="stock">
                      <span>Stock:</span>
                      <span>{shopItem.stock === 0 ? 'Unlimited' : shopItem.stock}</span>
                    </div>
                    {shopItem.discount_percentage && (
                      <div className="discount">
                        <span>Discount:</span>
                        <span>{shopItem.discount_percentage}%</span>
                      </div>
                    )}
                  </div>

                  <div className="shop-item-actions">
                    <button 
                      onClick={() => {
                        const newPrice = prompt('New price:', shopItem.price.toString());
                        if (newPrice) {
                          handleUpdateShopItem(shopItem.shop_item_id, { price: parseInt(newPrice) });
                        }
                      }}
                      className="update-btn"
                    >
                      💰 Update Price
                    </button>
                    <button 
                      onClick={() => {
                        const newStock = prompt('New stock (0 for unlimited):', shopItem.stock.toString());
                        if (newStock) {
                          handleUpdateShopItem(shopItem.shop_item_id, { stock: parseInt(newStock) });
                        }
                      }}
                      className="update-btn"
                    >
                      📦 Update Stock
                    </button>
                    <button 
                      onClick={() => {
                        handleUpdateShopItem(shopItem.shop_item_id, { is_featured: !shopItem.is_featured });
                      }}
                      className={`feature-btn ${shopItem.is_featured ? 'featured' : ''}`}
                    >
                      {shopItem.is_featured ? '⭐ Unfeature' : '⭐ Feature'}
                    </button>
                    <button 
                      onClick={() => {
                        if (window.confirm('Remove this item from the shop?')) {
                          handleRemoveFromShop(shopItem.shop_item_id);
                        }
                      }}
                      className="remove-btn"
                    >
                      🗑️ Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeView === 'create' && (
          <div className="create-view">
            <div className="section-header">
              <h4>Create New Item</h4>
            </div>
            
            <form onSubmit={handleCreateItem} className="create-item-form">
              <div className="form-row">
                <div className="form-group">
                  <label>Name (Internal):</label>
                  <input
                    type="text"
                    value={newItem.name}
                    onChange={(e) => setNewItem({...newItem, name: e.target.value})}
                    required
                    placeholder="e.g., speed_boost"
                  />
                </div>
                <div className="form-group">
                  <label>Display Name:</label>
                  <input
                    type="text"
                    value={newItem.display_name}
                    onChange={(e) => setNewItem({...newItem, display_name: e.target.value})}
                    required
                    placeholder="e.g., Speed Boost"
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Emoji:</label>
                  <input
                    type="text"
                    value={newItem.emoji}
                    onChange={(e) => setNewItem({...newItem, emoji: e.target.value})}
                    required
                    placeholder="⚡"
                    maxLength={2}
                  />
                </div>
                <div className="form-group">
                  <label>Type:</label>
                  <select
                    value={newItem.item_type}
                    onChange={(e) => setNewItem({...newItem, item_type: e.target.value as any})}
                  >
                    <option value="buff">Buff</option>
                    <option value="debuff">Debuff</option>
                    <option value="utility">Utility</option>
                  </select>
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Rarity:</label>
                  <select
                    value={newItem.rarity}
                    onChange={(e) => setNewItem({...newItem, rarity: e.target.value as any})}
                  >
                    <option value="common">Common</option>
                    <option value="uncommon">Uncommon</option>
                    <option value="rare">Rare</option>
                    <option value="epic">Epic</option>
                    <option value="legendary">Legendary</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Shop Category:</label>
                  <select
                    value={newItem.category}
                    onChange={(e) => setNewItem({...newItem, category: e.target.value})}
                    title="Category for shop organization"
                  >
                    <option value="utility">Utility</option>
                    <option value="powerups">Powerups</option>
                    <option value="debuffs">Debuffs</option>
                    <option value="visual_effects">Visual Effects</option>
                    <option value="sound_effects">Sound Effects</option>
                    <option value="drawing_tools">Drawing Tools</option>
                    <option value="protection">Protection</option>
                    <option value="combat">Combat</option>
                    <option value="general">General</option>
                    <option value="misc">Misc</option>
                  </select>
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Cooldown (seconds):</label>
                  <input
                    type="number"
                    value={newItem.cooldown_seconds}
                    onChange={(e) => setNewItem({...newItem, cooldown_seconds: parseInt(e.target.value)})}
                    min="0"
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Duration (seconds):</label>
                  <input
                    type="number"
                    value={newItem.duration_seconds}
                    onChange={(e) => setNewItem({...newItem, duration_seconds: parseInt(e.target.value)})}
                    min="0"
                    placeholder="Effect duration"
                    title="How long the buff/debuff effect lasts"
                  />
                </div>
                <div className="form-group">
                  <label>Base Price (Points):</label>
                  <input
                    type="number"
                    value={newItem.base_price}
                    onChange={(e) => setNewItem({...newItem, base_price: parseInt(e.target.value)})}
                    min="1"
                    step="10"
                    placeholder="100"
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Max Stack (0 = Unlimited):</label>
                  <input
                    type="number"
                    value={newItem.max_stack}
                    onChange={(e) => setNewItem({...newItem, max_stack: parseInt(e.target.value)})}
                    min="0"
                    placeholder="0 for unlimited"
                  />
                </div>
              </div>

              <div className="form-group">
                <label>Description:</label>
                <textarea
                  value={newItem.description}
                  onChange={(e) => setNewItem({...newItem, description: e.target.value})}
                  required
                  placeholder="Describe what this item does..."
                  rows={3}
                />
              </div>

              <div className="form-actions">
                <button type="submit" className="create-btn">
                  ✨ Create Item
                </button>
                <button 
                  type="button" 
                  onClick={() => setActiveView('items')} 
                  className="cancel-btn"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
};

export default ItemManagement;