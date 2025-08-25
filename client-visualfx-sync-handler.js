// Client-side handler for visual effects synchronization
// Add this to your React component or visual effects processor

class VisualEffectsSyncHandler {
  constructor(socket, visualFxProcessor) {
    this.socket = socket;
    this.processor = visualFxProcessor;
    this.appliedEffects = new Map(); // Track applied effects to avoid duplicates
    
    this.setupEventHandlers();
  }
  
  setupEventHandlers() {
    // Handle individual effect sync (when joining as viewer)
    this.socket.on('visual-effect-sync', (data) => {
      console.log('🎨 VISUAL FX SYNC: Received effect sync:', data);
      
      if (data.isSyncEvent && this.processor) {
        // Apply the effect if not already applied
        const effectKey = `${data.effectId}_sync`;
        if (!this.appliedEffects.has(effectKey)) {
          this.processor.applyEffect(data.effectId, {
            duration: data.duration,
            effectData: data.effectData
          });
          this.appliedEffects.set(effectKey, Date.now());
          
          // Remove from tracking after duration expires
          setTimeout(() => {
            this.appliedEffects.delete(effectKey);
          }, data.duration);
        }
      }
    });
    
    // Handle bulk visual effects state (with stream-ready)
    this.socket.on('visual-effects-state', (data) => {
      console.log('🎨 VISUAL FX STATE: Received bulk effects state:', data);
      
      if (data.effects && this.processor) {
        // Clear existing effects and apply all current ones
        this.processor.clearAllEffects();
        this.appliedEffects.clear();
        
        // Apply each effect with proper timing
        data.effects.forEach((effect, index) => {
          setTimeout(() => {
            const duration = effect.remainingSeconds * 1000;
            this.processor.applyEffect(effect.effectId, {
              duration: duration,
              effectData: effect.effectData
            });
            
            const effectKey = `${effect.effectId}_state`;
            this.appliedEffects.set(effectKey, Date.now());
            
            // Remove from tracking after duration expires
            setTimeout(() => {
              this.appliedEffects.delete(effectKey);
            }, duration);
          }, index * 100); // Stagger application by 100ms
        });
      }
    });
    
    // Handle periodic sync pulse (every 5 seconds)
    this.socket.on('visual-effects-sync-pulse', (data) => {
      // Only log occasionally to avoid spam
      if (Math.random() < 0.1) {
        console.log('🔄 VISUAL FX PULSE: Sync pulse received:', data.effects.length, 'effects');
      }
      
      if (data.effects && this.processor) {
        // Check each effect and apply if missing
        data.effects.forEach(effect => {
          const effectKey = `${effect.effectId}_pulse`;
          const existingEffect = this.appliedEffects.get(effectKey);
          
          // If effect doesn't exist or has expired, reapply it
          if (!existingEffect || (Date.now() - existingEffect) > effect.remainingSeconds * 1000) {
            const duration = effect.remainingSeconds * 1000;
            
            this.processor.applyEffect(effect.effectId, {
              duration: duration,
              effectData: effect.effectData
            });
            
            this.appliedEffects.set(effectKey, Date.now());
            
            // Remove from tracking after duration expires
            setTimeout(() => {
              this.appliedEffects.delete(effectKey);
            }, duration);
          }
        });
        
        // Remove effects that are no longer in the sync pulse
        const currentEffectIds = new Set(data.effects.map(e => e.effectId));
        for (const [key, timestamp] of this.appliedEffects.entries()) {
          const effectId = key.split('_')[0];
          if (!currentEffectIds.has(effectId) && key.endsWith('_pulse')) {
            // Effect no longer active, remove it
            this.processor.removeEffect(effectId);
            this.appliedEffects.delete(key);
          }
        }
      }
    });
    
    // Handle new buff application
    this.socket.on('visual-effect-apply-sync', (data) => {
      console.log('🎨 VISUAL FX APPLY: New buff effect to apply:', data);
      
      if (data.isNewBuff && this.processor) {
        const effectKey = `${data.effectId}_buff_${data.buffId}`;
        
        // Apply the new effect
        this.processor.applyEffect(data.effectId, {
          duration: data.duration,
          effectData: data.effectData
        });
        
        this.appliedEffects.set(effectKey, Date.now());
        
        // Remove from tracking after duration expires
        setTimeout(() => {
          this.appliedEffects.delete(effectKey);
        }, data.duration);
      }
    });
  }
  
  cleanup() {
    this.socket.off('visual-effect-sync');
    this.socket.off('visual-effects-state');
    this.socket.off('visual-effects-sync-pulse');
    this.socket.off('visual-effect-apply-sync');
    this.appliedEffects.clear();
  }
}

// Usage in React component:
/*
import { useEffect, useRef } from 'react';
import { socket } from './services/socket';
import { visualFxProcessor } from './services/visualFxProcessor';

function StreamViewer() {
  const syncHandlerRef = useRef(null);
  
  useEffect(() => {
    // Initialize the sync handler
    syncHandlerRef.current = new VisualEffectsSyncHandler(socket, visualFxProcessor);
    
    // Cleanup on unmount
    return () => {
      if (syncHandlerRef.current) {
        syncHandlerRef.current.cleanup();
      }
    };
  }, []);
  
  // Rest of component...
}
*/