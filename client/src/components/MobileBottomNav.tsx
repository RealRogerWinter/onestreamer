import React, { useEffect, useState } from 'react';
import './MobileBottomNav.css';

interface MobileBottomNavProps {
  isAuthenticated: boolean;
  userPoints: number;
  showInventory: boolean;
  showChat: boolean;
  showShop: boolean;
  onInventoryToggle: () => void;
  onChatToggle: () => void;
  onShopToggle: () => void;
  onStreamToggle?: () => void;
  isStreaming?: boolean;
  hasActiveStream?: boolean;
}

const MobileBottomNav: React.FC<MobileBottomNavProps> = ({
  isAuthenticated,
  userPoints,
  showInventory,
  showChat,
  showShop,
  onInventoryToggle,
  onChatToggle,
  onShopToggle,
  onStreamToggle,
  isStreaming,
  hasActiveStream
}) => {
  // Use state for mobile detection to handle SSR
  const [isMobile, setIsMobile] = useState(false);
  
  useEffect(() => {
    const checkMobile = () => {
      const mobileCheck = window.innerWidth <= 768 || 
        /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
      setIsMobile(mobileCheck);
    };
    
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);
  
  // Don't render on desktop
  if (!isMobile) {
    return null;
  }

  return (
    <div className="mobile-bottom-nav">
      {/* Chat Button */}
      <button 
        className={`nav-item ${showChat ? 'active' : ''}`}
        onClick={onChatToggle}
      >
        <span className="nav-icon">💬</span>
        <span className="nav-label">Chat</span>
      </button>

      {/* Inventory Button - Always visible, disabled if not authenticated */}
      <button 
        className={`nav-item nav-inventory ${showInventory ? 'active' : ''} ${!isAuthenticated ? 'disabled' : ''}`}
        onClick={isAuthenticated ? onInventoryToggle : undefined}
        disabled={!isAuthenticated}
      >
        <span className="nav-icon nav-icon-large">🎒</span>
        <span className="nav-label">Backpack</span>
        {isAuthenticated && <span className="nav-badge">!</span>}
      </button>

      {/* Shop Button - Always visible, disabled if not authenticated */}
      <button 
        className={`nav-item ${showShop ? 'active' : ''} ${!isAuthenticated ? 'disabled' : ''}`}
        onClick={isAuthenticated ? onShopToggle : undefined}
        disabled={!isAuthenticated}
      >
        <span className="nav-icon">🛒</span>
        <span className="nav-label">Shop</span>
      </button>

      {/* Points Display or Login prompt */}
      <div className="nav-item nav-points">
        <span className="nav-icon">💎</span>
        <span className="nav-points-value">{isAuthenticated ? userPoints : '---'}</span>
      </div>
    </div>
  );
};

export default MobileBottomNav;