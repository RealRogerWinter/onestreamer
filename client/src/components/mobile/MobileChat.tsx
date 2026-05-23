import React, { useState, useRef, useEffect } from 'react';
import Chat from '../Chat';
import './MobileChat.css';

interface MobileChatProps {
  isOpen: boolean;
  onClose: () => void;
}

const MobileChat: React.FC<MobileChatProps> = ({ isOpen, onClose }) => {
  const [isDragging, setIsDragging] = useState(false);
  const [dragDistance, setDragDistance] = useState(0);
  const [isExpanded, setIsExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const startYRef = useRef<number>(0);
  const currentYRef = useRef<number>(0);
  const startHeightRef = useRef<number>(40); // Start at 40vh

  // Calculate max height that keeps chat below header
  // Header is 56px, bottom nav clearance is 76px, add 10px padding
  const getMaxHeightVh = () => {
    const headerHeight = 56;
    const bottomNavClearance = 76;
    const padding = 10;
    const viewportHeight = window.innerHeight;
    const maxHeightPx = viewportHeight - headerHeight - bottomNavClearance - padding;
    const maxHeightVh = (maxHeightPx / viewportHeight) * 100;
    return Math.min(85, maxHeightVh); // Cap at 85vh max
  };

  // Handle touch start
  const handleTouchStart = (e: React.TouchEvent) => {
    // Only allow dragging from the header area
    const target = e.target as HTMLElement;
    const isHeader = target.closest('.chat-header') || target.closest('.swipe-indicator');

    if (isHeader) {
      setIsDragging(true);
      startYRef.current = e.touches[0].clientY;
      currentYRef.current = e.touches[0].clientY;
      startHeightRef.current = isExpanded ? getMaxHeightVh() : 40; // Current height in vh

      // Prevent default to avoid scrolling
      if (containerRef.current) {
        containerRef.current.style.transition = 'none';
      }
    }
  };

  // Handle touch move
  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isDragging) return;

    e.preventDefault(); // Prevent scroll interference
    currentYRef.current = e.touches[0].clientY;
    const distance = currentYRef.current - startYRef.current;
    setDragDistance(distance);

    // Use requestAnimationFrame for smoother updates
    requestAnimationFrame(() => {
      const viewportHeight = window.innerHeight;
      const distanceInVh = (distance / viewportHeight) * 100;
      const maxHeight = getMaxHeightVh();
      const newHeight = Math.max(20, Math.min(maxHeight, startHeightRef.current - distanceInVh));

      if (containerRef.current) {
        containerRef.current.style.height = `${newHeight}vh`;

        // If dragging down past threshold from default position, prepare to close
        if (startHeightRef.current === 40 && distance > 100) {
          containerRef.current.style.transform = `translateY(${distance - 100}px)`;
        } else {
          containerRef.current.style.transform = '';
        }
      }
    });
  };

  // Handle touch end
  const handleTouchEnd = () => {
    if (!isDragging) return;

    setIsDragging(false);

    const distance = currentYRef.current - startYRef.current;
    const viewportHeight = window.innerHeight;
    const distanceInVh = (distance / viewportHeight) * 100;
    const currentHeight = startHeightRef.current - distanceInVh;
    const maxHeight = getMaxHeightVh();

    if (containerRef.current) {
      containerRef.current.style.transition = 'all 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94)';

      // Determine final state based on thresholds
      if (startHeightRef.current === 40 && distance > 100) {
        // Close if dragged down from default position
        containerRef.current.style.transform = 'translateY(100%)';
        containerRef.current.style.height = '40vh';
        setTimeout(() => {
          onClose();
          containerRef.current!.style.transform = '';
          setIsExpanded(false);
        }, 300);
      } else if (currentHeight > 60) {
        // Expand to max height if dragged up past 60vh
        containerRef.current.style.height = `${maxHeight}vh`;
        containerRef.current.style.transform = '';
        setIsExpanded(true);
      } else if (currentHeight < 30 && isExpanded) {
        // Collapse from expanded if dragged down below 30vh
        containerRef.current.style.height = '40vh';
        containerRef.current.style.transform = '';
        setIsExpanded(false);
      } else {
        // Snap back to previous state
        containerRef.current.style.height = isExpanded ? `${maxHeight}vh` : '40vh';
        containerRef.current.style.transform = '';
      }
    }

    setDragDistance(0);
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
      className={`mobile-chat-wrapper ${isOpen ? 'open' : ''} ${isExpanded ? 'expanded' : ''}`}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Swipe indicator */}
      <div className="swipe-indicator">
        <div className="swipe-handle"></div>
        {isExpanded && <div className="swipe-hint">Swipe down to minimize</div>}
        {!isExpanded && isOpen && <div className="swipe-hint">Swipe up to expand</div>}
      </div>
      
      {/* Chat component */}
      <Chat className="mobile-chat-content" />
    </div>
  );
};

export default MobileChat;