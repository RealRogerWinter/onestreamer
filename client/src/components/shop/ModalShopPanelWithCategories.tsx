import React, { useState, useEffect, useRef, useMemo } from 'react';
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
  const itemsPerPage = 15;

  // Get unique categories from items
  const categories = useMemo(() => {
    const uniqueCategories = new Set<string>();
    shopItems.forEach(item => {
      if (item.category) {
        uniqueCategories.add(item.category);
      }
    });
    
    // Convert to array and format for display
    return Array.from(uniqueCategories).map(cat => ({
      value: cat,
      label: cat.split('_').map(word => 
        word.charAt(0).toUpperCase() + word.slice(1)
      ).join(' ')
    })).sort((a, b) => a.label.localeCompare(b.label));
  }, [shopItems]);

  // Reference to panel (no swipe handling needed for full screen mobile)
  const panelRef = useRef<HTMLDivElement>(null);
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
        
        // Update opacity based on height
        const opacity = Math.max(0.95, Math.min(1, newHeight / 50));
        panelRef.current.style.opacity = `${opacity}`;
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
    const finalHeight = startHeightRef.current - distanceInVh;
    
    if (panelRef.current) {
      panelRef.current.style.transition = 'height 0.3s ease-in-out, opacity 0.3s ease-in-out';
      
      // Snap to expanded or collapsed state
      if (finalHeight > 60) {
        panelRef.current.style.height = '85vh';
        panelRef.current.style.opacity = '1';
        setIsExpanded(true);
      } else if (finalHeight < 30) {
        panelRef.current.style.height = '40vh';
        panelRef.current.style.opacity = '0.98';
        setIsExpanded(false);
      } else {
        // Return to previous state
        panelRef.current.style.height = `${startHeightRef.current}vh`;
        panelRef.current.style.opacity = startHeightRef.current > 60 ? '1' : '0.98';
      }
    }
  };

  useEffect(() => {
    if (panelRef.current) {
      if (window.innerWidth <= 768) {
        // Full screen on mobile
        panelRef.current.style.height = '100vh';
        panelRef.current.style.transform = isOpen ? 'translateY(0)' : 'translateY(100%)';
        setIsExpanded(true);
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

  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyPress);

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

  const handlePurchase = (itemId: number) => {
    // Open quantity selector for item
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
        throw new Error(error.error || 'Purchase failed');
      }

      const result = await response.json();
      setSuccessMessage(`Successfully purchased ${quantity}x ${emoji} ${itemName}!`);
      setPurchasedItemId(itemId);
      
      // Clear success message after 3 seconds
      setTimeout(() => {
        setSuccessMessage(null);
        setPurchasedItemId(null);
      }, 3000);

      // Refresh shop to update stock
      fetchShopItems();

      // Emit inventory update event
      if (socket) {
        socket.emit('inventory-update');
      }

      setShowQuantitySelector(false);
      setSelectedItem(null);
    } catch (err: any) {
      setError(err.message);
      setTimeout(() => setError(null), 5000);
    }
  };

  const formatPrice = (price: number) => {
    return new Intl.NumberFormat().format(price);
  };

  const getRarityColor = (rarity: string) => {
    switch (rarity) {
      case 'common': return '#b0b0b0';
      case 'uncommon': return '#1eff00';
      case 'rare': return '#0070dd';
      case 'epic': return '#a335ee';
      case 'legendary': return '#ff8000';
      default: return '#ffffff';
    }
  };

  const getItemTypeIcon = (type: string) => {
    switch (type) {
      case 'buff': return '⬆️';
      case 'debuff': return '⬇️';
      case 'utility': return '🔧';
      case 'guard': return '🛡️';
      case 'weapon': return '⚔️';
      case 'marker': return '✏️';
      default: return '📦';
    }
  };

  const getCategoryIcon = (category: string) => {
    switch (category) {
      case 'sound_effects': return '🔊';
      case 'visual_effects': return '✨';
      case 'drawing_tools': return '🎨';
      case 'powerups': return '⚡';
      case 'debuffs': return '🔻';
      case 'protection': return '🛡️';
      case 'combat': return '⚔️';
      case 'food': return '🍔';
      case 'utility': return '🔧';
      default: return '📦';
    }
  };

  const getFilteredItems = () => {
    if (activeTab === 'all') {
      return shopItems;
    }
    
    // Check if it's a category or item_type
    const isCategory = categories.some(cat => cat.value === activeTab);
    
    if (isCategory) {
      return shopItems.filter(item => item.category === activeTab);
    } else {
      // Fall back to item_type filtering for backwards compatibility
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
    
    if (!userProfile) {
      return { canPurchase: false, status: 'loading', message: 'Loading...' };
    }
    
    const finalPrice = item.price - (item.price * (item.discount_percentage || 0) / 100);
    
    if (userProfile.points < finalPrice) {
      return { canPurchase: false, status: 'insufficient-points', message: 'Not enough points' };
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
        className={`modal-shop-panel ${isExpanded ? 'expanded' : ''} ${window.innerWidth <= 768 ? 'mobile-fullscreen' : ''}`}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <div className="modal-shop-header">
          <div className="modal-shop-title">
            <span className="shop-icon">🛍️</span>
            <h2>Item Shop</h2>
            <div className="user-points">
              <span className="points-icon">💰</span>
              <span className="points-value">{formatPrice(userPoints)}</span>
            </div>
          </div>
          <div className="modal-shop-controls">
            <button 
              className="modal-close-btn"
              onClick={onClose}
              aria-label="Close Shop"
              title="Close Shop (ESC)"
            >
              ×
            </button>
          </div>
        </div>

        <div className="shop-categories">
          <button 
            className={`category-btn ${activeTab === 'all' ? 'active' : ''}`}
            onClick={() => {
              setActiveTab('all');
              setCurrentPage(1);
            }}
          >
            All
          </button>
          
          {/* Show categories if they exist */}
          {categories.length > 0 && categories.map(cat => (
            <button 
              key={cat.value}
              className={`category-btn ${activeTab === cat.value ? 'active' : ''}`}
              onClick={() => {
                setActiveTab(cat.value);
                setCurrentPage(1);
              }}
              title={`Show ${cat.label} items`}
            >
              {getCategoryIcon(cat.value)} {cat.label}
            </button>
          ))}
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

        <div className="modal-shop-content">
          {showQuantitySelector && selectedItem ? (
            <ShopQuantitySelector
              itemId={selectedItem.item_id}
              itemName={selectedItem.display_name}
              emoji={selectedItem.emoji}
              price={selectedItem.price}
              userPoints={userPoints}
              onPurchase={handleQuantityPurchase}
              onClose={() => {
                setShowQuantitySelector(false);
                setSelectedItem(null);
              }}
            />
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
                  : `No items available in this category.`}
              </p>
            </div>
          ) : (
            <>
              <div className="shop-items-grid">
                {paginatedItems.map(item => {
                  const purchaseStatus = getItemPurchaseStatus(item);
                  const finalPrice = item.price - (item.price * (item.discount_percentage || 0) / 100);
                  const isPurchased = purchasedItemId === item.item_id;
                  
                  return (
                    <div 
                      key={item.item_id}
                      className={`shop-item-card ${purchaseStatus.status} ${isPurchased ? 'just-purchased' : ''} ${item.is_featured ? 'featured' : ''}`}
                      style={{ '--rarity-color': getRarityColor(item.rarity) } as React.CSSProperties}
                    >
                      {item.is_featured === 1 && (
                        <div className="featured-badge">⭐ Featured</div>
                      )}
                      
                      {item.discount_percentage > 0 && (
                        <div className="discount-badge">-{item.discount_percentage}%</div>
                      )}
                      
                      <div className="item-header">
                        <span className="item-emoji">{item.emoji}</span>
                        <span className="item-type-icon" title={item.item_type}>
                          {getItemTypeIcon(item.item_type)}
                        </span>
                      </div>
                      
                      <h3 className="item-name">{item.display_name}</h3>
                      <p className="item-description">{item.description}</p>
                      
                      <div className="item-details">
                        <div className="item-rarity">{item.rarity}</div>
                        {item.category && (
                          <div className="item-category">
                            {getCategoryIcon(item.category)}
                            {item.category.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
                          </div>
                        )}
                        {item.stock_limit > 0 && (
                          <div className="item-stock">Stock: {item.stock_limit}</div>
                        )}
                      </div>
                      
                      <div className="item-price">
                        {item.discount_percentage > 0 && (
                          <span className="original-price">{formatPrice(item.price)}</span>
                        )}
                        <span className="final-price">💰 {formatPrice(finalPrice)}</span>
                      </div>
                      
                      <button 
                        className={`shop-buy-btn ${purchaseStatus.status}`}
                        onClick={() => handlePurchase(item.item_id)}
                        disabled={!purchaseStatus.canPurchase}
                      >
                        {purchaseStatus.message}
                      </button>
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
                      ←
                    </button>
                    
                    <span className="page-indicator">
                      Page {currentPage} of {totalPages}
                    </span>
                    
                    <button 
                      className={`pagination-btn ${currentPage === totalPages ? 'disabled' : ''}`}
                      onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                      disabled={currentPage === totalPages}
                    >
                      →
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default ModalShopPanel;