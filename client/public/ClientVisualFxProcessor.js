/**
 * Client-Side Visual Effects Processor
 * 
 * This handles immediate visual effects on the client side using CSS filters,
 * canvas processing, and Web APIs while the server-side FFmpeg pipeline
 * processes the actual stream.
 */

// Prevent duplicate class declarations
if (typeof ClientVisualFxProcessor === 'undefined') {
    class ClientVisualFxProcessor {
    constructor() {
        this.activeEffects = new Map();
        this.activeCSSFilters = new Map();
        this.activeCSSTransforms = new Map();
        this.videoElement = null;
        this.canvasElement = null;
        this.canvasContext = null;
        this.overlayElement = null;
        this.isProcessing = false;
        
        this.effectDefinitions = {
            // Visual filter effects - Client-side CSS
            'blur': {
                type: 'css-filter',
                filter: 'blur(8px)',
                cssFilter: 'blur(8px)'
            },
            'grayscale': {
                type: 'css-filter',
                filter: 'grayscale(100%)',
                cssFilter: 'grayscale(100%)'
            },
            'sepia': {
                type: 'css-filter',
                filter: 'sepia(100%)',
                cssFilter: 'sepia(100%)'
            },
            'invert': {
                type: 'css-filter',
                filter: 'invert(100%)',
                cssFilter: 'invert(100%)'
            },
            'brightness_dark': {
                type: 'css-filter',
                filter: 'brightness(0.4)',
                cssFilter: 'brightness(0.4)'
            },
            'brightness_bright': {
                type: 'css-filter',
                filter: 'brightness(1.6)',
                cssFilter: 'brightness(1.6)'
            },
            'contrast_low': {
                type: 'css-filter',
                filter: 'contrast(0.5)',
                cssFilter: 'contrast(0.5)'
            },
            'contrast_high': {
                type: 'css-filter',
                filter: 'contrast(2)',
                cssFilter: 'contrast(2)'
            },
            'saturate': {
                type: 'css-filter',
                filter: 'saturate(2.5)',
                cssFilter: 'saturate(2.5)'
            },
            'desaturate': {
                type: 'css-filter',
                filter: 'saturate(0.3)',
                cssFilter: 'saturate(0.3)'
            },
            'hue_rotate': {
                type: 'css-filter',
                filter: 'hue-rotate(90deg)',
                cssFilter: 'hue-rotate(90deg)'
            },
            'mirror': {
                type: 'css-transform',
                transform: 'scaleX(-1)',
                cssTransform: 'scaleX(-1)'
            },
            'flip_vertical': {
                type: 'css-transform',
                transform: 'scaleY(-1)',
                cssTransform: 'scaleY(-1)'
            },
            'rotate_90': {
                type: 'css-transform',
                transform: 'rotate(90deg)',
                cssTransform: 'rotate(90deg)'
            },
            'vintage': {
                type: 'css-filter',
                filter: 'sepia(0.5) contrast(1.2) brightness(0.9)',
                cssFilter: 'sepia(0.5) contrast(1.2) brightness(0.9)'
            },
            'thermal': {
                type: 'css-filter',
                filter: 'hue-rotate(180deg) saturate(2) contrast(1.5)',
                cssFilter: 'hue-rotate(180deg) saturate(2) contrast(1.5)'
            },
            'vignette': {
                type: 'css-filter',
                filter: 'brightness(0.8)',
                cssFilter: 'brightness(0.8)'
            },
            'edge_detect': {
                type: 'css-filter',
                filter: 'contrast(3) grayscale(100%)',
                cssFilter: 'contrast(3) grayscale(100%)'
            },
            'emboss': {
                type: 'css-filter',
                filter: 'contrast(1.5) brightness(1.1)',
                cssFilter: 'contrast(1.5) brightness(1.1)'
            },
            'wave': {
                type: 'css-transform',
                transform: 'skew(2deg, 2deg)',
                cssTransform: 'skew(2deg, 2deg)'
            },
            'wobble': {
                type: 'css-transform',
                transform: 'rotate(1deg)',
                cssTransform: 'rotate(1deg)'
            },
            'stream_resize_half': {
                type: 'css-transform',
                transform: 'scale(0.5)',
                cssTransform: 'scale(0.5)'
            },
            // Server-side effects that need canvas overlay for client preview
            'pixelate': {
                type: 'css-filter',
                filter: 'url(#pixelate)',
                cssFilter: 'contrast(1.5) saturate(1.2)',
                canvasEffect: this.pixelateEffect.bind(this)
            },
            'static_noise': {
                type: 'canvas-overlay',
                overlayEffect: this.staticNoiseEffect.bind(this)
            },
            'glitch': {
                type: 'canvas-overlay',
                overlayEffect: this.glitchEffect.bind(this)
            },
            
            // Server-side effects that need client visual indication
            // These effects are primarily handled server-side but we add visual feedback
            'bitrate_potato': {
                type: 'css-filter',
                cssFilter: 'contrast(0.5) saturate(0.2) blur(4px) brightness(0.7) sepia(0.2)',
                filter: 'contrast(0.5) saturate(0.2) blur(4px) brightness(0.7) sepia(0.2)',
                description: 'Potato quality - ultra low bitrate',
                serverSide: true,
                // Additional visual indicator
                customHandler: function(effect) {
                    // Add pixelation effect through image-rendering
                    if (this.videoElement) {
                        this.videoElement.style.imageRendering = 'pixelated';
                        this.videoElement.style.imageRendering = '-moz-crisp-edges';
                        this.videoElement.style.imageRendering = 'crisp-edges';
                        
                        // Store original transform
                        this.videoElement._originalTransform = this.videoElement.style.transform || '';
                        
                        // Add slight scale to enhance pixelation
                        this.videoElement.style.transform = 'scale(1.01)';
                    }
                }
            },
            'resolution_240p': {
                type: 'css-filter',
                cssFilter: 'blur(0.5px)',
                filter: 'blur(0.5px)',
                description: 'Ultra low resolution',
                serverSide: true
            },
            'resolution_360p': {
                type: 'css-filter',
                cssFilter: 'blur(0.3px)',
                filter: 'blur(0.3px)',
                description: 'Low resolution',
                serverSide: true
            },
            'resolution_480p': {
                type: 'css-filter',
                cssFilter: 'blur(0.2px)',
                filter: 'blur(0.2px)',
                description: 'Medium resolution',
                serverSide: true
            },
            'bitrate_low': {
                type: 'css-filter',
                cssFilter: 'contrast(0.9)',
                filter: 'contrast(0.9)',
                description: 'Low bitrate',
                serverSide: true
            },
            'bitrate_throttle': {
                type: 'css-filter',
                cssFilter: 'contrast(0.95)',
                filter: 'contrast(0.95)',
                description: 'Throttled bitrate',
                serverSide: true
            },
            'framerate_slideshow': {
                type: 'css-filter',
                cssFilter: 'blur(0.5px) contrast(1.1)',
                filter: 'blur(0.5px) contrast(1.1)',
                description: 'Slideshow framerate',
                serverSide: true
            },
            'framerate_choppy': {
                type: 'css-filter',
                cssFilter: 'blur(0.3px)',
                filter: 'blur(0.3px)',
                description: 'Choppy framerate',
                serverSide: true
            },
            'packet_loss_mild': {
                type: 'css-filter',
                cssFilter: 'opacity(0.95)',
                filter: 'opacity(0.95)',
                description: 'Mild packet loss',
                serverSide: true
            },
            'packet_loss_severe': {
                type: 'css-filter',
                cssFilter: 'opacity(0.85) contrast(1.1)',
                filter: 'opacity(0.85) contrast(1.1)',
                description: 'Severe packet loss',
                serverSide: true
            },
            'jitter': {
                type: 'css-filter',
                cssFilter: 'blur(0.2px)',
                filter: 'blur(0.2px)',
                description: 'Network jitter',
                serverSide: true
            },
            'freeze_frame': {
                type: 'css-filter',
                cssFilter: 'contrast(1)',  // No visual change, will use canvas to freeze
                filter: 'contrast(1)',
                description: 'Freeze frame',
                serverSide: true,
                customHandler: 'freezeFrame'
            },
            'stutter': {
                type: 'css-filter',
                cssFilter: 'contrast(1)',  // No visual change, will use canvas to stutter
                filter: 'contrast(1)',
                description: 'Video stutter',
                serverSide: true,
                customHandler: 'stutterEffect'
            }
        };
        
        // // console.log('🎨 CLIENT VISUALFX: Client-side processor initialized');
    }

    initialize(videoElement) {
        // // console.log('🎨 CLIENT VISUALFX: Initializing processor...', { videoElement: !!videoElement });
        
        this.videoElement = videoElement;
        
        if (!this.videoElement) {
            // // console.log('🎨 CLIENT VISUALFX: No video element provided, attempting auto-detection...');
            // Try to auto-detect video elements
            this.autoDetectVideoElements();
        }

        if (!this.videoElement) {
            console.error('❌ CLIENT VISUALFX: No video element found');
            return false;
        }

        console.log('🎨 CLIENT VISUALFX: Video element found:', {
            tagName: this.videoElement.tagName,
            className: this.videoElement.className,
            id: this.videoElement.id,
            dimensions: `${this.videoElement.videoWidth}x${this.videoElement.videoHeight}`,
            src: this.videoElement.src || this.videoElement.srcObject ? 'has source' : 'no source'
        });

        // Create canvas for advanced effects
        this.createCanvas();
        
        // Create overlay for special effects
        this.createOverlay();
        
        // Detect if this is a streamer or viewer video
        this.detectVideoType();
        
        // // console.log('✅ CLIENT VISUALFX: Processor initialized successfully');
        // // console.log('🎨 CLIENT VISUALFX: Available effects:', Object.keys(this.effectDefinitions).join(', '));
        return true;
    }

    autoDetectVideoElements() {
        // Look for video elements in common containers
        const videoSelectors = [
            'video',
            '.webrtc-streamer video',
            '.webrtc-viewer video',
            '.stream-container video',
            '.video-container video'
        ];

        for (const selector of videoSelectors) {
            const videos = document.querySelectorAll(selector);
            if (videos.length > 0) {
                this.videoElement = videos[0];
                // // console.log(`🎨 CLIENT VISUALFX: Auto-detected video element: ${selector}`);
                break;
            }
        }
    }

    detectVideoType() {
        if (!this.videoElement) return;

        // Check if this video element is part of a streamer component
        const parentClasses = this.videoElement.parentElement?.className || '';
        const containerClasses = this.videoElement.closest('[class*="stream"]')?.className || '';
        
        this.isStreamerVideo = parentClasses.includes('webrtc-streamer') || 
                              containerClasses.includes('streamer') ||
                              this.videoElement.id.includes('streamer');
        
        this.isViewerVideo = parentClasses.includes('webrtc-viewer') || 
                            containerClasses.includes('viewer') ||
                            this.videoElement.id.includes('viewer');

        // // console.log(`🎨 CLIENT VISUALFX: Video type detected - Streamer: ${this.isStreamerVideo}, Viewer: ${this.isViewerVideo}`);
    }

    createCanvas() {
        this.canvasElement = document.createElement('canvas');
        this.canvasElement.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            pointer-events: none;
            z-index: 10;
            display: none;
        `;
        
        this.canvasContext = this.canvasElement.getContext('2d');
        
        if (this.videoElement && this.videoElement.parentNode) {
            this.videoElement.parentNode.insertBefore(this.canvasElement, this.videoElement.nextSibling);
        }
    }

    createOverlay() {
        this.overlayElement = document.createElement('div');
        this.overlayElement.className = 'visualfx-overlay';
        this.overlayElement.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 11;
            display: none;
        `;
        
        if (this.videoElement && this.videoElement.parentNode) {
            this.videoElement.parentNode.insertBefore(this.overlayElement, this.videoElement.nextSibling);
        }
    }

    applyEffect(effectId, options = {}) {
        const effectDef = this.effectDefinitions[effectId];
        
        if (!effectDef) {
            console.warn(`⚠️ CLIENT VISUALFX: Unknown effect: ${effectId}`);
            // // console.log(`🎨 CLIENT VISUALFX: Available effects:`, Object.keys(this.effectDefinitions));
            return false;
        }

        // Log if this is a server-side effect
        if (effectDef.serverSide) {
            // // console.log(`🎨 CLIENT VISUALFX: Applying visual feedback for server-side effect: ${effectId}`);
            // // console.log(`📡 CLIENT VISUALFX: Note: The actual ${effectDef.description || effectId} is handled by the server`);
        } else {
            // // console.log(`🎨 CLIENT VISUALFX: Applying client-side effect: ${effectId}`);
        }
        
        // // console.log(`🎨 CLIENT VISUALFX: Effect definition:`, effectDef);
        // // console.log(`🎨 CLIENT VISUALFX: Effect options:`, options);

        const effect = {
            id: effectId,
            definition: effectDef,
            startTime: Date.now(),
            duration: options.duration || 15000,
            options: options
        };

        this.activeEffects.set(effectId, effect);

        // Apply the effect based on its type
        switch (effectDef.type) {
            case 'css-filter':
                this.applyCSSFilter(effect);
                break;
            case 'css-transform':
                this.applyCSSTransform(effect);
                break;
            case 'canvas-overlay':
                this.applyCanvasOverlay(effect);
                break;
            case 'canvas-processing':
                this.applyCanvasProcessing(effect);
                break;
        }
        
        // Execute custom handler if defined
        if (effectDef.customHandler) {
            try {
                effectDef.customHandler.call(this, effect);
                // // console.log(`🎨 CLIENT VISUALFX: Executed custom handler for ${effectId}`);
            } catch (err) {
                console.error(`❌ CLIENT VISUALFX: Custom handler error for ${effectId}:`, err);
            }
        }

        // Auto-remove effect after duration
        setTimeout(() => {
            this.removeEffect(effectId);
        }, effect.duration);

        return true;
    }

    applyCSSFilter(effect) {
        if (!this.videoElement) return;

        const { cssFilter, filter } = effect.definition;
        
        // Store this filter
        this.activeCSSFilters.set(effect.id, cssFilter || filter);
        
        // Combine all active filters
        this.updateCombinedStyles();
        
        // // console.log(`🎨 CLIENT VISUALFX: Applied CSS filter: ${cssFilter || filter}`);
    }
    
    applyCSSTransform(effect) {
        if (!this.videoElement) {
            console.warn(`⚠️ CLIENT VISUALFX: No video element when applying transform ${effect.id}`);
            return;
        }

        const { cssTransform, transform } = effect.definition;
        const transformValue = cssTransform || transform;
        
        // Store this transform
        this.activeCSSTransforms.set(effect.id, transformValue);
        
        // Combine all active transforms
        this.updateCombinedStyles();
        
        // // console.log(`🎨 CLIENT VISUALFX: Applied CSS transform: ${transformValue}`);
        // // console.log(`🎨 CLIENT VISUALFX: Video element:`, this.videoElement);
        // // console.log(`🎨 CLIENT VISUALFX: Video element classes:`, this.videoElement.className);
        // // console.log(`🎨 CLIENT VISUALFX: Video element computed style transform:`, getComputedStyle(this.videoElement).transform);
    }
    
    updateCombinedStyles() {
        if (!this.videoElement) return;
        
        // Combine all active filters
        const filters = Array.from(this.activeCSSFilters.values());
        const combinedFilter = filters.join(' ');
        
        // Combine all active transforms
        const transforms = Array.from(this.activeCSSTransforms.values());
        const combinedTransform = transforms.join(' ');
        
        // Apply combined styles
        this.videoElement.style.filter = combinedFilter;
        this.videoElement.style.transform = combinedTransform;
        
        // // console.log(`🎨 CLIENT VISUALFX: Updated styles - Filter: "${combinedFilter}", Transform: "${combinedTransform}"`);
    }

    applyCanvasOverlay(effect) {
        if (!this.overlayElement) return;

        this.overlayElement.style.display = 'block';
        
        if (effect.definition.overlayEffect) {
            effect.definition.overlayEffect(effect);
        }
    }

    applyCanvasProcessing(effect) {
        if (!this.canvasElement || !this.videoElement) return;

        this.canvasElement.style.display = 'block';
        this.updateCanvasSize();
        
        if (effect.definition.canvasEffect) {
            effect.definition.canvasEffect(effect);
        }
    }

    updateCanvasSize() {
        if (!this.canvasElement || !this.videoElement) return;

        const rect = this.videoElement.getBoundingClientRect();
        this.canvasElement.width = rect.width;
        this.canvasElement.height = rect.height;
        
        this.canvasElement.style.width = rect.width + 'px';
        this.canvasElement.style.height = rect.height + 'px';
    }

    removeEffect(effectId) {
        const effect = this.activeEffects.get(effectId);
        
        if (!effect) {
            console.warn(`⚠️ CLIENT VISUALFX: Effect not found: ${effectId}`);
            return false;
        }

        // // console.log(`🎨 CLIENT VISUALFX: Removing effect: ${effectId}`);

        // Remove effect based on type
        switch (effect.definition.type) {
            case 'css-filter':
                this.removeCSSFilter(effect);
                break;
            case 'css-transform':
                this.removeCSSTransform(effect);
                break;
            case 'canvas-overlay':
                this.removeCanvasOverlay(effect);
                break;
            case 'canvas-processing':
                this.removeCanvasProcessing(effect);
                break;
        }

        this.activeEffects.delete(effectId);
        return true;
    }

    removeCSSFilter(effect) {
        if (!this.videoElement) return;

        // Remove from active filters map
        this.activeCSSFilters.delete(effect.id);
        
        // Clean up any custom styling for potato effect
        if (effect.id === 'bitrate_potato') {
            this.videoElement.style.imageRendering = '';
            if (this.videoElement._originalTransform !== undefined) {
                this.videoElement.style.transform = this.videoElement._originalTransform;
                delete this.videoElement._originalTransform;
            }
        }
        
        // Update combined styles
        this.updateCombinedStyles();
    }
    
    removeCSSTransform(effect) {
        if (!this.videoElement) return;

        // Remove from active transforms map
        this.activeCSSTransforms.delete(effect.id);
        
        // Update combined styles
        this.updateCombinedStyles();
    }

    removeCanvasOverlay(effect) {
        if (this.activeEffects.size <= 1) {
            this.overlayElement.style.display = 'none';
            this.overlayElement.innerHTML = '';
        }
    }

    removeCanvasProcessing(effect) {
        if (this.activeEffects.size <= 1) {
            this.canvasElement.style.display = 'none';
            this.canvasContext.clearRect(0, 0, this.canvasElement.width, this.canvasElement.height);
        }
    }

    clearAllEffects() {
        // // console.log('🎨 CLIENT VISUALFX: Clearing all client-side effects');
        
        // Clear all active effects
        this.activeEffects.clear();
        this.activeCSSFilters.clear();
        this.activeCSSTransforms.clear();
        
        // Reset video element
        if (this.videoElement) {
            this.videoElement.style.filter = '';
            this.videoElement.style.transform = '';
        }
        
        // Hide overlays
        if (this.overlayElement) {
            this.overlayElement.style.display = 'none';
            this.overlayElement.innerHTML = '';
        }
        
        if (this.canvasElement) {
            this.canvasElement.style.display = 'none';
            if (this.canvasContext) {
                this.canvasContext.clearRect(0, 0, this.canvasElement.width, this.canvasElement.height);
            }
        }
    }

    // Effect implementations
    staticNoiseEffect(effect) {
        const noise = document.createElement('div');
        noise.style.cssText = `
            width: 100%;
            height: 100%;
            opacity: 0.3;
            background: repeating-linear-gradient(
                90deg,
                transparent,
                transparent 1px,
                rgba(255,255,255,0.1) 1px,
                rgba(255,255,255,0.1) 2px
            ),
            repeating-linear-gradient(
                0deg,
                transparent,
                transparent 1px,
                rgba(255,255,255,0.1) 1px,
                rgba(255,255,255,0.1) 2px
            );
            animation: visualfx-static 0.1s linear infinite;
        `;
        
        // Add keyframes for animation
        if (!document.querySelector('#visualfx-static-keyframes')) {
            const style = document.createElement('style');
            style.id = 'visualfx-static-keyframes';
            style.textContent = `
                @keyframes visualfx-static {
                    0% { transform: translateX(0) translateY(0); }
                    25% { transform: translateX(-1px) translateY(1px); }
                    50% { transform: translateX(1px) translateY(-1px); }
                    75% { transform: translateX(-1px) translateY(-1px); }
                    100% { transform: translateX(1px) translateY(1px); }
                }
            `;
            document.head.appendChild(style);
        }
        
        this.overlayElement.appendChild(noise);
    }

    glitchEffect(effect) {
        const glitch = document.createElement('div');
        glitch.style.cssText = `
            width: 100%;
            height: 100%;
            background: linear-gradient(45deg, 
                rgba(255,0,0,0.1) 0%,
                transparent 20%,
                transparent 40%,
                rgba(0,255,0,0.1) 60%,
                transparent 80%,
                rgba(0,0,255,0.1) 100%
            );
            animation: visualfx-glitch 0.2s ease-in-out infinite;
        `;
        
        // Add keyframes for glitch animation
        if (!document.querySelector('#visualfx-glitch-keyframes')) {
            const style = document.createElement('style');
            style.id = 'visualfx-glitch-keyframes';
            style.textContent = `
                @keyframes visualfx-glitch {
                    0% { transform: translateX(0); }
                    10% { transform: translateX(-5px) skew(-5deg); }
                    20% { transform: translateX(5px) skew(5deg); }
                    30% { transform: translateX(-2px) skew(-2deg); }
                    40% { transform: translateX(3px) skew(3deg); }
                    50% { transform: translateX(-1px) skew(-1deg); }
                    60% { transform: translateX(2px) skew(2deg); }
                    70% { transform: translateX(-3px) skew(-3deg); }
                    80% { transform: translateX(1px) skew(1deg); }
                    90% { transform: translateX(-1px) skew(-1deg); }
                    100% { transform: translateX(0); }
                }
            `;
            document.head.appendChild(style);
        }
        
        this.overlayElement.appendChild(glitch);
    }

    pixelateEffect(effect) {
        // This would be a more complex canvas-based pixelation
        // For now, we'll use CSS scaling
        if (this.videoElement) {
            this.videoElement.style.imageRendering = 'pixelated';
            this.videoElement.style.transform = 'scale(0.1)';
            this.videoElement.style.transformOrigin = 'top left';
            
            setTimeout(() => {
                this.videoElement.style.transform = 'scale(1)';
            }, 100);
        }
    }

    // Get processing stats
    getStats() {
        return {
            activeEffects: this.activeEffects.size,
            effectsList: Array.from(this.activeEffects.keys()),
            isProcessing: this.isProcessing,
            hasVideo: !!this.videoElement,
            hasCanvas: !!this.canvasElement,
            hasOverlay: !!this.overlayElement
        };
    }
}

    // Export for module systems
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = ClientVisualFxProcessor;
    }

    // Make globally available
    window.ClientVisualFxProcessor = ClientVisualFxProcessor;
}