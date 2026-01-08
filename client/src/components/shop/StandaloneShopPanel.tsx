import React, { useState, useEffect } from 'react';
import { Socket } from 'socket.io-client';
import ShopGrid from '../inventory/ShopGrid';
import ShopQuantitySelector from '../inventory/ShopQuantitySelector';
import '../inventory/ShopStyles.css';
import './StandaloneShopStyles.css';

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

interface StandaloneShopPanelProps {
  socket: Socket | null;
  isAuthenticated: boolean;
  userProfile: UserProfile | null;
  isOpen: boolean;
  onClose: () => void;
}

const StandaloneShopPanel: React.FC<StandaloneShopPanelProps> = ({ 
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
  const itemsPerPage = 10;

  useEffect(() => {
    if (isOpen) {
      fetchShopItems();
    }
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

  const filteredItems = getFilteredItems();
  const paginatedItems = getPaginatedItems();
  const totalPages = getTotalPages();
  const userPoints = userProfile?.points || 0;

  return (
    <div className={`standalone-shop-panel ${isOpen ? 'open' : ''}`}>
      <div className="shop-panel-content">
        <div className="shop-header">
          <div className="shop-title">
            <span className="shop-emoji">🛒</span>
            <h3>Shop</h3>
          </div>
          <div className="shop-header-right">
            {isAuthenticated && (
              <div className="user-points">
                <span className="points-emoji">💎</span>
                <span className="points-value">{userPoints.toLocaleString()}</span>
              </div>
            )}
            <button 
              className="shop-close-btn" 
              onClick={onClose}
              title="Close Shop (ESC)"
            >
              ×
            </button>
          </div>
        </div>

        <div className="shop-tabs">
          <button 
            className={`shop-tab ${activeTab === 'all' ? 'active' : ''}`}
            onClick={() => setActiveTab('all')}
          >
            All
          </button>
          <button 
            className={`shop-tab ${activeTab === 'buff' ? 'active' : ''}`}
            onClick={() => setActiveTab('buff')}
          >
            Buff
          </button>
          <button 
            className={`shop-tab ${activeTab === 'debuff' ? 'active' : ''}`}
            onClick={() => setActiveTab('debuff')}
          >
            Debuff
          </button>
          <button 
            className={`shop-tab ${activeTab === 'utility' ? 'active' : ''}`}
            onClick={() => setActiveTab('utility')}
          >
            Utility
          </button>
          <button 
            className={`shop-tab ${activeTab === 'guard' ? 'active' : ''}`}
            onClick={() => setActiveTab('guard')}
          >
            Guard
          </button>
          <button 
            className={`shop-tab ${activeTab === 'weapon' ? 'active' : ''}`}
            onClick={() => setActiveTab('weapon')}
          >
            Weapon
          </button>
          <button 
            className={`shop-tab ${activeTab === 'marker' ? 'active' : ''}`}
            onClick={() => setActiveTab('marker')}
          >
            Marker
          </button>
        </div>

        {error && (
          <div className="shop-error">
            {error}
          </div>
        )}

        {successMessage && (
          <div className="shop-success">
            {successMessage}
          </div>
        )}

        {!isAuthenticated ? (
          <div className="shop-guest-prompt">
            <div className="guest-prompt-content">
              <h4>🎁 Welcome to the Shop!</h4>
              <p>Discover amazing items and power-ups to enhance your streaming experience!</p>
              <div className="guest-benefits">
                <div className="benefit-item">
                  <span className="benefit-emoji">⚡</span>
                  <span>Speed boosts and performance enhancers</span>
                </div>
                <div className="benefit-item">
                  <span className="benefit-emoji">🎯</span>
                  <span>Spotlight effects and visual enhancements</span>
                </div>
                <div className="benefit-item">
                  <span className="benefit-emoji">🛠️</span>
                  <span>Utility tools for stream management</span>
                </div>
              </div>
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
        ) : isLoading ? (
          <div className="shop-loading">
            Loading shop items...
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="shop-empty">
            {activeTab === 'all'
              ? 'No items available in the shop'
              : `No ${activeTab} items available`
            }
          </div>
        ) : (
          <>
            <ShopGrid 
              items={paginatedItems}
              onPurchaseItem={handlePurchaseItem}
              userPoints={userPoints}
              isAuthenticated={isAuthenticated}
              purchasedItemId={purchasedItemId}
            />
            
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
                  
                  <div className="pagination-pages">
                    {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => (
                      <button
                        key={page}
                        className={`pagination-page ${currentPage === page ? 'active' : ''}`}
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

export default StandaloneShopPanel;