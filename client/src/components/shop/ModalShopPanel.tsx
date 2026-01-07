import React, { useState, useEffect, useRef } from 'react';
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
  category?: string;
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
  const [activeTab, setActiveTab] = useState<string>('all');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [purchasedItemId, setPurchasedItemId] = useState<number | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [showQuantitySelector, setShowQuantitySelector] = useState(false);
  const [selectedItem, setSelectedItem] = useState<ShopItemData | null>(null);
  const [searchTerm, setSearchTerm] = useState(''); // Add search term state
  const itemsPerPage = 15; // More items for larger layout

  // Reference to panel (no swipe handling needed for full screen mobile)
  const panelRef = useRef<HTMLDivElement>(null);
  const shopContentRef = useRef<HTMLDivElement>(null); // Add ref for shop content area
  const [isDragging, setIsDragging] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const startYRef = useRef<number>(0);
  const currentYRef = useRef<number>(0);
  const startHeightRef = useRef<number>(40);

  const handleTouchStart = (e: React.TouchEvent) => {
    // Disable dragging on mobile for full screen experience
    if (window.innerWidth <= 768) {
      return;
    }
    
    const target = e.target as HTMLElement;
    const isHeader = target.closest('.modal-shop-header');
    
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
    // Disable dragging on mobile for full screen experience
    if (window.innerWidth <= 768) {
      return;
    }
    
    if (!isDragging) return;

    e.preventDefault(); // Prevent scroll interference
    currentYRef.current = e.touches[0].clientY;
    const distance = currentYRef.current - startYRef.current;
    
    // Use requestAnimationFrame for smoother updates
    requestAnimationFrame(() => {
      const viewportHeight = window.innerHeight;
      const distanceInVh = (distance / viewportHeight) * 100;
      const newHeight = Math.max(20, Math.min(85, startHeightRef.current - distanceInVh));
      
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
    // Disable dragging on mobile for full screen experience
    if (window.innerWidth <= 768) {
      return;
    }
    
    if (!isDragging) return;

    setIsDragging(false);
    const distance = currentYRef.current - startYRef.current;
    const viewportHeight = window.innerHeight;
    const distanceInVh = (distance / viewportHeight) * 100;
    const currentHeight = startHeightRef.current - distanceInVh;

    if (panelRef.current) {
      panelRef.current.style.transition = 'all 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94)';
      
      if (startHeightRef.current === 40 && distance > 100) {
        panelRef.current.style.transform = 'translateY(100%)';
        panelRef.current.style.height = '40vh';
        setTimeout(() => {
          onClose();
          if (panelRef.current) {
            panelRef.current.style.transform = '';
            setIsExpanded(false);
          }
        }, 300);
      } else if (currentHeight > 60) {
        panelRef.current.style.height = '85vh';
        panelRef.current.style.transform = '';
        setIsExpanded(true);
      } else if (currentHeight < 30 && startHeightRef.current === 85) {
        panelRef.current.style.height = '40vh';
        panelRef.current.style.transform = '';
        setIsExpanded(false);
      } else {
        panelRef.current.style.height = isExpanded ? '85vh' : '40vh';
        panelRef.current.style.transform = '';
      }
    }
  };

  useEffect(() => {
    if (isOpen && panelRef.current) {
      // Full screen on mobile, regular behavior on desktop
      if (window.innerWidth <= 768) {
        panelRef.current.style.transform = 'translateY(0)';
        panelRef.current.style.height = '100vh';
        setIsExpanded(true); // Always expanded on mobile
      } else {
        panelRef.current.style.transform = 'translateY(0)';
        panelRef.current.style.height = '40vh';
        setIsExpanded(false);
      }
    }
  }, [isOpen]);

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

  // Add keyboard shortcut for ESC to close shop (or quantity selector if open)
  useEffect(() => {
    const handleKeyPress = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isOpen) {
        // If quantity selector is open, close it instead of the shop
        if (showQuantitySelector) {
          setShowQuantitySelector(false);
          setSelectedItem(null);
        } else {
          onClose();
        }
      }
    };

    if (isOpen) {
      window.addEventListener('keydown', handleKeyPress);
    }

    return () => {
      window.removeEventListener('keydown', handleKeyPress);
    };
  }, [isOpen, onClose, showQuantitySelector]);

  // Handle browser back gesture for quantity selector
  useEffect(() => {
    if (showQuantitySelector) {
      // Push history state so back gesture can be intercepted
      window.history.pushState({ nestedPanel: 'quantitySelector' }, '');

      // Register close handler for App.tsx to call on back gesture
      (window as any).__closeNestedPanel = () => {
        setShowQuantitySelector(false);
        setSelectedItem(null);
        (window as any).__closeNestedPanel = null;
      };

      return () => {
        (window as any).__closeNestedPanel = null;
      };
    }
  }, [showQuantitySelector]);

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

  // Reset to page 1 when tab or search changes
  useEffect(() => {
    setCurrentPage(1);
  }, [activeTab, searchTerm]);

  // Function to handle page changes with scroll to top
  const handlePageChange = (newPage: number) => {
    setCurrentPage(newPage);
    // Scroll shop content to top when changing pages
    if (shopContentRef.current) {
      shopContentRef.current.scrollTop = 0;
    }
  };

  const getFilteredItems = () => {
    let filtered = shopItems;
    
    // Filter by category
    if (activeTab !== 'all') {
      filtered = filtered.filter(item => item.category === activeTab);
    }
    
    // Filter by search term
    if (searchTerm.trim()) {
      const searchLower = searchTerm.toLowerCase();
      filtered = filtered.filter(item => 
        item.display_name.toLowerCase().includes(searchLower) ||
        item.name.toLowerCase().includes(searchLower) ||
        item.description?.toLowerCase().includes(searchLower) ||
        item.item_type.toLowerCase().includes(searchLower) ||
        item.category?.toLowerCase().includes(searchLower)
      );
    }
    
    return filtered;
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
    
    // stock_limit: 0 = unlimited, -1 = not available, positive = limited stock
    // No need to check for out of stock here since 0 means unlimited
    
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
      <div 
        ref={panelRef}
        className={`modal-shop-panel ${isExpanded ? 'expanded' : ''}`}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
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

        <div className="shop-search-bar">
          <input
            type="text"
            className="shop-search-input"
            placeholder="🔍 Search items by name, type, or category..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          {searchTerm && (
            <button 
              className="search-clear-btn"
              onClick={() => setSearchTerm('')}
              title="Clear search"
            >
              ×
            </button>
          )}
        </div>

        <div className="shop-categories">
          <button 
            className={`category-btn ${activeTab === 'all' ? 'active' : ''}`}
            onClick={() => setActiveTab('all')}
          >
            All
          </button>
          <button 
            className={`category-btn ${activeTab === 'sound_effects' ? 'active' : ''}`}
            onClick={() => setActiveTab('sound_effects')}
          >
            Sound Effects
          </button>
          <button 
            className={`category-btn ${activeTab === 'visual_effects' ? 'active' : ''}`}
            onClick={() => setActiveTab('visual_effects')}
          >
            Visual Effects
          </button>
          <button 
            className={`category-btn ${activeTab === 'drawing_tools' ? 'active' : ''}`}
            onClick={() => setActiveTab('drawing_tools')}
          >
            Drawing Tools
          </button>
          <button 
            className={`category-btn ${activeTab === 'powerups' ? 'active' : ''}`}
            onClick={() => setActiveTab('powerups')}
          >
            Power-ups
          </button>
          <button 
            className={`category-btn ${activeTab === 'protection' ? 'active' : ''}`}
            onClick={() => setActiveTab('protection')}
          >
            Protection
          </button>
          <button 
            className={`category-btn ${activeTab === 'combat' ? 'active' : ''}`}
            onClick={() => setActiveTab('combat')}
          >
            Combat
          </button>
          <button 
            className={`category-btn ${activeTab === 'utility' ? 'active' : ''}`}
            onClick={() => setActiveTab('utility')}
          >
            Utility
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

        <div className="shop-content" ref={shopContentRef}>
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
                        item.is_featured ? 'featured' : ''
                      } rarity-${item.rarity} ${
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
                      onClick={() => handlePageChange(Math.max(1, currentPage - 1))}
                      disabled={currentPage === 1}
                    >
                      ← Previous
                    </button>
                    
                    <div className="pagination-numbers">
                      {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => (
                        <button
                          key={page}
                          className={`page-number ${currentPage === page ? 'active' : ''}`}
                          onClick={() => handlePageChange(page)}
                        >
                          {page}
                        </button>
                      ))}
                    </div>
                    
                    <button 
                      className={`pagination-btn ${currentPage === totalPages ? 'disabled' : ''}`}
                      onClick={() => handlePageChange(Math.min(totalPages, currentPage + 1))}
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