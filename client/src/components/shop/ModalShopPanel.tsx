import React, { useState, useEffect } from 'react';
import { Socket } from 'socket.io-client';
import ShopQuantitySelector from '../inventory/ShopQuantitySelector';
import './ModalShopStyles.css';

interface ShopItemData {
  shop_id: number;
  item_id: number;
  name: string;
  display_name: string;
  emoji: string;
  description: string;
  item_type: 'buff' | 'debuff' | 'utility' | 'guard' | 'weapon' | 'marker';
  rarity: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
  price: number;
  stock_limit: number;
  is_featured: number;
  discount_percentage: number;
}

interface UserProfile {
  points: number;
}

interface ModalShopPanelProps {
  socket: Socket | null;
  isAuthenticated: boolean;
  userProfile: UserProfile | null;
  isOpen: boolean;
  onClose: () => void;
}

const ModalShopPanel: React.FC<ModalShopPanelProps> = ({ 
  socket, 
  isAuthenticated, 
  userProfile,
  isOpen,
  onClose
}) => {
  const [shopItems, setShopItems] = useState<ShopItemData[]>([]);
  const [activeTab, setActiveTab] = useState<'all' | 'buff' | 'debuff' | 'utility' | 'guard' | 'weapon' | 'marker'>('all');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [purchasedItemId, setPurchasedItemId] = useState<number | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [showQuantitySelector, setShowQuantitySelector] = useState(false);
  const [selectedItem, setSelectedItem] = useState<ShopItemData | null>(null);
  const itemsPerPage = 15; // More items for larger layout

  useEffect(() => {
    if (isOpen) {
      fetchShopItems();
      document.body.style.overflow = 'hidden'; // Prevent background scrolling
    } else {
      document.body.style.overflow = '';
    }

    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  // Add keyboard shortcut for ESC to close shop
  useEffect(() => {
    const handleKeyPress = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isOpen) {
        onClose();
      }
    };

    if (isOpen) {
      window.addEventListener('keydown', handleKeyPress);
    }

    return () => {
      window.removeEventListener('keydown', handleKeyPress);
    };
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!socket) return;

    const handleShopUpdate = () => {
      fetchShopItems();
    };

    const handlePointsUpdate = () => {
      // Points will be updated via parent component
    };

    socket.on('shop-updated', handleShopUpdate);
    socket.on('points-updated', handlePointsUpdate);

    return () => {
      socket.off('shop-updated', handleShopUpdate);
      socket.off('points-updated', handlePointsUpdate);
    };
  }, [socket]);

  const fetchShopItems = async () => {
    try {
      setIsLoading(true);
      const response = await fetch('/api/shop');

      if (!response.ok) {
        throw new Error('Failed to fetch shop items');
      }

      const data = await response.json();
      setShopItems(data);
      setError(null);
    } catch (err: any) {
      setError(err.message);
      console.error('Error fetching shop items:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handlePurchaseItem = async (itemId: number) => {
    if (!isAuthenticated) {
      setError('Please log in to purchase items');
      return;
    }

    const item = shopItems.find(item => item.item_id === itemId);
    if (!item) return;

    setSelectedItem(item);
    setShowQuantitySelector(true);
  };

  const handleQuantityPurchase = async (itemId: number, quantity: number, itemName: string, emoji: string) => {
    try {
      const token = localStorage.getItem('auth_token');
      const response = await fetch('/api/shop/purchase', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ itemId: itemId, quantity: quantity })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to purchase item');
      }

      const result = await response.json();
      
      // Show purchase notification
      if ((window as any).showItemNotification) {
        (window as any).showItemNotification({
          emoji: emoji,
          itemName: itemName,
          type: 'purchase',
          quantity: quantity
        });
      }
      
      // Update shop items (reduce stock only if not unlimited)
      setShopItems(prev => prev.map(item => 
        item.item_id === itemId 
          ? { ...item, stock_limit: item.stock_limit === 0 ? 0 : Math.max(-1, item.stock_limit - quantity) }
          : item
      ));

      // Show success message
      setSuccessMessage(quantity > 1 ? `Successfully purchased ${quantity}x ${itemName}! 🎉` : `Successfully purchased ${itemName}! 🎉`);
      setPurchasedItemId(itemId);
      
      // Clear success message after 3 seconds
      setTimeout(() => {
        setSuccessMessage(null);
        setPurchasedItemId(null);
      }, 3000);

      // Emit socket event for real-time updates
      if (socket) {
        socket.emit('item-purchased', { itemId, quantity, purchaseData: result });
      }

      setError(null);
    } catch (err: any) {
      setError(err.message);
      console.error('Error purchasing item:', err);
      throw err; // Re-throw so the quantity selector can handle it
    }
  };

  // Reset to page 1 when tab changes
  useEffect(() => {
    setCurrentPage(1);
  }, [activeTab]);

  const getFilteredItems = () => {
    switch (activeTab) {
      case 'all':
        return shopItems;
      default:
        return shopItems.filter(item => item.item_type === activeTab);
    }
  };

  const getPaginatedItems = () => {
    const filteredItems = getFilteredItems();
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    return filteredItems.slice(startIndex, endIndex);
  };

  const getTotalPages = () => {
    const filteredItems = getFilteredItems();
    return Math.ceil(filteredItems.length / itemsPerPage);
  };

  const getItemPurchaseStatus = (item: ShopItemData) => {
    if (!isAuthenticated) {
      return { canPurchase: false, status: 'login-required', message: 'Login Required' };
    }
    
    if (item.stock_limit < 0) {
      return { canPurchase: false, status: 'out-of-stock', message: 'Out of Stock' };
    }
    
    const discountedPrice = item.discount_percentage > 0 
      ? Math.floor(item.price * (1 - item.discount_percentage / 100))
      : item.price;
      
    if ((userProfile?.points || 0) < discountedPrice) {
      return { canPurchase: false, status: 'insufficient-points', message: 'Not Enough Points' };
    }
    
    return { canPurchase: true, status: 'can-purchase', message: 'Click to Purchase' };
  };

  const filteredItems = getFilteredItems();
  const paginatedItems = getPaginatedItems();
  const totalPages = getTotalPages();
  const userPoints = userProfile?.points || 0;

  if (!isOpen) return null;

  return (
    <div className="modal-shop-overlay">
      <div className="modal-shop-panel">
        <div className="modal-shop-header">
          <div className="shop-title-section">
            <span className="shop-icon">🛒</span>
            <h2>Shop</h2>
          </div>
          <div className="shop-header-right">
            {isAuthenticated && (
              <div className="user-points-display">
                <span className="points-icon">💎</span>
                <span className="points-amount">{userPoints.toLocaleString()}</span>
              </div>
            )}
            <button 
              className="modal-close-btn" 
              onClick={onClose}
              title="Close Shop (ESC)"
            >
              ×
            </button>
          </div>
        </div>

        <div className="shop-categories">
          <button 
            className={`category-btn ${activeTab === 'all' ? 'active' : ''}`}
            onClick={() => setActiveTab('all')}
          >
            All
          </button>
          <button 
            className={`category-btn ${activeTab === 'buff' ? 'active' : ''}`}
            onClick={() => setActiveTab('buff')}
          >
            Buffs
          </button>
          <button 
            className={`category-btn ${activeTab === 'debuff' ? 'active' : ''}`}
            onClick={() => setActiveTab('debuff')}
          >
            Debuffs
          </button>
          <button 
            className={`category-btn ${activeTab === 'utility' ? 'active' : ''}`}
            onClick={() => setActiveTab('utility')}
          >
            Utility
          </button>
          <button 
            className={`category-btn ${activeTab === 'guard' ? 'active' : ''}`}
            onClick={() => setActiveTab('guard')}
          >
            Guards
          </button>
          <button 
            className={`category-btn ${activeTab === 'weapon' ? 'active' : ''}`}
            onClick={() => setActiveTab('weapon')}
          >
            Weapons
          </button>
          <button 
            className={`category-btn ${activeTab === 'marker' ? 'active' : ''}`}
            onClick={() => setActiveTab('marker')}
          >
            Markers
          </button>
        </div>

        {error && (
          <div className="shop-error-message">
            {error}
          </div>
        )}

        {successMessage && (
          <div className="shop-success-message">
            {successMessage}
          </div>
        )}

        <div className="shop-content">
          {!isAuthenticated ? (
            <div className="shop-guest-section">
              <div className="guest-welcome">
                <h3>🎁 Welcome to the Shop!</h3>
                <p>Discover amazing items and power-ups to enhance your streaming experience!</p>
                
                <div className="feature-highlights">
                  <div className="feature-item">
                    <span className="feature-icon">⚡</span>
                    <span>Speed boosts and performance enhancers</span>
                  </div>
                  <div className="feature-item">
                    <span className="feature-icon">🎯</span>
                    <span>Spotlight effects and visual enhancements</span>
                  </div>
                  <div className="feature-item">
                    <span className="feature-icon">🛠️</span>
                    <span>Utility tools for stream management</span>
                  </div>
                </div>
                
                <div className="auth-section">
                  <p><strong>Sign up or log in to start collecting items!</strong></p>
                  <div className="auth-buttons">
                    <a href="/login" className="auth-btn login-btn">
                      Login
                    </a>
                    <a href="/signup" className="auth-btn signup-btn">
                      Sign Up
                    </a>
                  </div>
                </div>
              </div>
            </div>
          ) : isLoading ? (
            <div className="shop-loading-state">
              <div className="loading-spinner"></div>
              <p>Loading shop items...</p>
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="shop-empty-state">
              <span className="empty-icon">📦</span>
              <h3>No Items Available</h3>
              <p>
                {activeTab === 'all'
                  ? 'The shop is currently empty. Check back later!'
                  : `No ${activeTab} items are currently available.`
                }
              </p>
            </div>
          ) : (
            <>
              <div className="shop-items-grid">
                {paginatedItems.map((item) => {
                  const purchaseStatus = getItemPurchaseStatus(item);
                  const discountedPrice = item.discount_percentage > 0 
                    ? Math.floor(item.price * (1 - item.discount_percentage / 100))
                    : item.price;

                  return (
                    <div
                      key={item.item_id}
                      className={`shop-item-card ${!purchaseStatus.canPurchase ? 'disabled' : ''} ${
                        item.stock_limit < 0 ? 'out-of-stock' : ''
                      } ${item.is_featured ? 'featured' : ''} rarity-${item.rarity} ${
                        purchasedItemId === item.item_id ? 'just-purchased' : ''
                      }`}
                      onClick={() => purchaseStatus.canPurchase && handlePurchaseItem(item.item_id)}
                    >
                      {item.is_featured > 0 && (
                        <div className="featured-badge">⭐ Featured</div>
                      )}
                      
                      {item.discount_percentage > 0 && (
                        <div className="discount-badge">-{item.discount_percentage}%</div>
                      )}

                      <div className="item-emoji">{item.emoji}</div>
                      
                      <div className="item-details">
                        <h4 className="item-name">{item.display_name}</h4>
                        <p className="item-description">{item.description}</p>
                        
                        <div className="item-meta">
                          <span className={`item-type type-${item.item_type}`}>
                            {item.item_type.charAt(0).toUpperCase() + item.item_type.slice(1)}
                          </span>
                          <span className={`item-rarity rarity-${item.rarity}`}>
                            {item.rarity.charAt(0).toUpperCase() + item.rarity.slice(1)}
                          </span>
                        </div>

                        <div className="item-pricing">
                          {item.discount_percentage > 0 && (
                            <span className="original-price">{item.price.toLocaleString()} 💎</span>
                          )}
                          <span className="current-price">{discountedPrice.toLocaleString()} 💎</span>
                        </div>

                        {item.stock_limit > 0 && (
                          <div className="stock-info">
                            <span className="stock-count">{item.stock_limit} in stock</span>
                          </div>
                        )}

                        <div className={`purchase-status status-${purchaseStatus.status}`}>
                          {purchaseStatus.message}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {totalPages > 1 && (
                <div className="shop-pagination">
                  <div className="pagination-info">
                    Showing {((currentPage - 1) * itemsPerPage) + 1}-{Math.min(currentPage * itemsPerPage, filteredItems.length)} of {filteredItems.length} items
                  </div>
                  
                  <div className="pagination-controls">
                    <button 
                      className={`pagination-btn ${currentPage === 1 ? 'disabled' : ''}`}
                      onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                      disabled={currentPage === 1}
                    >
                      ← Previous
                    </button>
                    
                    <div className="pagination-numbers">
                      {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => (
                        <button
                          key={page}
                          className={`page-number ${currentPage === page ? 'active' : ''}`}
                          onClick={() => setCurrentPage(page)}
                        >
                          {page}
                        </button>
                      ))}
                    </div>
                    
                    <button 
                      className={`pagination-btn ${currentPage === totalPages ? 'disabled' : ''}`}
                      onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                      disabled={currentPage === totalPages}
                    >
                      Next →
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Quantity Selector Modal */}
        {showQuantitySelector && selectedItem && userProfile && (
          <ShopQuantitySelector
            itemId={selectedItem.item_id}
            itemName={selectedItem.display_name}
            emoji={selectedItem.emoji}
            price={selectedItem.price}
            userPoints={userProfile.points}
            maxQuantity={selectedItem.stock_limit === 0 ? 999 : selectedItem.stock_limit}
            onPurchase={handleQuantityPurchase}
            onClose={() => {
              setShowQuantitySelector(false);
              setSelectedItem(null);
            }}
          />
        )}
      </div>
    </div>
  );
};

export default ModalShopPanel;