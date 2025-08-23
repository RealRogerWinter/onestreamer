import React, { useState, useRef, useEffect } from 'react';
import InventoryPanel from './inventory/InventoryPanel';
import { Socket } from 'socket.io-client';
import './MobileInventory.css';

interface MobileInventoryProps {
  socket: Socket | null;
  isAuthenticated: boolean;
  userProfile: { points: number };
  isOpen: boolean;
  onClose: () => void;
  onToggleShop: () => void;
}

const MobileInventory: React.FC<MobileInventoryProps> = ({ 
  socket, 
  isAuthenticated, 
  userProfile, 
  isOpen, 
  onClose,
  onToggleShop 
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const startYRef = useRef<number>(0);
  const currentYRef = useRef<number>(0);

  // Handle touch start
  const handleTouchStart = (e: React.TouchEvent) => {
    // Only allow dragging from the header area
    const target = e.target as HTMLElement;
    const isHeader = target.closest('.inventory-mobile-header') || target.closest('.swipe-indicator');
    
    if (isHeader) {
      setIsDragging(true);
      startYRef.current = e.touches[0].clientY;
      currentYRef.current = e.touches[0].clientY;
      
      // Prevent default to avoid scrolling
      if (containerRef.current) {
        containerRef.current.style.transition = 'none';
      }
    }
  };

  // Handle touch move
  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isDragging) return;

    currentYRef.current = e.touches[0].clientY;
    const distance = currentYRef.current - startYRef.current;
    
    // Only allow dragging down (positive distance)
    if (distance > 0) {
      // Apply transform to move the panel
      if (containerRef.current) {
        containerRef.current.style.transform = `translateY(${distance}px)`;
      }
    }
  };

  // Handle touch end
  const handleTouchEnd = () => {
    if (!isDragging) return;

    setIsDragging(false);
    
    const distance = currentYRef.current - startYRef.current;
    const threshold = 100; // Pixels to drag before closing

    if (containerRef.current) {
      containerRef.current.style.transition = 'transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94)';
      
      if (distance > threshold) {
        // Close the inventory
        containerRef.current.style.transform = 'translateY(100%)';
        setTimeout(() => {
          onClose();
          containerRef.current!.style.transform = '';
        }, 300);
      } else {
        // Snap back to open position
        containerRef.current.style.transform = 'translateY(0)';
      }
    }
  };

  // Reset position when opening
  useEffect(() => {
    if (isOpen && containerRef.current) {
      containerRef.current.style.transform = 'translateY(0)';
    }
  }, [isOpen]);

  return (
    <div 
      ref={containerRef}
      className={`mobile-inventory-wrapper ${isOpen ? 'open' : ''}`}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Swipe indicator */}
      <div className="swipe-indicator">
        <div className="swipe-handle"></div>
      </div>
      
      {/* Custom mobile header */}
      <div className="inventory-mobile-header">
        <h3>🎒 Inventory</h3>
        <button className="close-btn" onClick={onClose}>×</button>
      </div>
      
      {/* Inventory panel content */}
      <div className="mobile-inventory-content">
        <InventoryPanel
          socket={socket}
          isAuthenticated={isAuthenticated}
          userProfile={userProfile}
          isOpen={true} // Always render as open since wrapper controls visibility
          onToggle={() => {}} // No-op since mobile wrapper handles this
          onToggleShop={onToggleShop}
        />
      </div>
    </div>
  );
};

export default MobileInventory;