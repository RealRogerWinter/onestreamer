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
  // State for login prompt overlay
  const [showLoginPrompt, setShowLoginPrompt] = useState<'backpack' | 'shop' | null>(null);

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

  const handleBackpackClick = () => {
    if (isAuthenticated) {
      onInventoryToggle();
    } else {
      setShowLoginPrompt('backpack');
    }
  };

  const handleShopClick = () => {
    if (isAuthenticated) {
      onShopToggle();
    } else {
      setShowLoginPrompt('shop');
    }
  };

  // Don't render on desktop
  if (!isMobile) {
    return null;
  }

  return (
    <>
      {/* Login Prompt Overlay */}
      {showLoginPrompt && (
        <div className="mobile-login-overlay" onClick={() => setShowLoginPrompt(null)}>
          <div className="mobile-login-prompt" onClick={e => e.stopPropagation()}>
            <button className="mobile-login-close" onClick={() => setShowLoginPrompt(null)}>×</button>
            <div className="mobile-login-icon">
              {showLoginPrompt === 'backpack' ? '🎒' : '🛒'}
            </div>
            <h3>{showLoginPrompt === 'backpack' ? 'Unlock Your Backpack!' : 'Welcome to the Shop!'}</h3>
            <p>
              {showLoginPrompt === 'backpack'
                ? 'Sign up or log in to collect items, use power-ups, and customize your experience!'
                : 'Sign up or log in to buy items, power-ups, and exclusive effects!'}
            </p>
            <div className="mobile-login-buttons">
              <a href="/login" className="mobile-auth-btn mobile-login-btn">Login</a>
              <a href="/signup" className="mobile-auth-btn mobile-signup-btn">Sign Up</a>
            </div>
          </div>
        </div>
      )}

      <div className="mobile-bottom-nav">
        {/* Chat Button */}
        <button
          className={`nav-item ${showChat ? 'active' : ''}`}
          onClick={onChatToggle}
        >
          <span className="nav-icon">💬</span>
          <span className="nav-label">Chat</span>
        </button>

        {/* Inventory Button - Shows login prompt for non-authenticated users */}
        <button
          className={`nav-item nav-inventory ${showInventory ? 'active' : ''}`}
          onClick={handleBackpackClick}
        >
          <span className="nav-icon nav-icon-large">🎒</span>
          <span className="nav-label">Backpack</span>
          {isAuthenticated && <span className="nav-badge">!</span>}
        </button>

        {/* Shop Button - Shows login prompt for non-authenticated users */}
        <button
          className={`nav-item ${showShop ? 'active' : ''}`}
          onClick={handleShopClick}
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
    </>
  );
};

export default MobileBottomNav;