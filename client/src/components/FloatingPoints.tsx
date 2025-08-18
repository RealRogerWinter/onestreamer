import React, { useEffect, useState } from 'react';
import './FloatingPoints.css';

interface FloatingPointsProps {
  amount: number;
  onAnimationComplete: () => void;
  targetPosition?: { x: number; y: number };
  source?: string; // 'viewing', 'streaming', or 'chatting'
}

interface FloatingPointsManagerProps {
  children: React.ReactNode;
}

interface PointsNotification {
  id: string;
  amount: number;
  timestamp: number;
  source?: string;
}

const FloatingPoints: React.FC<FloatingPointsProps> = ({ 
  amount, 
  onAnimationComplete,
  targetPosition,
  source = 'unknown'
}) => {
  const getSourceLabel = (source: string) => {
    switch (source) {
      case 'viewing': return 'Watching';
      case 'streaming': return 'Streaming';
      case 'chatting': return 'Chatting';
      case 'chat_bonus': return 'Bonus!';
      case 'general': return 'Points';
      default: return '';
    }
  };
  useEffect(() => {
    const timer = setTimeout(() => {
      onAnimationComplete();
    }, 2000); // Animation duration

    return () => clearTimeout(timer);
  }, [onAnimationComplete]);

  return (
    <div 
      className="floating-points"
      style={{
        '--target-x': targetPosition ? `${targetPosition.x}px` : '0px',
        '--target-y': targetPosition ? `${targetPosition.y}px` : '0px',
      } as React.CSSProperties}
    >
      <div className="points-amount">+{amount.toLocaleString()}</div>
      <div className="points-source">{getSourceLabel(source)}</div>
    </div>
  );
};

export const FloatingPointsManager: React.FC<FloatingPointsManagerProps> = ({ children }) => {
  const [notifications, setNotifications] = useState<PointsNotification[]>([]);
  const [pointsCounterPosition, setPointsCounterPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  useEffect(() => {
    // Find the points counter element and get its position
    const updatePosition = () => {
      const pointsCounter = document.querySelector('.points-counter');
      if (pointsCounter) {
        const rect = pointsCounter.getBoundingClientRect();
        setPointsCounterPosition({
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2
        });
      }
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    
    return () => window.removeEventListener('resize', updatePosition);
  }, []);

  // Expose method to add floating points
  useEffect(() => {
    let lastPointTime = 0;
    let lastPointAmount = 0;
    
    const showFloatingPoints = (amount: number, source?: string) => {
      const now = Date.now();
      
      // Debounce: ignore if same amount within 100ms (likely duplicate)
      if (now - lastPointTime < 100 && amount === lastPointAmount) {
        console.log('🚫 Ignoring duplicate floating point:', amount, source);
        return;
      }
      
      lastPointTime = now;
      lastPointAmount = amount;
      
      const id = `points-${now}-${Math.random()}`;
      setNotifications(prev => [...prev, { id, amount, source, timestamp: now }]);
    };

    // Make it available globally
    (window as any).showFloatingPoints = showFloatingPoints;

    return () => {
      delete (window as any).showFloatingPoints;
    };
  }, []);

  const removeNotification = (id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  };

  return (
    <>
      {children}
      <div className="floating-points-container">
        {notifications.map((notification) => (
          <FloatingPoints
            key={notification.id}
            amount={notification.amount}
            source={notification.source}
            targetPosition={pointsCounterPosition}
            onAnimationComplete={() => removeNotification(notification.id)}
          />
        ))}
      </div>
    </>
  );
};

export default FloatingPoints;