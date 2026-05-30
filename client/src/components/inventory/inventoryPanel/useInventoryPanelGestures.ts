import React, { useEffect, useRef, useState } from 'react';

interface UseInventoryPanelGesturesArgs {
  isMobile: boolean;
  isOpen: boolean;
  onToggle?: () => void;
}

/**
 * Mobile swipe-to-resize / swipe-to-close gesture handling for the inventory
 * panel. Owns the panel ref, drag state and the expanded flag. Behavior is
 * preserved verbatim from the original component.
 */
export function useInventoryPanelGestures({ isMobile, isOpen, onToggle }: UseInventoryPanelGesturesArgs) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const startYRef = useRef<number>(0);
  const startHeightRef = useRef<number>(0);
  const rafIdRef = useRef<number | null>(null);

  // Get max height in pixels (viewport height minus header)
  const getMaxHeight = () => window.innerHeight - 56;
  const getCollapsedHeight = () => Math.min(window.innerHeight * 0.4, 300); // 40vh or 300px max

  const handleTouchStart = (e: React.TouchEvent) => {
    const target = e.target as HTMLElement;
    // Allow dragging from header, swipe handle, or title row
    const isDragTarget = target.closest('.backpack-mobile-header') ||
                         target.closest('.inventory-header') ||
                         target.closest('.swipe-handle');

    if (isDragTarget && isOpen && panelRef.current) {
      setIsDragging(true);
      startYRef.current = e.touches[0].clientY;
      startHeightRef.current = panelRef.current.offsetHeight;
      panelRef.current.style.transition = 'none';
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isDragging || !panelRef.current) return;

    // Cancel any pending RAF to avoid frame buildup
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
    }

    const currentY = e.touches[0].clientY;
    const deltaY = startYRef.current - currentY; // Positive = dragging up (expanding)

    rafIdRef.current = requestAnimationFrame(() => {
      if (!panelRef.current) return;

      const newHeight = startHeightRef.current + deltaY;
      const maxHeight = getMaxHeight();
      const minHeight = 100; // Minimum height before closing

      // Clamp height between min and max
      const clampedHeight = Math.max(minHeight, Math.min(maxHeight, newHeight));
      panelRef.current.style.height = `${clampedHeight}px`;

      // If dragging down past minimum, start translating for close gesture
      if (newHeight < minHeight) {
        const translateY = minHeight - newHeight;
        panelRef.current.style.transform = `translateY(${translateY}px)`;
      } else {
        panelRef.current.style.transform = '';
      }
    });
  };

  const handleTouchEnd = () => {
    if (!isDragging || !panelRef.current) return;

    // Cancel any pending RAF
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }

    setIsDragging(false);

    const currentHeight = panelRef.current.offsetHeight;
    const maxHeight = getMaxHeight();
    const collapsedHeight = getCollapsedHeight();
    const midPoint = (maxHeight + collapsedHeight) / 2;

    // Re-enable transitions for snap animation
    panelRef.current.style.transition = 'height 0.3s ease-out, transform 0.3s ease-out';

    // Check if should close (dragged down significantly from collapsed state)
    const draggedDownToClose = currentHeight < 100 ||
      (startHeightRef.current <= collapsedHeight + 50 && currentHeight < collapsedHeight * 0.6);

    if (draggedDownToClose) {
      // Close the panel
      panelRef.current.style.transform = 'translateY(100%)';
      panelRef.current.style.height = `${collapsedHeight}px`;
      setTimeout(() => {
        if (onToggle) onToggle();
        if (panelRef.current) {
          panelRef.current.style.transform = '';
          setIsExpanded(false);
        }
      }, 300);
    } else if (currentHeight > midPoint) {
      // Snap to expanded
      panelRef.current.style.height = `${maxHeight}px`;
      panelRef.current.style.transform = '';
      setIsExpanded(true);
    } else {
      // Snap to collapsed
      panelRef.current.style.height = `${collapsedHeight}px`;
      panelRef.current.style.transform = '';
      setIsExpanded(false);
    }
  };

  useEffect(() => {
    if (isOpen && panelRef.current && isMobile) {
      // Only apply initial height and transform on mobile portrait
      const isPortrait = window.innerHeight > window.innerWidth;
      if (isPortrait) {
        panelRef.current.style.transform = 'translateY(0)';
        panelRef.current.style.height = `${getCollapsedHeight()}px`;
        panelRef.current.style.transition = 'none';
        setIsExpanded(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]); // isMobile won't change during component lifecycle

  return {
    panelRef,
    isExpanded,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  };
}
