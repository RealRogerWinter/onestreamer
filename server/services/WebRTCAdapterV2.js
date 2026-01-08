/**
 * WebRTC Adapter V2 - Non-destructive abstraction layer
 * Uses Proxy pattern to forward all calls to the actual backend
 * Preserves 100% MediaSoup compatibility while allowing LiveKit switching
 */

const MediasoupService = require('./MediasoupService');
const LiveKitService = require('./LiveKitService');

class WebRTCAdapterV2 {
  constructor() {
    const config = require('../config/webrtc.config');
    this.backendType = config.backend;
    
    // Create the appropriate backend
    let backend;
    switch (this.backendType) {
      case 'livekit':
        console.log('🎬 WebRTC Adapter: Creating LiveKit backend');
        backend = new LiveKitService();
        break;
      case 'mediasoup':
      default:
        console.log('🎬 WebRTC Adapter: Creating MediaSoup backend');
        backend = new MediasoupService();
        break;
    }
    
    this._backend = backend;
    
    // Return a Proxy that forwards everything to the backend
    // This ensures 100% compatibility with existing code
    return new Proxy(this, {
      get(target, prop) {
        // Special adapter methods
        if (prop === 'getBackendType') {
          return () => target.backendType;
        }
        if (prop === 'isMediaSoup') {
          return () => target.backendType === 'mediasoup';
        }
        if (prop === 'isLiveKit') {
          return () => target.backendType === 'livekit';
        }
        if (prop === 'getBackendInfo') {
          return () => ({
            type: target.backendType,
            backend: target._backend.constructor.name
          });
        }
        
        // If the property exists on the adapter, return it
        if (prop in target) {
          return target[prop];
        }
        
        // Otherwise, forward to the backend
        const backendValue = target._backend[prop];
        
        // If it's a function, bind it to the backend
        if (typeof backendValue === 'function') {
          return backendValue.bind(target._backend);
        }
        
        // Return the property value
        return backendValue;
      },
      
      set(target, prop, value) {
        // Forward property assignments to the backend
        target._backend[prop] = value;
        return true;
      },
      
      has(target, prop) {
        // Check both adapter and backend for property existence
        return prop in target || prop in target._backend;
      }
    });
  }
}

module.exports = WebRTCAdapterV2;