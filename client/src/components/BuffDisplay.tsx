import React, { useState, useEffect } from 'react';
import { useMainSocket } from '../contexts/SocketContext';
import './BuffDisplay.css';

interface BuffData {
  id: string;
  userId: string;
  itemId: string;
  itemName: string;
  displayName: string;
  emoji: string;
  buffType: 'buff' | 'debuff';
  durationSeconds: number;
  remainingSeconds: number;
  streamingTimeUsed: number;
  appliedAt: string;
  appliedByUserId: string;
  metadata?: any;
  effectData?: any;
}

interface BuffDisplayProps {
  userId?: string;
  showPersonalBuffs?: boolean;
  showStreamerBuffs?: boolean;
  className?: string;
  isCurrentUserStreaming?: boolean;
  currentUserId?: string;
  initialBuffs?: BuffData[];
}

const BuffDisplay: React.FC<BuffDisplayProps> = ({
  userId,
  showPersonalBuffs = false,
  showStreamerBuffs = false,
  className = '',
  isCurrentUserStreaming = false,
  currentUserId,
  initialBuffs = []
}) => {
  const [buffs, setBuffs] = useState<BuffData[]>(initialBuffs);
  const { socket, connected: isConnected, error: socketError } = useMainSocket();
  const [error, setError] = useState<string | null>(null);
  const [localBuffs, setLocalBuffs] = useState<BuffData[]>([]);
  const [updateTrigger, setUpdateTrigger] = useState(0); // Force re-render trigger

  // Handle socket error
  useEffect(() => {
    if (socketError) {
      setError(socketError);
    }
  }, [socketError]);

  useEffect(() => {
    if (!socket || !isConnected) return;

    
    // Request initial buff data
    if (showPersonalBuffs) {
      socket.emit('get-my-buffs');
    }
    if (showStreamerBuffs) {
      socket.emit('get-streamer-buffs');
      
      // Also request again after a short delay to ensure we get any active buffs
      // This handles race conditions where the server might not be ready immediately
      setTimeout(() => {
        socket.emit('get-streamer-buffs');
      }, 500);
    }

    // Listen for buff updates
    socket.on('my-buffs-update', (data: { buffs: BuffData[] }) => {
      if (showPersonalBuffs) {
        setBuffs(data.buffs);
      }
      // ALSO update the streamer buffs display if the current user is streaming
      // This ensures the public Status Effects updates for the streamer
      if (showStreamerBuffs && isCurrentUserStreaming) {
        setBuffs(data.buffs);
      }
    });

    // REMOVED: streamer-buffs-update listener - now handled via initialBuffs prop from App component
    // The App component listens for this event and passes the buffs down as a prop

    socket.on('user-buff-update', (data: { userId: string; buffs: BuffData[] }) => {
      
      // For personal buffs, only update if this is the current user's buffs
      if (showPersonalBuffs && currentUserId && data.userId.toString() === currentUserId.toString()) {
        setBuffs(data.buffs);
      }
      // For specific user display (not used currently)
      else if (userId && data.userId.toString() === userId.toString()) {
        setBuffs(data.buffs);
      }
      
      // For streamer buffs display, check if this update is for the current user who is streaming
      if (showStreamerBuffs && isCurrentUserStreaming && currentUserId && data.userId.toString() === currentUserId.toString()) {
        // The current user is streaming and this update is for them
        // Update the streamer buffs display directly
        setBuffs(data.buffs);
      } else if (showStreamerBuffs) {
        // For other users viewing, request fresh streamer buffs
        socket.emit('get-streamer-buffs');
      }
    });

    socket.on('buff-applied', (buffData: BuffData) => {
      // When a buff is applied, request fresh data to ensure the display is current
      
      // Request fresh data based on display type
      if (showPersonalBuffs) {
        // Update personal buffs if:
        // 1. The buff was applied to the current user
        // 2. OR the current user is streaming (they need to see buffs applied to them)
        if (currentUserId && buffData.userId && buffData.userId.toString() === currentUserId.toString()) {
          socket.emit('get-my-buffs');
        } else if (isCurrentUserStreaming) {
          // If current user is streaming, also request their buffs
          // This handles the case where a viewer applies a buff to the streamer
          socket.emit('get-my-buffs');
        }
      }
      
      if (showStreamerBuffs) {
        // Always refresh streamer buffs when any buff is applied
        // This ensures we catch buffs applied to the streamer
        
        // Immediately add the buff for real-time feedback for ALL viewers
        if (buffData && buffData.id) {
          setBuffs(prevBuffs => {
            // Check if this exact buff already exists to prevent duplicates
            const exists = prevBuffs.some(b => b.id === buffData.id);
            if (!exists) {
              return [...prevBuffs, buffData];
            }
            return prevBuffs;
          });
        }
      }
    });

    socket.on('buff-expired', (data: { buffId: string; userId: string; reason: string }) => {
      setBuffs(prev => prev.filter(buff => buff.id !== data.buffId));
    });

    socket.on('buff-error', (data: { error: string }) => {
      // Only show authentication errors for personal buffs if user is supposed to be authenticated
      if (data.error.includes('Authentication required') && showPersonalBuffs) {
        setError('Please sign in to view your buffs');
      } else if (!data.error.includes('Authentication required')) {
        setError(data.error);
      }
      // Don't show auth errors for streamer buffs since they should be public
      setTimeout(() => setError(null), 5000); // Clear error after 5 seconds
    });

    // Also listen for item-used events to catch when visual FX items are used
    socket.on('item-used', (data: any) => {
      
      // If an item was used that might create a buff, refresh the displays
      if (data.item && (data.item.itemType === 'buff' || data.item.itemType === 'debuff')) {
        if (showStreamerBuffs) {
          setTimeout(() => {
            socket.emit('get-streamer-buffs');
          }, 100); // Small delay to ensure buff is created in database
        }
        
        if (showPersonalBuffs) {
          // Update personal buffs if item was used on current user OR current user is streaming
          if (currentUserId && data.userId && data.userId.toString() === currentUserId.toString()) {
            setTimeout(() => {
              socket.emit('get-my-buffs');
            }, 100);
          } else if (isCurrentUserStreaming) {
            // If current user is streaming, refresh their personal buffs
            // This catches when viewers use items on the streamer
            setTimeout(() => {
              socket.emit('get-my-buffs');
            }, 200); // Slightly longer delay for streamer case
          }
        }
      }
    });

    // For streamer buff display, periodically request updates to ensure sync
    // This is a failsafe to catch any missed updates
    let refreshInterval: NodeJS.Timeout | null = null;
    if (showStreamerBuffs && isConnected) {
      refreshInterval = setInterval(() => {
        socket.emit('get-streamer-buffs');
      }, 3000); // Refresh every 3 seconds for better responsiveness
    }

    return () => {
      socket.off('my-buffs-update');
      // socket.off('streamer-buffs-update'); // Removed - handled by App component
      socket.off('user-buff-update');
      socket.off('buff-applied');
      socket.off('buff-expired');
      socket.off('buff-error');
      socket.off('item-used');
      if (refreshInterval) {
        clearInterval(refreshInterval);
      }
    };
  }, [socket, isConnected, userId, showPersonalBuffs, showStreamerBuffs, currentUserId, isCurrentUserStreaming]);

  // Update buffs when initialBuffs prop changes (from App component)
  // This is now the PRIMARY way streamer buffs are updated
  useEffect(() => {
    if (showStreamerBuffs) {
      const buffsToSet = initialBuffs || [];
      setBuffs(buffsToSet);
      setLocalBuffs(buffsToSet);
    }
  }, [initialBuffs, showStreamerBuffs]);

  // Fetch initial buffs on component mount when showing streamer buffs
  useEffect(() => {
    if (showStreamerBuffs && socket && (!initialBuffs || initialBuffs.length === 0)) {
      
      // Request current streamer buffs from server
      const fetchInitialBuffs = async () => {
        try {
          const response = await fetch('/api/buffs/streamer/current');
          if (response.ok) {
            const data = await response.json();
            if (data.buffs && Array.isArray(data.buffs)) {
              setBuffs(data.buffs);
            }
          }
        } catch (error) {
          console.error('Error fetching initial buffs:', error);
        }
      };
      
      fetchInitialBuffs();
    }
  }, [showStreamerBuffs, socket]);

  // Sync server buffs to local buffs for real-time countdown
  useEffect(() => {
    setLocalBuffs([...buffs]);
  }, [buffs]);

  // Light client-side countdown timer - only runs for the active streamer
  useEffect(() => {
    // Only tick down if:
    // 1. This is the personal buffs display (showPersonalBuffs)
    // 2. The current user is actively streaming (isCurrentUserStreaming)
    // OR
    // 3. This is the streamer buffs display (showStreamerBuffs) - always tick for public view
    const shouldTick = (showPersonalBuffs && isCurrentUserStreaming) || showStreamerBuffs;
    
    if (!shouldTick) {
      return;
    }

    
    const countdownInterval = setInterval(() => {
      setLocalBuffs(prevBuffs => {
        const updated = prevBuffs
          .map(buff => ({
            ...buff,
            remainingSeconds: Math.max(0, buff.remainingSeconds - 1)
          }))
          .filter(buff => buff.remainingSeconds > 0);
        
        if (prevBuffs.length !== updated.length) {
        }
        
        return updated;
      });
    }, 1000);

    return () => clearInterval(countdownInterval);
  }, [showPersonalBuffs, isCurrentUserStreaming, showStreamerBuffs]);

  const formatTimeRemaining = (seconds: number): string => {
    if (seconds <= 0) return '0s';
    
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    
    if (minutes > 0) {
      return `${minutes}m ${remainingSeconds}s`;
    }
    return `${remainingSeconds}s`;
  };

  const getBuffTypeClass = (buffType: string): string => {
    return buffType === 'buff' ? 'buff-positive' : 'buff-negative';
  };


  if (!isConnected) {
    return <div className={`buff-display ${className}`}>
      <div className="buff-status">Connecting...</div>
    </div>;
  }

  // Debug log at render
  if (showStreamerBuffs) {
  }

  return (
    <div className={`buff-display ${className}`}>
      {error && (
        <div className="buff-error">
          ⚠️ {error}
        </div>
      )}
      
      <div className="buff-header">
        {showPersonalBuffs && <h3>My Status Effects</h3>}
        {showStreamerBuffs && <h3>Status Effects</h3>}
        {userId && !showPersonalBuffs && !showStreamerBuffs && <h3>Status Effects</h3>}
      </div>

      <div className="buff-list">
        {localBuffs.length === 0 ? (
          <div className="no-buffs">No active effects</div>
        ) : (
          localBuffs.map((buff) => (
            <div 
              key={buff.id} 
              className={`buff-item ${getBuffTypeClass(buff.buffType)}`}
              title={`${buff.displayName}: ${buff.remainingSeconds}s remaining`}
            >
              <div className="buff-emoji">{buff.emoji}</div>
              <div className="buff-info">
                <div className="buff-name">{buff.displayName}</div>
                <div className="buff-timer">
                  {formatTimeRemaining(buff.remainingSeconds)}
                </div>
                <div className="buff-progress">
                  <div 
                    className="buff-progress-bar"
                    style={{
                      width: `${(buff.remainingSeconds / buff.durationSeconds) * 100}%`
                    }}
                  />
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {localBuffs.length > 0 && (
        <div className="buff-stats">
          <small>
            {localBuffs.filter(b => b.buffType === 'buff').length} buffs, {' '}
            {localBuffs.filter(b => b.buffType === 'debuff').length} debuffs
          </small>
        </div>
      )}
    </div>
  );
};

export default BuffDisplay;