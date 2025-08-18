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
}

const BuffDisplay: React.FC<BuffDisplayProps> = ({
  userId,
  showPersonalBuffs = false,
  showStreamerBuffs = false,
  className = '',
  isCurrentUserStreaming = false,
  currentUserId
}) => {
  const [buffs, setBuffs] = useState<BuffData[]>([]);
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

    console.log('🎭 BUFF: Socket connected, requesting buff data', { 
      showPersonalBuffs, 
      showStreamerBuffs,
      isCurrentUserStreaming,
      currentUserId 
    });
    
    // Request initial buff data
    if (showPersonalBuffs) {
      console.log('🎭 BUFF: Requesting personal buffs');
      socket.emit('get-my-buffs');
    }
    if (showStreamerBuffs) {
      console.log('🎭 BUFF: Requesting streamer buffs');
      socket.emit('get-streamer-buffs');
    }

    // Listen for buff updates
    socket.on('my-buffs-update', (data: { buffs: BuffData[] }) => {
      console.log('🎭 BUFF: Received my-buffs-update', { 
        showPersonalBuffs, 
        showStreamerBuffs,
        buffCount: data.buffs.length,
        isCurrentUserStreaming 
      });
      if (showPersonalBuffs) {
        console.log('🎭 BUFF: Updating personal buffs from my-buffs-update');
        setBuffs(data.buffs);
      }
      // ALSO update the streamer buffs display if the current user is streaming
      // This ensures the public Status Effects updates for the streamer
      if (showStreamerBuffs && isCurrentUserStreaming) {
        console.log('🎭 BUFF: Current user is streaming, updating streamer buffs from my-buffs-update');
        setBuffs(data.buffs);
      }
    });

    socket.on('streamer-buffs-update', (data: { buffs: BuffData[] }) => {
      console.log('🎭 BUFF: Received streamer-buffs-update', { 
        showStreamerBuffs,
        showPersonalBuffs,
        isCurrentUserStreaming,
        buffCount: data.buffs ? data.buffs.length : 0,
        currentUserId
      });
      
      // ALWAYS update if this is the streamer buff display
      if (showStreamerBuffs) {
        const newBuffs = data.buffs || [];
        console.log('🎭 BUFF: UPDATING streamer display from streamer-buffs-update with', newBuffs.length, 'buffs');
        console.log('🎭 BUFF: New buffs data:', newBuffs);
        setBuffs(newBuffs);
        // Force a re-render to ensure UI updates
        setUpdateTrigger(prev => prev + 1);
      }
      
      // If this is the personal buff display AND the current user is streaming,
      // also update personal buffs when streamer buffs are updated
      // This ensures the streamer sees their own buffs in both displays
      if (showPersonalBuffs && isCurrentUserStreaming) {
        console.log('🎭 BUFF: Current user is streaming, updating personal buffs from streamer-buffs-update');
        setBuffs(data.buffs || []);
      }
    });

    socket.on('user-buff-update', (data: { userId: string; buffs: BuffData[] }) => {
      console.log('🎭 BUFF: Received user-buff-update', { 
        dataUserId: data.userId, 
        currentUserId, 
        showPersonalBuffs, 
        showStreamerBuffs,
        isCurrentUserStreaming,
        match: currentUserId && data.userId.toString() === currentUserId.toString()
      });
      
      // For personal buffs, only update if this is the current user's buffs
      if (showPersonalBuffs && currentUserId && data.userId.toString() === currentUserId.toString()) {
        console.log('🎭 BUFF: Updating personal buffs from user-buff-update', data);
        setBuffs(data.buffs);
      }
      // For specific user display (not used currently)
      else if (userId && data.userId.toString() === userId.toString()) {
        console.log('🎭 BUFF: Updating user-specific buffs from user-buff-update', data);
        setBuffs(data.buffs);
      }
      
      // For streamer buffs display, check if this update is for the current user who is streaming
      if (showStreamerBuffs && isCurrentUserStreaming && currentUserId && data.userId.toString() === currentUserId.toString()) {
        // The current user is streaming and this update is for them
        // Update the streamer buffs display directly
        console.log('🎭 BUFF: Current user is streaming and buff update is for them, updating streamer buffs display');
        setBuffs(data.buffs);
      } else if (showStreamerBuffs) {
        // For other users viewing, request fresh streamer buffs
        console.log('🎭 BUFF: Requesting fresh streamer buffs due to user-buff-update');
        socket.emit('get-streamer-buffs');
      }
    });

    socket.on('buff-applied', (buffData: BuffData) => {
      // When a buff is applied, request fresh data to ensure the display is current
      console.log('🎭 BUFF: buff-applied event received', {
        buffUserId: buffData.userId,
        currentUserId,
        isCurrentUserStreaming,
        showPersonalBuffs,
        showStreamerBuffs
      });
      
      // Request fresh data based on display type
      if (showPersonalBuffs) {
        // Update personal buffs if:
        // 1. The buff was applied to the current user
        // 2. OR the current user is streaming (they need to see buffs applied to them)
        if (currentUserId && buffData.userId && buffData.userId.toString() === currentUserId.toString()) {
          console.log('🎭 BUFF: Buff applied to current user, requesting personal buffs');
          socket.emit('get-my-buffs');
        } else if (isCurrentUserStreaming) {
          // If current user is streaming, also request their buffs
          // This handles the case where a viewer applies a buff to the streamer
          console.log('🎭 BUFF: Current user is streaming, requesting personal buffs');
          socket.emit('get-my-buffs');
        }
      }
      
      if (showStreamerBuffs) {
        // Always refresh streamer buffs when any buff is applied
        // This ensures we catch buffs applied to the streamer
        console.log('🎭 BUFF: Requesting fresh streamer buffs due to buff-applied');
        console.log('🎭 BUFF: Buff data:', buffData);
        
        // Immediately add the buff to the display while waiting for the server response
        if (buffData && buffData.userId) {
          // Check if this buff is for the streamer
          const tempBuff = {
            ...buffData,
            id: buffData.id || `temp-${Date.now()}`,
            remainingSeconds: buffData.remainingSeconds || buffData.durationSeconds || 60
          };
          
          setBuffs(prevBuffs => {
            // Check if buff already exists (avoid duplicates)
            const exists = prevBuffs.some(b => b.id === tempBuff.id);
            if (!exists) {
              console.log('🎭 BUFF: Temporarily adding buff to display:', tempBuff);
              return [...prevBuffs, tempBuff];
            }
            return prevBuffs;
          });
        }
        
        // Request fresh data from server to sync properly
        socket.emit('get-streamer-buffs');
      }
    });

    socket.on('buff-expired', (data: { buffId: string; userId: string; reason: string }) => {
      setBuffs(prev => prev.filter(buff => buff.id !== data.buffId));
    });

    socket.on('buff-error', (data: { error: string }) => {
      console.log('🎭 BUFF: Received error', data, { showPersonalBuffs, showStreamerBuffs });
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
      console.log('🎭 BUFF: item-used event received', {
        itemType: data.item?.itemType,
        userId: data.userId,
        currentUserId,
        isCurrentUserStreaming
      });
      
      // If an item was used that might create a buff, refresh the displays
      if (data.item && (data.item.itemType === 'buff' || data.item.itemType === 'debuff')) {
        if (showStreamerBuffs) {
          console.log('🎭 BUFF: Buff/debuff item used, refreshing streamer buffs');
          setTimeout(() => {
            socket.emit('get-streamer-buffs');
          }, 100); // Small delay to ensure buff is created in database
        }
        
        if (showPersonalBuffs) {
          // Update personal buffs if item was used on current user OR current user is streaming
          if (currentUserId && data.userId && data.userId.toString() === currentUserId.toString()) {
            console.log('🎭 BUFF: Buff/debuff item used on current user, refreshing personal buffs');
            setTimeout(() => {
              socket.emit('get-my-buffs');
            }, 100);
          } else if (isCurrentUserStreaming) {
            // If current user is streaming, refresh their personal buffs
            // This catches when viewers use items on the streamer
            console.log('🎭 BUFF: Current user is streaming, refreshing personal buffs after item use');
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
        console.log('🎭 BUFF: Periodic refresh of streamer buffs');
        socket.emit('get-streamer-buffs');
      }, 3000); // Refresh every 3 seconds for better responsiveness
    }

    return () => {
      socket.off('my-buffs-update');
      socket.off('streamer-buffs-update');
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
      console.log('🎭 BUFF: Client-side countdown disabled (not streaming or not streamer display)');
      return;
    }

    console.log('🎭 BUFF: Client-side countdown enabled', { showPersonalBuffs, isCurrentUserStreaming, showStreamerBuffs });
    
    const countdownInterval = setInterval(() => {
      setLocalBuffs(prevBuffs => {
        return prevBuffs
          .map(buff => ({
            ...buff,
            remainingSeconds: Math.max(0, buff.remainingSeconds - 1)
          }))
          .filter(buff => buff.remainingSeconds > 0);
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

  const removeBuff = (buffId: string) => {
    if (socket && showPersonalBuffs) {
      socket.emit('remove-my-buff', { buffId });
    }
  };

  if (!isConnected) {
    return <div className={`buff-display ${className}`}>
      <div className="buff-status">Connecting...</div>
    </div>;
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
              {showPersonalBuffs && (
                <button 
                  className="buff-remove"
                  onClick={() => removeBuff(buff.id)}
                  title="Remove effect"
                >
                  ✕
                </button>
              )}
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