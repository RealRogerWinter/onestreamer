import { useEffect, useRef } from 'react';
import { Socket } from 'socket.io-client';

/**
 * Custom hook for integrating Visual FX processor with video elements
 * Handles both streamer preview and viewer video effects
 */
export const useVisualFxProcessor = (
  videoRef: React.RefObject<HTMLVideoElement | null>,
  socket: Socket | null,
  isStreamer: boolean = false
) => {
  const processorRef = useRef<any>(null);
  const isInitializedRef = useRef(false);

  useEffect(() => {
    if (!videoRef.current || !socket || isInitializedRef.current) {
      return;
    }

    const initializeProcessor = () => {
      // Load ClientVisualFxProcessor if not available
      if (typeof (window as any).ClientVisualFxProcessor === 'undefined') {
        console.log('🎨 VISUAL FX HOOK: Loading ClientVisualFxProcessor...');
        const script = document.createElement('script');
        script.src = '/ClientVisualFxProcessor.js';
        script.onload = () => {
          createProcessor();
        };
        script.onerror = () => {
          console.error('❌ VISUAL FX HOOK: Failed to load ClientVisualFxProcessor');
        };
        document.head.appendChild(script);
      } else {
        createProcessor();
      }
    };

    const createProcessor = () => {
      if (!videoRef.current) {
        console.warn('⚠️ VISUAL FX HOOK: No video element available for processor initialization');
        return;
      }

      try {
        const ClientVisualFxProcessor = (window as any).ClientVisualFxProcessor;
        if (!ClientVisualFxProcessor) {
          console.error('❌ VISUAL FX HOOK: ClientVisualFxProcessor not available on window');
          return;
        }
        
        console.log(`🎨 VISUAL FX HOOK: Creating ClientVisualFxProcessor for ${isStreamer ? 'streamer' : 'viewer'}`);
        processorRef.current = new ClientVisualFxProcessor();
        
        const success = processorRef.current.initialize(videoRef.current);
        console.log(`🎨 VISUAL FX HOOK: Processor initialization result: ${success}`);
        
        if (success) {
          isInitializedRef.current = true;
          console.log(`✅ VISUAL FX HOOK: Processor initialized successfully for ${isStreamer ? 'streamer' : 'viewer'}`);
          console.log(`🎨 VISUAL FX HOOK: Video element:`, videoRef.current);
          
          // Set up socket event listeners for visual effects
          setupSocketListeners();
        } else {
          console.error(`❌ VISUAL FX HOOK: Processor initialization failed for ${isStreamer ? 'streamer' : 'viewer'}`);
        }
      } catch (error) {
        console.error('❌ VISUAL FX HOOK: Failed to initialize processor:', error);
      }
    };

    const setupSocketListeners = () => {
      if (!socket || !processorRef.current) return;

      const handleVisualEffectApplied = (data: any) => {
        console.log(`🎨 VISUAL FX HOOK: Received visual-effect-applied event:`, data);
        console.log(`🎨 VISUAL FX HOOK: Processor available: ${!!processorRef.current}, isStreamer: ${isStreamer}`);
        
        const { effectId, duration, applyToStreamer, isStreamerPreview, applyToAllViewers, isSyncEvent } = data;
        
        // Apply effect if:
        // 1. This is a viewer (always apply)
        // 2. This is a streamer and the effect should apply to streamer
        // 3. applyToAllViewers is true (for effects that should affect everyone)
        const shouldApply = !isStreamer || (isStreamer && applyToStreamer) || applyToAllViewers;
        
        console.log(`🎨 VISUAL FX HOOK: Effect application decision - isStreamer: ${isStreamer}, applyToStreamer: ${applyToStreamer}, applyToAllViewers: ${applyToAllViewers}, shouldApply: ${shouldApply}, isSyncEvent: ${isSyncEvent}`);
        
        if (shouldApply && processorRef.current) {
          console.log(`🎨 VISUAL FX HOOK: Applying effect ${effectId} to ${isStreamer ? 'streamer preview' : 'viewer'} via ClientVisualFxProcessor`);
          
          const result = processorRef.current.applyEffect(effectId, {
            duration: duration,
            isStreamer: isStreamer,
            isStreamerPreview: isStreamerPreview || false,
            applyToAllViewers: applyToAllViewers || false,
            isSyncEvent: isSyncEvent || false
          });
          
          console.log(`🎨 VISUAL FX HOOK: ClientVisualFxProcessor.applyEffect result:`, result);
        } else {
          console.log(`🎨 VISUAL FX HOOK: NOT applying effect - shouldApply: ${shouldApply}, processor: ${!!processorRef.current}`);
          if (!processorRef.current) {
            console.error(`❌ VISUAL FX HOOK: ClientVisualFxProcessor not initialized! Video element ready: ${!!videoRef.current}`);
          }
        }
      };

      const handleVisualEffectRemoved = (data: any) => {
        const { effectInstanceId, effectId, applyToAllViewers } = data;
        
        // Apply removal if:
        // 1. This is a viewer (always apply)
        // 2. This is a streamer and the effect should apply to streamer  
        // 3. applyToAllViewers is true (for effects that should affect everyone)
        const shouldRemove = !isStreamer || applyToAllViewers;
        
        console.log(`🎨 VISUAL FX HOOK: Effect removal decision - isStreamer: ${isStreamer}, applyToAllViewers: ${applyToAllViewers}, shouldRemove: ${shouldRemove}`);
        
        if (shouldRemove && processorRef.current) {
          // Remove only the specific effect, not all effects
          console.log(`🎨 VISUAL FX HOOK: Removing effect ${effectId} from ${isStreamer ? 'streamer' : 'viewer'}`);
          if (processorRef.current.removeEffect) {
            processorRef.current.removeEffect(effectId);
          } else {
            // Fallback if removeEffect doesn't exist
            console.warn(`🎨 VISUAL FX HOOK: removeEffect not available, clearing all effects`);
            processorRef.current.clearAllEffects();
          }
        }
      };

      const handleVisualEffectsCleared = () => {
        if (processorRef.current) {
          console.log(`🎨 VISUAL FX HOOK: Clearing all effects on ${isStreamer ? 'streamer' : 'viewer'}`);
          processorRef.current.clearAllEffects();
        }
      };

      // Add event listeners
      console.log(`🎨 VISUAL FX HOOK: Setting up socket listeners for ${isStreamer ? 'streamer' : 'viewer'}`, socket.id);
      socket.on('visual-effect-applied', handleVisualEffectApplied);
      socket.on('visual-effect-removed', handleVisualEffectRemoved);
      socket.on('visual-effects-cleared', handleVisualEffectsCleared);

      // Cleanup function for socket listeners
      return () => {
        socket.off('visual-effect-applied', handleVisualEffectApplied);
        socket.off('visual-effect-removed', handleVisualEffectRemoved);
        socket.off('visual-effects-cleared', handleVisualEffectsCleared);
      };
    };

    // Initialize after a short delay to ensure video element is ready
    const initTimeout = setTimeout(() => {
      if (videoRef.current && videoRef.current.videoWidth > 0) {
        initializeProcessor();
      } else {
        // If video isn't ready, wait for loadedmetadata event
        const video = videoRef.current;
        if (video) {
          const handleLoadedMetadata = () => {
            initializeProcessor();
            video.removeEventListener('loadedmetadata', handleLoadedMetadata);
          };
          video.addEventListener('loadedmetadata', handleLoadedMetadata);
        }
      }
    }, 1000);

    return () => {
      clearTimeout(initTimeout);
      if (processorRef.current) {
        processorRef.current.clearAllEffects();
      }
    };
  }, [videoRef, socket, isStreamer]);

  return {
    processor: processorRef.current,
    applyEffect: (effectId: string, options: any = {}) => {
      if (processorRef.current) {
        return processorRef.current.applyEffect(effectId, options);
      }
      return false;
    },
    clearAllEffects: () => {
      if (processorRef.current) {
        processorRef.current.clearAllEffects();
      }
    },
    getStats: () => {
      if (processorRef.current) {
        return processorRef.current.getStats();
      }
      return null;
    }
  };
};