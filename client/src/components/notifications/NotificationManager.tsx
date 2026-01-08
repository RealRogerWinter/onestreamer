import React, { useState, useCallback } from 'react';
import ItemNotification from './ItemNotification';

interface NotificationData {
  id: string;
  emoji: string;
  itemName: string;
  type: 'use' | 'purchase';
  quantity?: number;
}

interface NotificationManagerProps {
  children?: React.ReactNode;
}

const NotificationManager: React.FC<NotificationManagerProps> = ({ children }) => {
  const [notifications, setNotifications] = useState<NotificationData[]>([]);
  const [currentNotification, setCurrentNotification] = useState<NotificationData | null>(null);

  const showItemNotification = useCallback((data: Omit<NotificationData, 'id'>) => {
    const notification = {
      ...data,
      id: Date.now().toString()
    };

    setNotifications(prev => [...prev, notification]);
  }, []);

  const processNextNotification = useCallback(() => {
    setNotifications(prev => {
      if (prev.length === 0) {
        setCurrentNotification(null);
        return prev;
      }

      const [next, ...rest] = prev;
      setCurrentNotification(next);
      return rest;
    });
  }, []);

  const handleNotificationComplete = useCallback(() => {
    setCurrentNotification(null);
    // Process next notification after a brief delay
    setTimeout(processNextNotification, 200);
  }, [processNextNotification]);

  // Start processing notifications when a new one is added and no current notification
  React.useEffect(() => {
    if (!currentNotification && notifications.length > 0) {
      processNextNotification();
    }
  }, [currentNotification, notifications.length, processNextNotification]);

  // Expose the showItemNotification function globally
  React.useEffect(() => {
    (window as any).showItemNotification = showItemNotification;
    return () => {
      delete (window as any).showItemNotification;
    };
  }, [showItemNotification]);

  return (
    <>
      {children}
      {currentNotification && (
        <ItemNotification
          emoji={currentNotification.emoji}
          itemName={currentNotification.itemName}
          type={currentNotification.type}
          quantity={currentNotification.quantity}
          show={true}
          onComplete={handleNotificationComplete}
        />
      )}
    </>
  );
};

export default NotificationManager;