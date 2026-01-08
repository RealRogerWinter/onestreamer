import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Socket } from 'socket.io-client';
import { EffectEngine } from '../../services/EffectEngine';
import { debug } from '../../utils/debugLogger';
import authService from '../../services/AuthService';
import './CanvasEffectOverlay.css';

interface EffectData {
  id: string;
  userId: string;
  itemId: string;
  itemName: string;
  displayName: string;
  emoji: string;
  type: string;
  duration: number;
  config: any;
  startTime: number;
  position: { x: number; y: number };
}

interface CanvasEffectOverlayProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  socket: Socket | null;
  isActive: boolean;
  className?: string;
}

const CanvasEffectOverlay: React.FC<CanvasEffectOverlayProps> = ({ 
  videoRef, 
  socket, 
  isActive,
  className = ''
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const effectEngineRef = useRef<EffectEngine | null>(null);
  const [effectCount, setEffectCount] = useState(0);
  const [debugMode, setDebugMode] = useState<boolean>(false); // Explicitly false by default
  const [selectedEffectType, setSelectedEffectType] = useState('splat');
  const [clickToThrowMode, setClickToThrowMode] = useState<{
    active: boolean;
    item: any;
    userId: string;
    username: string;
    streamId: string;
    interactionConfig?: any;
    interactionId?: string;
  } | null>(null);
  const [drawingMode, setDrawingMode] = useState<{
    active: boolean;
    item: any;
    userId: string;
    username: string;
    streamId: string;
    interactionConfig?: any;
    itemConsumed?: boolean;
    interactionId?: string;
  } | null>(null);

  // Log mount/unmount (verbose level)
  useEffect(() => {
    debug.canvas('Component mounted', { debugMode, clickToThrowMode }, 'verbose');
    return () => {
      debug.canvas('Component unmounting', undefined, 'verbose');
    };
  }, []);

  // Expose debug mode toggle to window for console access
  useEffect(() => {
    (window as any).toggleCanvasDebug = () => {
      setDebugMode(prev => {
        const newMode = !prev;
        debug.canvas(`Debug mode toggled: ${newMode}`, undefined, 'normal');
        return newMode;
      });
    };
    
    (window as any).enableCanvasDebug = () => {
      debug.canvas('Debug mode enabled', undefined, 'normal');
      setDebugMode(true);
    };
    
    (window as any).disableCanvasDebug = () => {
      debug.canvas('Debug mode disabled', undefined, 'normal');
      setDebugMode(false);
    };
    
    (window as any).getCanvasDebugState = () => {
      const state = { debugMode, hasEffectEngine: !!effectEngineRef.current, hasCanvas: !!canvasRef.current, hasVideo: !!videoRef?.current };
      debug.canvas('Debug state', state, 'normal');
      return state;
    };
    
    return () => {
      delete (window as any).toggleCanvasDebug;
      delete (window as any).enableCanvasDebug;
      delete (window as any).disableCanvasDebug;
      delete (window as any).getCanvasDebugState;
    };
  }, [debugMode]);
  const resizeTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Initialize effect engine
  useEffect(() => {
    // Only initialize if we're active and have both canvas and video elements
    if (!isActive) {
      debug.canvas('CanvasEffectOverlay not active, skipping initialization', undefined, 'verbose');
      return;
    }
    
    if (canvasRef.current && videoRef.current) {
      debug.canvas('Initializing EffectEngine', undefined, 'verbose');
      
      const video = videoRef.current as HTMLVideoElement;
      const canvas = canvasRef.current;
      
      // Initialize immediately - EffectEngine will handle sizing internally
      const initializeEngine = () => {
        debug.canvas('Creating EffectEngine', undefined, 'verbose');
        
        // Create new effect engine (it will handle video sizing internally)
        effectEngineRef.current = new EffectEngine(canvas, video);
        
        // Set socket if available
        if (socket) {
          effectEngineRef.current.setSocket(socket);
        }
        
        // Set up debug mode listener
        effectEngineRef.current.on('effectCountChange', (count: number) => {
          setEffectCount(count);
        });
      };
      
      // Initialize immediately
      initializeEngine();
      
      // Also listen for video events to update canvas size when video loads
      const onLoadedMetadata = () => {
        debug.canvas('Video metadata loaded', undefined, 'verbose');
        if (effectEngineRef.current) {
          effectEngineRef.current.handleResize();
        }
      };
      
      const onLoadedData = () => {
        debug.canvas('Video data loaded', undefined, 'verbose');
        if (effectEngineRef.current) {
          effectEngineRef.current.handleResize();
        }
      };
      
      // Add null check before adding event listeners
      if (video) {
        video.addEventListener('loadedmetadata', onLoadedMetadata);
        video.addEventListener('loadeddata', onLoadedData);
      }
      
      return () => {
        debug.canvas('Cleaning up EffectEngine', undefined, 'verbose');
        if (video) {
          video.removeEventListener('loadedmetadata', onLoadedMetadata);
          video.removeEventListener('loadeddata', onLoadedData);
        }
        
        if (effectEngineRef.current) {
          effectEngineRef.current.cleanup();
          effectEngineRef.current = null;
        }
      };
    }
  }, [videoRef, isActive, socket]);

  // Update socket on EffectEngine when it changes
  useEffect(() => {
    if (socket && effectEngineRef.current) {
      effectEngineRef.current.setSocket(socket);
    }
  }, [socket]);

  // Socket event handlers
  useEffect(() => {
    if (!socket) return;

    const handleEffectTrigger = (effect: EffectData) => {
      debug.canvas('Received effect trigger', effect, 'verbose');
      
      if (effectEngineRef.current) {
        effectEngineRef.current.triggerEffect(effect);
      } else {
        debug.warn('canvas', 'Effect engine not initialized, cannot trigger effect');
      }
    };

    const handleEffectComplete = (data: { effectId: string }) => {
      debug.canvas('Effect completed', data.effectId, 'verbose');
      
      if (effectEngineRef.current) {
        effectEngineRef.current.removeEffect(data.effectId);
      }
    };

    const handleEffectsSync = (data: { effects: EffectData[] }) => {
      debug.canvas(`Syncing ${data.effects.length} effects`, undefined, 'verbose');
      
      if (effectEngineRef.current && data.effects.length > 0) {
        // Clear existing effects and add synced ones
        effectEngineRef.current.clearAllEffects();
        
        data.effects.forEach(effect => {
          // Calculate remaining duration
          const elapsed = Date.now() - effect.startTime;
          const remaining = Math.max(0, effect.duration - elapsed);
          
          if (remaining > 0) {
            // Adjust effect duration to remaining time
            const adjustedEffect = {
              ...effect,
              duration: remaining
            };
            effectEngineRef.current!.triggerEffect(adjustedEffect);
          }
        });
      }
    };

    const handleEffectsClear = () => {
      debug.canvas('Clearing all effects', undefined, 'verbose');
      
      if (effectEngineRef.current) {
        effectEngineRef.current.clearAllEffects();
      }
    };

    const handleEffectCancelled = (data: { effectId: string; reason: string; itemName: string }) => {
      debug.canvas(`Effect cancelled: ${data.effectId} (${data.itemName}) - ${data.reason}`, data, 'verbose');
      
      if (effectEngineRef.current) {
        effectEngineRef.current.removeEffect(data.effectId);
      }
    };

    const handleBuffSyncedEffectsClear = () => {
      debug.canvas('Clearing all buff-synced effects', undefined, 'verbose');
      
      if (effectEngineRef.current) {
        // Clear all smoke bomb and other buff-synced effects
        effectEngineRef.current.clearEffectsByType(['smoke_bomb']);
      }
    };

    const handleForceClear = (data: { reason: string; effects?: string[]; forceComplete?: boolean }) => {
      debug.canvas(`Force clearing effects: ${data.reason}`, data, 'verbose');
      
      if (effectEngineRef.current) {
        if (data.effects && data.effects.length > 0) {
          // Clear specific effect types
          effectEngineRef.current.clearEffectsByType(data.effects);
        } else if (data.forceComplete) {
          // Clear all effects
          effectEngineRef.current.clearAllEffects();
        }
      }
    };

    const handleForceItemClear = (data: { itemName: string; reason: string; effectId: string }) => {
      debug.canvas(`Force clearing item effects: ${data.itemName} - ${data.reason}`, data, 'verbose');
      
      if (effectEngineRef.current) {
        // Clear all effects for this specific item type
        effectEngineRef.current.clearEffectsByType([data.itemName]);
        // Also remove the specific effect ID if provided
        if (data.effectId) {
          effectEngineRef.current.removeEffect(data.effectId);
        }
      }
    };

    const handleDrawingPathReceived = (data: { effectId: string; path: any }) => {
      debug.canvas('✏️ Received drawing path from remote client', data, 'verbose');
      
      if (effectEngineRef.current) {
        effectEngineRef.current.handleRemoteDrawingPath(data);
      }
    };

    const handleDrawingStartReceived = (data: { effectId: string; point: any; color: string; lineWidth: number }) => {
      debug.canvas('✏️ Received drawing start from remote client', data, 'verbose');
      
      if (effectEngineRef.current) {
        effectEngineRef.current.handleRemoteDrawingStart(data);
      }
    };

    const handleDrawingSegmentReceived = (data: { effectId: string; segment: any }) => {
      debug.canvas('✏️ Received real-time drawing segment from remote client', data, 'verbose');
      
      if (effectEngineRef.current) {
        effectEngineRef.current.handleRemoteDrawingSegment(data);
      }
    };

    const handleCanvasEffectMode = async (data: any) => {
      debug.canvas('🎮 MODE: Received canvas effect mode', data, 'normal');
      
      // Check if this component is active - prevents duplicate handling
      if (!isActive) {
        debug.canvas('🚫 MODE: Component not active, ignoring canvas effect mode', { isActive }, 'normal');
        return;
      }
      
      if (data.mode === 'click-to-throw' || data.mode === 'click-to-draw') {
        // Check if the current user is the one who activated the item
        try {
          const currentUser = authService.getUser();
          const currentUserId = currentUser?.id;
          
          debug.canvas('🔍 MODE: Checking user permissions', { 
            currentUserId, 
            eventUserId: data.userId, 
            isMatch: currentUserId === data.userId 
          }, 'normal');
          
          if (currentUserId !== data.userId) {
            debug.canvas(`🚫 MODE: ${data.mode} mode denied - not the activating user`, { 
              currentUserId, 
              eventUserId: data.userId 
            }, 'normal');
            return; // Don't activate interactive mode for other users
          }
          
          // Check if this interaction has already been claimed by another instance
          if (data.interactionId) {
            const claimedKey = `interaction-claimed-${data.interactionId}`;
            const alreadyClaimed = sessionStorage.getItem(claimedKey);
            
            if (alreadyClaimed) {
              debug.canvas(`🚫 MODE: Interaction ${data.interactionId} already claimed by another instance`, undefined, 'normal');
              return; // Don't activate if another instance is handling this
            }
            
            // Claim this interaction for this instance
            sessionStorage.setItem(claimedKey, 'true');
            
            // Clean up after 30 seconds to prevent memory leak
            setTimeout(() => {
              sessionStorage.removeItem(claimedKey);
            }, 30000);
            
            debug.canvas(`✅ MODE: Claimed interaction ${data.interactionId} for this instance`, undefined, 'normal');
          }
          
          const newMode = {
            active: true,
            item: data.item,
            userId: data.userId,
            username: data.username,
            streamId: data.streamId,
            interactionConfig: data.interactionConfig,
            interactionId: data.interactionId  // Store the unique interaction ID
          };
          
          if (data.mode === 'click-to-draw') {
            debug.canvas(`✏️ MODE: Activating click-to-draw for ${data.item?.displayName || data.item?.display_name || data.item?.name}`, { newMode, item: data.item }, 'normal');
            // Enable drawing mode to make canvas interactive
            setDrawingMode(newMode);
            
            // Immediately consume the item and trigger the effect for all viewers
            const consumeDrawingItem = async () => {
              try {
                const token = localStorage.getItem('auth_token');
                const response = await fetch('/api/inventory/drawing-start', {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({
                    item: data.item
                  })
                });
                
                if (response.ok) {
                  debug.canvas('✏️ MODE: Drawing item consumed successfully', undefined, 'normal');
                  // Mark as consumed to prevent double consumption
                  setDrawingMode(prev => prev ? { ...prev, itemConsumed: true } : null);
                }
              } catch (error) {
                debug.error('canvas', 'Failed to consume drawing item', error);
              }
            };
            
            consumeDrawingItem();
            
            // Disable drawing mode after draw duration (from server config)
            const drawDuration = data.interactionConfig?.drawDuration || 10000;
            setTimeout(() => {
              debug.canvas(`✏️ MODE: Disabling drawing mode after ${drawDuration}ms`, undefined, 'normal');
              setDrawingMode(null);
            }, drawDuration);
          } else {
            debug.canvas(`🎯 MODE: Activating click-to-throw for ${data.item?.displayName || data.item?.display_name || data.item?.name}`, { newMode, item: data.item }, 'normal');
            setClickToThrowMode(newMode);
          }
        } catch (error) {
          debug.error('canvas', `Failed to check user permissions for ${data.mode} mode`, error);
          return;
        }
      } else {
        debug.canvas('❌ MODE: Deactivating interactive mode', undefined, 'normal');
        setClickToThrowMode(null);
      }
    };

    // Register socket event listeners
    socket.on('canvas-effect-trigger', handleEffectTrigger);
    socket.on('canvas-effect-complete', handleEffectComplete);
    socket.on('canvas-effects-sync', handleEffectsSync);
    socket.on('canvas-effects-clear', handleEffectsClear);
    socket.on('canvas-effect-mode', handleCanvasEffectMode);
    socket.on('drawing-path-broadcast', handleDrawingPathReceived);
    socket.on('drawing-start-broadcast', handleDrawingStartReceived);
    socket.on('drawing-segment-broadcast', handleDrawingSegmentReceived);
    
    // New cleanup event handlers for smoke bomb takeover fix
    socket.on('canvas-effect-cancelled', handleEffectCancelled);
    socket.on('canvas-effects-clear-buff-synced', handleBuffSyncedEffectsClear);
    socket.on('canvas-effect-force-clear', handleForceClear);
    socket.on('canvas-effect-force-clear-item', handleForceItemClear);

    // Request initial sync
    socket.emit('request-effect-sync');

    return () => {
      socket.off('canvas-effect-trigger', handleEffectTrigger);
      socket.off('canvas-effect-complete', handleEffectComplete);
      socket.off('canvas-effects-sync', handleEffectsSync);
      socket.off('canvas-effects-clear', handleEffectsClear);
      socket.off('canvas-effect-mode', handleCanvasEffectMode);
      socket.off('drawing-path-broadcast', handleDrawingPathReceived);
      socket.off('drawing-start-broadcast', handleDrawingStartReceived);
      socket.off('drawing-segment-broadcast', handleDrawingSegmentReceived);
      
      // Clean up new event handlers
      socket.off('canvas-effect-cancelled', handleEffectCancelled);
      socket.off('canvas-effects-clear-buff-synced', handleBuffSyncedEffectsClear);
      socket.off('canvas-effect-force-clear', handleForceClear);
      socket.off('canvas-effect-force-clear-item', handleForceItemClear);
    };
  }, [socket, isActive]);

  // Handle canvas resize
  useEffect(() => {
    const handleResize = () => {
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current);
      }

      resizeTimeoutRef.current = setTimeout(() => {
        if (canvasRef.current) {
          const canvas = canvasRef.current;
          const container = canvas.parentElement;
          
          if (container) {
            // Match canvas size to its container
            const rect = container.getBoundingClientRect();
            debug.canvas('Resizing canvas to match container', {
              width: rect.width,
              height: rect.height,
              rect
            }, 'verbose');
            
            // Use container dimensions with fallback
            const width = rect.width > 0 ? rect.width : 800;
            const height = rect.height > 0 ? rect.height : 600;
            
            // Also check video dimensions if available
            if (videoRef.current) {
              const video = videoRef.current as HTMLVideoElement;
              debug.canvas('Video element dimensions check', {
                videoWidth: video.videoWidth,
                videoHeight: video.videoHeight,
                clientWidth: video.clientWidth,
                clientHeight: video.clientHeight,
                offsetWidth: video.offsetWidth,
                offsetHeight: video.offsetHeight
              }, 'verbose');
            }
            
            canvas.width = width;
            canvas.height = height;
            
            debug.canvas('Final canvas size', { width, height }, 'verbose');
            
            // Notify effect engine of resize
            if (effectEngineRef.current) {
              effectEngineRef.current.handleResize();
            }
          }
        }
      }, 250); // CPU Optimization: Increased from 100ms to reduce resize event processing
    };

    window.addEventListener('resize', handleResize);
    
    // Initial size setup
    handleResize();

    return () => {
      window.removeEventListener('resize', handleResize);
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current);
      }
    };
  }, [videoRef]);

  // Debug mode toggle (Ctrl+Alt+F) - Always active
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Use Ctrl+Alt+F (F for FX/Effects)
      if (e.ctrlKey && e.altKey && (e.key === 'F' || e.key === 'f' || e.code === 'KeyF')) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        setDebugMode(prev => {
          const newMode = !prev;
          debug.canvas(`Debug mode ${newMode ? 'enabled' : 'disabled'}`, undefined, 'normal');
          if (newMode) {
            debug.canvas('Debug mode enabled! Click to test effects. Press Ctrl+Alt+F to disable.', undefined, 'normal');
          }
          return newMode;
        });
      }
    };

    // Add event listener with capture to catch the event early
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
    // Note: This runs regardless of isActive to ensure debug mode is always accessible
  }, []);

  // Handle click-to-throw functionality
  const handleThrowClick = async (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!clickToThrowMode || !canvasRef.current) {
      return;
    }

    const rect = canvasRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;

    debug.canvas(`🎯 THROW: Click coords`, {
      clientX: e.clientX,
      clientY: e.clientY,
      rectLeft: rect.left,
      rectTop: rect.top,
      rectWidth: rect.width,
      rectHeight: rect.height,
      calculatedX: x,
      calculatedY: y,
      isValidX: !isNaN(x),
      isValidY: !isNaN(y)
    }, 'normal');

    if (isNaN(x) || isNaN(y)) {
      debug.canvas(`❌ THROW: Invalid coordinates - x: ${x}, y: ${y}`, { rect, clientX: e.clientX, clientY: e.clientY }, 'normal');
      return;
    }

    debug.canvas(`Throwing ${clickToThrowMode.item?.displayName || 'item'} at (${x.toFixed(2)}, ${y.toFixed(2)})`, undefined, 'normal');

    try {
      const token = localStorage.getItem('auth_token');
      const response = await fetch('/api/inventory/throw', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          x,
          y,
          item: clickToThrowMode.item,
          username: clickToThrowMode.username
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        
        // Check if this is a "no active stream" error
        if (errorData.requiresStream && errorData.message) {
          // Show specific message for no stream
          if ((window as any).showItemNotification) {
            (window as any).showItemNotification({
              emoji: '⏸️',
              itemName: errorData.message,
              type: 'error'
            });
          }
          // Deactivate click-to-throw mode since we can't use it
          setClickToThrowMode(null);
          return;
        }
        
        throw new Error(errorData.error || 'Failed to throw item');
      }

      const result = await response.json();
      debug.canvas('Item thrown successfully', result, 'verbose');

      // Update cooldown in UI if the item has one
      if (result.item && result.item.cooldown && (window as any).updateItemCooldown) {
        debug.canvas(`Updating cooldown for ${result.item.displayName}: ${result.item.cooldown}s`, undefined, 'normal');
        (window as any).updateItemCooldown({
          itemId: result.item.id,
          name: result.item.name,
          displayName: result.item.displayName,
          emoji: result.item.emoji,
          cooldown: result.item.cooldown
        });
      }

      // Deactivate click-to-throw mode after successful throw
      setClickToThrowMode(null);

      // No need for additional notification - the visual effect is enough feedback
    } catch (error: any) {
      debug.error('canvas', 'Error throwing item', error);
      
      // Show error notification (for non-stream errors)
      if ((window as any).showItemNotification) {
        (window as any).showItemNotification({
          emoji: '❌',
          itemName: error.message || `Failed to throw ${clickToThrowMode.item.displayName}`,
          type: 'error'
        });
      }
      
      // Deactivate mode on error
      setClickToThrowMode(null);
    }
  };

  // Handle canvas click for testing and click-to-throw functionality
  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    debug.canvas('🎯 CLICK: Canvas click handler triggered!', { 
      debugMode, 
      clickToThrowModeActive: clickToThrowMode?.active,
      clickToThrowMode,
      isCanvasInteractive,
      target: e.target,
      clientX: e.clientX,
      clientY: e.clientY
    }, 'normal');
    
    // CRITICAL: Early exit if neither debug mode, click-to-throw mode, nor drawing mode is active
    if (debugMode !== true && clickToThrowMode?.active !== true && drawingMode?.active !== true) {
      debug.canvas('🚫 CLICK: Blocked - neither debug, click-to-throw, nor drawing mode active', { debugMode, clickToThrowActive: clickToThrowMode?.active, drawingModeActive: drawingMode?.active }, 'normal');
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Handle click-to-throw mode first
    if (clickToThrowMode?.active === true) {
      debug.canvas('✅ CLICK: Calling handleThrowClick', undefined, 'normal');
      handleThrowClick(e);
      return;
    }

    // Handle drawing mode - item is already consumed when mode is activated
    if (drawingMode?.active === true) {
      debug.canvas('✅ CLICK: Drawing mode active, item already consumed', { itemConsumed: drawingMode.itemConsumed }, 'normal');
      // Drawing will be handled by the DrawingEffect's event listeners
      return;
    }

    // Only process debug clicks when debug mode is explicitly true
    if (debugMode !== true) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    
    debug.canvas('Processing debug click', undefined, 'verbose');

    if (!effectEngineRef.current || !canvasRef.current) {
      return;
    }

    const rect = canvasRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;

    debug.canvas(`Debug click at (${x.toFixed(2)}, ${y.toFixed(2)})`, { effectType: selectedEffectType }, 'verbose');

    // Create effect config based on selected type
    const getEffectConfig = () => {
      switch (selectedEffectType) {
        case 'confetti':
          return {
            particleCount: 50,
            colors: ['#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#feca57'],
            spread: 60
          };
        case 'particles':
          return {
            particleCount: 30,
            colors: ['#ff4444', '#44ff44', '#4444ff'],
            animation: 'sparkle'
          };
        case 'splat':
        default:
          return {
            color: '#ff4444',
            splashColor: '#cc0000',
            particles: 12,
            size: 'large',
            animation: 'splat',
            drip: true
          };
      }
    };

    const getEffectEmoji = () => {
      switch (selectedEffectType) {
        case 'confetti': return '🎉';
        case 'particles': return '✨';
        case 'splat': 
        default: return '🍅';
      }
    };

    // Trigger a test effect at click position
    const testEffect: EffectData = {
      id: `test_${Date.now()}`,
      userId: 'test',
      itemId: 'test',
      itemName: selectedEffectType,
      displayName: `Test ${selectedEffectType}`,
      emoji: getEffectEmoji(),
      type: selectedEffectType,
      duration: 3000,
      config: getEffectConfig(),
      startTime: Date.now(),
      position: { x, y }
    };

    try {
      effectEngineRef.current.triggerEffect(testEffect);
      debug.canvas('Test effect triggered', undefined, 'verbose');
    } catch (error) {
      debug.error('canvas', 'Error triggering effect', error);
    }
  }, [debugMode, clickToThrowMode, effectEngineRef, canvasRef, handleThrowClick, selectedEffectType]);

  // Determine if canvas should be interactive
  const isCanvasInteractive = debugMode || clickToThrowMode?.active || drawingMode?.active;
  
  // Log state changes for debugging (verbose)
  useEffect(() => {
    debug.canvas('🎨 CANVAS: Interactive state changed', { 
      isCanvasInteractive, 
      debugMode, 
      clickToThrowModeActive: clickToThrowMode?.active,
      drawingMode,
      clickToThrowMode,
      hasCanvas: !!canvasRef.current,
      canvasStyle: canvasRef.current?.style.cssText
    }, 'normal');
  }, [isCanvasInteractive, debugMode, clickToThrowMode, drawingMode]);

  // Add global click listener for debugging
  useEffect(() => {
    const handleGlobalClick = (e: MouseEvent) => {
      debug.canvas('🌍 GLOBAL: Click detected', { 
        target: e.target,
        tagName: (e.target as Element)?.tagName,
        className: (e.target as Element)?.className,
        isCanvas: (e.target as Element)?.tagName === 'CANVAS',
        clientX: e.clientX,
        clientY: e.clientY,
        clickToThrowActive: clickToThrowMode?.active,
        debugMode
      }, 'normal');
    };

    document.addEventListener('click', handleGlobalClick, true);
    return () => document.removeEventListener('click', handleGlobalClick, true);
  }, [clickToThrowMode, debugMode]);

  // Add direct event listener to canvas ref to bypass React issues
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleDirectClick = (e: MouseEvent) => {
      debug.canvas('🎯 DIRECT: Canvas direct click handler triggered!', { 
        debugMode, 
        clickToThrowModeActive: clickToThrowMode?.active,
        target: e.target,
        clientX: e.clientX,
        clientY: e.clientY,
        canvasPointerEvents: canvas.style.pointerEvents
      }, 'normal');

      // Only handle clicks when interactive
      if (!isCanvasInteractive) {
        debug.canvas('🚫 DIRECT: Click blocked - canvas not interactive', undefined, 'normal');
        return;
      }

      // Convert to React-like event for consistency with existing handler
      const syntheticEvent = {
        clientX: e.clientX,
        clientY: e.clientY,
        currentTarget: canvas,
        target: canvas,
        preventDefault: () => e.preventDefault(),
        stopPropagation: () => e.stopPropagation(),
        nativeEvent: e,
        // Add required properties to satisfy TypeScript
        altKey: e.altKey,
        button: e.button,
        buttons: e.buttons,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
        detail: e.detail,
        screenX: e.screenX,
        screenY: e.screenY,
        pageX: e.pageX,
        pageY: e.pageY,
        movementX: e.movementX,
        movementY: e.movementY,
        relatedTarget: e.relatedTarget,
        getModifierState: (key: string) => e.getModifierState(key)
      } as unknown as React.MouseEvent<HTMLCanvasElement>;

      debug.canvas('🔧 DIRECT: Event conversion', { 
        originalClientX: e.clientX, 
        originalClientY: e.clientY,
        syntheticClientX: syntheticEvent.clientX,
        syntheticClientY: syntheticEvent.clientY 
      }, 'normal');

      // Call the existing handler
      handleCanvasClick(syntheticEvent);
    };

    // Force pointer events when interactive
    if (isCanvasInteractive) {
      canvas.style.pointerEvents = 'auto';
      debug.canvas('🔧 DIRECT: Forced canvas pointer events to auto', undefined, 'normal');
    } else {
      canvas.style.pointerEvents = 'none';
    }

    canvas.addEventListener('click', handleDirectClick);
    
    return () => {
      canvas.removeEventListener('click', handleDirectClick);
    };
  }, [isCanvasInteractive, clickToThrowMode, debugMode, handleCanvasClick]);

  // Don't render anything if not active (no stream)
  if (!isActive) {
    return null;
  }

  // Check if we're in theatre mode
  const isTheatreMode = document.body.classList.contains('theatre-mode') || 
                        document.querySelector('.App.theatre-mode') !== null;

  return (
    <div className={`canvas-effect-overlay-container ${className}`} style={{
      pointerEvents: isCanvasInteractive ? 'auto' : 'none',
      // Force z-index when interactive in theatre mode
      ...(isTheatreMode && isCanvasInteractive ? {
        zIndex: 250,
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0
      } : {})
    }}>
      <canvas
        ref={canvasRef}
        className="effect-overlay-canvas"
        // onClick handler removed - using direct addEventListener instead to avoid double calls
        onMouseMove={undefined}
        onMouseEnter={undefined}
        onMouseLeave={undefined}
        style={{
          cursor: drawingMode 
            ? 'crosshair'
            : (clickToThrowMode?.active 
              ? (clickToThrowMode.interactionConfig?.cursor || 'crosshair') 
              : (debugMode ? 'crosshair' : 'default')),
          pointerEvents: isCanvasInteractive ? 'auto' : 'none',
          border: clickToThrowMode?.active 
            ? `3px solid ${clickToThrowMode.interactionConfig?.borderColor || 'rgba(255, 0, 0, 0.8)'}` 
            : (debugMode ? '2px dashed rgba(0, 255, 0, 0.5)' : 'none'),
          boxSizing: 'border-box',
          backgroundColor: 'transparent',
          background: 'transparent',
          boxShadow: clickToThrowMode?.active 
            ? `0 0 10px ${clickToThrowMode.interactionConfig?.glowColor || 'rgba(255, 0, 0, 0.5)'}` 
            : 'none',
          // Force z-index when interactive in theatre mode
          ...(isTheatreMode && isCanvasInteractive ? {
            zIndex: 251,
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%'
          } : {})
        }}
      />
      
      {/* Debug info overlay - Only show when debug mode is active */}
      {debugMode && (
        <div className="canvas-debug-info">
          <div className="debug-panel">
          <h4>🎨 Canvas FX Debug Mode</h4>
          <p>Status: <span style={{color: '#00ff00'}}>DEBUG ACTIVE</span></p>
          <p>Active Effects: {effectCount}</p>
          <p>Debug Mode: {debugMode ? 'ON' : 'OFF'}</p>
          <p>Canvas Size: {canvasRef.current?.width || 0}x{canvasRef.current?.height || 0}</p>
          
          <div style={{ margin: '8px 0' }}>
            <label style={{ color: '#00ff00', fontSize: '10px', display: 'block', marginBottom: '4px' }}>
              Effect Type:
            </label>
            <select 
              value={selectedEffectType}
              onChange={(e) => setSelectedEffectType(e.target.value)}
              style={{
                background: '#000',
                color: '#00ff00',
                border: '1px solid #00ff00',
                fontSize: '10px',
                padding: '2px 4px',
                width: '100%',
                borderRadius: '2px'
              }}
            >
              <option value="splat">🍅 Tomato Splat</option>
              <option value="confetti">🎉 Confetti Burst</option>
              <option value="particles">✨ Particle Sparkle</option>
            </select>
          </div>
          
          <p>Click canvas or use buttons below</p>
          <p>Press <kbd>Ctrl+Alt+F</kbd> to toggle</p>
          <button 
            style={{
              background: '#00ff00',
              color: '#000',
              border: 'none',
              padding: '4px 8px',
              margin: '4px 0 4px 0',
              cursor: 'pointer',
              fontSize: '10px',
              display: 'block',
              width: '100%'
            }}
            onClick={() => {
              if (effectEngineRef.current && canvasRef.current) {
                // Create effect config based on selected type
                const getEffectConfig = () => {
                  switch (selectedEffectType) {
                    case 'confetti':
                      return {
                        particleCount: 50,
                        colors: ['#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#feca57'],
                        spread: 60
                      };
                    case 'particles':
                      return {
                        particleCount: 30,
                        colors: ['#ff4444', '#44ff44', '#4444ff'],
                        animation: 'sparkle'
                      };
                    case 'splat':
                    default:
                      return {
                        color: '#ff4444',
                        splashColor: '#cc0000',
                        particles: 12,
                        size: 'large',
                        animation: 'splat',
                        drip: true
                      };
                  }
                };

                const getEffectEmoji = () => {
                  switch (selectedEffectType) {
                    case 'confetti': return '🎉';
                    case 'particles': return '✨';
                    case 'splat': 
                    default: return '🍅';
                  }
                };
                
                const testEffect: EffectData = {
                  id: `button_test_${Date.now()}`,
                  userId: 'test',
                  itemId: 'test',
                  itemName: selectedEffectType,
                  displayName: `Button Test ${selectedEffectType}`,
                  emoji: getEffectEmoji(),
                  type: selectedEffectType,
                  duration: 3000,
                  config: getEffectConfig(),
                  startTime: Date.now(),
                  position: { x: 0.5, y: 0.5 } // Center of canvas
                };
                try {
                  effectEngineRef.current.triggerEffect(testEffect);
                } catch (error) {
                  debug.error('canvas', 'Error triggering button effect', error);
                }
              }
            }}
          >
            Test Center {selectedEffectType === 'confetti' ? '🎉' : selectedEffectType === 'particles' ? '✨' : '🍅'}
          </button>
          <button 
            style={{
              background: '#ff4444',
              color: '#fff',
              border: 'none',
              padding: '4px 8px',
              margin: '4px 0',
              cursor: 'pointer',
              fontSize: '10px',
              display: 'block',
              width: '100%'
            }}
            onClick={() => {
              if (effectEngineRef.current && canvasRef.current) {
                // Create effect config based on selected type
                const getEffectConfig = () => {
                  switch (selectedEffectType) {
                    case 'confetti':
                      return {
                        particleCount: 50,
                        colors: ['#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#feca57'],
                        spread: 60
                      };
                    case 'particles':
                      return {
                        particleCount: 30,
                        colors: ['#ff4444', '#44ff44', '#4444ff'],
                        animation: 'sparkle'
                      };
                    case 'splat':
                    default:
                      return {
                        color: '#ff4444',
                        splashColor: '#cc0000',
                        particles: 12,
                        size: 'large',
                        animation: 'splat',
                        drip: true
                      };
                  }
                };

                const getEffectEmoji = () => {
                  switch (selectedEffectType) {
                    case 'confetti': return '🎉';
                    case 'particles': return '✨';
                    case 'splat': 
                    default: return '🍅';
                  }
                };
                
                const testEffect: EffectData = {
                  id: `corner_test_${Date.now()}`,
                  userId: 'test',
                  itemId: 'test',
                  itemName: selectedEffectType,
                  displayName: `Corner Test ${selectedEffectType}`,
                  emoji: getEffectEmoji(),
                  type: selectedEffectType,
                  duration: 3000,
                  config: getEffectConfig(),
                  startTime: Date.now(),
                  position: { x: 0.1, y: 0.1 } // Top-left corner area
                };
                effectEngineRef.current.triggerEffect(testEffect);
              }
            }}
          >
            Test Corner {selectedEffectType === 'confetti' ? '🎉' : selectedEffectType === 'particles' ? '✨' : '🍅'}
          </button>
          </div>
        </div>
      )}
      
      {/* Click-to-throw mode indicator */}
      {clickToThrowMode?.active && (
        <div className="click-to-throw-indicator" style={{
          position: 'absolute',
          top: '10px',
          left: '50%',
          transform: 'translateX(-50%)',
          background: clickToThrowMode.interactionConfig?.borderColor?.replace('0.8)', '0.9)') || 'rgba(255, 0, 0, 0.9)',
          color: 'white',
          padding: '8px 16px',
          borderRadius: '20px',
          fontSize: '14px',
          fontWeight: 'bold',
          zIndex: 1000,
          animation: 'pulse 2s infinite',
          border: '2px solid rgba(255, 255, 255, 0.8)',
          boxShadow: '0 2px 10px rgba(0, 0, 0, 0.3)'
        }}>
          {clickToThrowMode.interactionConfig?.indicator || `🍅 Click anywhere to throw ${clickToThrowMode.item.displayName}!`}
          <div style={{
            fontSize: '10px',
            opacity: 0.8,
            marginTop: '2px'
          }}>
            Click anywhere on the stream to throw
          </div>
        </div>
      )}
      
      {/* Drawing mode indicator */}
      {drawingMode?.active && (
        <div className="click-to-draw-indicator" style={{
          position: 'absolute',
          top: '10px',
          left: '50%',
          transform: 'translateX(-50%)',
          background: drawingMode.interactionConfig?.borderColor?.replace('0.8)', '0.9)') || 'rgba(0, 100, 255, 0.9)',
          color: 'white',
          padding: '8px 16px',
          borderRadius: '20px',
          fontSize: '14px',
          fontWeight: 'bold',
          zIndex: 1000,
          animation: 'pulse 2s infinite',
          border: '2px solid rgba(255, 255, 255, 0.8)',
          boxShadow: '0 2px 10px rgba(0, 0, 0, 0.3)'
        }}>
          {drawingMode.item.emoji} {drawingMode.itemConsumed ? 'Drawing with' : 'Click to start drawing with'} {drawingMode.item.displayName || drawingMode.item.display_name}!
          <div style={{
            fontSize: '10px',
            opacity: 0.8,
            marginTop: '2px'
          }}>
            {drawingMode.itemConsumed ? 'Draw on the stream' : 'Click anywhere to start drawing'}
          </div>
        </div>
      )}
    </div>
  );
};

export default CanvasEffectOverlay;