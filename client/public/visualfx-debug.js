/**
 * VisualFX Debug Panel Integration
 * 
 * This script can be included in any client page to provide admin debug panel access
 * for testing VisualFX effects. The panel is activated with Ctrl+Shift+V.
 */

class VisualFxDebugPanel {
    constructor() {
        this.isInitialized = false;
        this.isAdmin = false;
        this.panel = null;
        this.socket = null;
        this.effects = [];
        this.activeEffects = [];
        this.stats = {};
        this.currentStreamId = null;
        this.keyboardListenerAdded = false;
        
        this.initialize();
    }

    async initialize() {
        if (this.isInitialized) return;

        try {
            // Check admin status
            await this.checkAdminStatus();
            
            if (!this.isAdmin) {
                // Silently fail for security
                return;
            }
            
            console.log('VisualFX Debug Panel: Admin access confirmed ✅');

            // Set up keyboard shortcuts
            this.setupKeyboardShortcuts();
            
            // Create the debug panel
            this.createDebugPanel();
            
            this.isInitialized = true;
            console.log('VisualFX Debug Panel initialized (Press Ctrl+Shift+V to open)');
        } catch (error) {
            console.error('Failed to initialize VisualFX Debug Panel:', error);
        }
    }

    async checkAdminStatus() {
        try {
            // Check if we have admin credentials in localStorage or session
            const token = localStorage.getItem('authToken') || sessionStorage.getItem('authToken');
            
            if (!token) {
                // No token means no admin access
                this.isAdmin = false;
                return;
            }

            // Verify admin status with server
            const response = await fetch('/api/internal/verify-admin', {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (response.ok) {
                const data = await response.json();
                this.isAdmin = data.isAdmin || false;
            } else {
                this.isAdmin = false;
            }
        } catch (error) {
            console.error('Admin status check failed:', error);
            this.isAdmin = false;
        }
    }

    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Double-check admin status on every keypress
            if (!this.isAdmin) return;
            
            // Ctrl+Shift+V to toggle debug panel
            if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') {
                e.preventDefault();
                this.togglePanel();
            }
            
            // ESC to close debug panel
            if (e.code === 'Escape' && this.isPanelVisible()) {
                this.closePanel();
            }
        });
    }

    createDebugPanel() {
        // Create panel container
        this.panel = document.createElement('div');
        this.panel.id = 'visualfx-debug-panel';
        this.panel.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            background: rgba(13, 17, 23, 0.95);
            backdrop-filter: blur(10px);
            z-index: 10000;
            display: none;
            font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
            color: #e6edf3;
            line-height: 1.4;
        `;

        // Load the full panel content from the server
        this.loadPanelContent();

        // Append to body
        document.body.appendChild(this.panel);
    }

    async loadPanelContent() {
        try {
            const response = await fetch('/visualfx-debug-simple');
            if (response.ok) {
                const html = await response.text();
                
                // Parse the HTML document
                const parser = new DOMParser();
                const doc = parser.parseFromString(html, 'text/html');
                
                // Extract body content from the simple panel
                const bodyContent = doc.body;
                
                if (bodyContent) {
                    // Create a container for the panel content
                    const panelContainer = document.createElement('div');
                    panelContainer.style.cssText = `
                        width: 100%;
                        height: 100%;
                        overflow: auto;
                        position: relative;
                    `;
                    
                    // Copy all body content
                    panelContainer.innerHTML = bodyContent.innerHTML;
                    this.panel.appendChild(panelContainer);
                    
                    // Copy styles
                    const styles = doc.querySelector('style');
                    if (styles && !document.getElementById('visualfx-debug-styles')) {
                        const styleEl = document.createElement('style');
                        styleEl.id = 'visualfx-debug-styles';
                        styleEl.textContent = styles.textContent;
                        document.head.appendChild(styleEl);
                    }
                    
                    // Copy and execute scripts from the simple panel
                    this.initializeSimplePanelLogic(doc);
                } else {
                    throw new Error('Panel body content not found');
                }
            } else {
                throw new Error('Failed to load panel content');
            }
        } catch (error) {
            console.error('Failed to load debug panel content:', error);
            this.createFallbackPanel();
        }
    }

    createFallbackPanel() {
        // Create a minimal fallback panel if the full version can't be loaded
        this.panel.innerHTML = `
            <div style="padding: 20px; text-align: center; color: white;">
                <h2>VisualFX Debug Panel</h2>
                <p>Loading full interface failed. Basic controls:</p>
                <div style="margin: 20px 0;">
                    <button onclick="this.applyTestEffect()" style="margin: 5px; padding: 10px 20px; background: #1f6feb; color: white; border: none; border-radius: 5px; cursor: pointer;">
                        Apply Test Effect
                    </button>
                    <button onclick="this.clearAllEffects()" style="margin: 5px; padding: 10px 20px; background: #da3633; color: white; border: none; border-radius: 5px; cursor: pointer;">
                        Clear All Effects
                    </button>
                    <button onclick="visualFxDebugPanel.closePanel()" style="margin: 5px; padding: 10px 20px; background: #6b7280; color: white; border: none; border-radius: 5px; cursor: pointer;">
                        Close
                    </button>
                </div>
                <p style="font-size: 12px; color: #8b949e;">Press Ctrl+Shift+V to toggle, ESC to close</p>
            </div>
        `;
    }

    initializePanelLogic() {
        // Initialize socket connection
        if (typeof io !== 'undefined') {
            this.setupSocketConnection();
        } else {
            console.error('Socket.IO not available');
        }

        // Override global functions to use this instance
        window.closeDebugPanel = () => this.closePanel();
        window.applyEffect = (effectId) => this.applyEffect(effectId);
        window.applyPreset = (presetName) => this.applyPreset(presetName);
        window.clearAllEffects = () => this.clearAllEffects();
        window.removeEffect = (effectId) => this.removeEffect(effectId);
        window.clearConsoleLog = () => this.clearConsoleLog();
    }

    initializeSimplePanelLogic(doc) {
        // Initialize socket connection for simple panel
        if (typeof io !== 'undefined') {
            this.setupSocketConnection();
        } else {
            console.error('Socket.IO not available');
        }

        // Define all the functions that the simple panel needs globally
        const debugPanel = this;
        
        // Core functions
        window.applyEffect = function(effectId) {
            debugPanel.log('info', `Applying effect: ${effectId}`);
            
            if (debugPanel.socket && debugPanel.socket.connected) {
                debugPanel.socket.emit('apply-visual-effect', {
                    effectId: effectId,
                    options: {
                        requestedBy: 'debug-overlay',
                        testMode: true,
                        timestamp: Date.now()
                    }
                });
                
                // Visual feedback
                const buttons = document.querySelectorAll(`button[onclick*="${effectId}"]`);
                buttons.forEach(button => {
                    button.style.background = '#00ff88';
                    button.style.transform = 'scale(0.95)';
                    setTimeout(() => {
                        button.style.background = '';
                        button.style.transform = '';
                    }, 500);
                });
            } else {
                debugPanel.log('error', 'No socket connection for applying effect');
            }
        };

        window.applyPreset = function(presetName) {
            debugPanel.log('info', `Applying preset: ${presetName}`);
            debugPanel.applyPreset(presetName);
        };

        window.clearAllEffects = function() {
            debugPanel.log('info', 'Clearing all effects...');
            debugPanel.clearAllEffects();
        };

        window.loadEffectsDirectly = function() {
            debugPanel.log('info', 'Loading effects...');
            if (debugPanel.socket && debugPanel.socket.connected) {
                debugPanel.socket.emit('get-visual-effects');
                debugPanel.socket.emit('get-visual-fx-stats');
            }
        };

        window.testConnection = function() {
            debugPanel.log('info', 'Testing connection...');
            if (debugPanel.socket) {
                debugPanel.log('info', `Socket connected: ${debugPanel.socket.connected}`);
                debugPanel.log('info', `Socket ID: ${debugPanel.socket.id}`);
            } else {
                debugPanel.log('error', 'No socket object');
            }
        };

        window.debugVisualFxService = function() {
            debugPanel.log('info', 'Debugging VisualFX service...');
            if (debugPanel.socket && debugPanel.socket.connected) {
                debugPanel.socket.emit('get-visual-effects');
                debugPanel.socket.emit('get-visual-fx-stats');
            }
        };

        window.debugSocketEvents = function() {
            debugPanel.log('info', 'Testing socket events...');
            if (debugPanel.socket) {
                debugPanel.socket.emit('get-visual-effects');
                debugPanel.socket.emit('get-visual-fx-stats');
            }
        };

        window.clearLog = function() {
            const logEl = document.getElementById('debug-log');
            if (logEl) {
                logEl.innerHTML = '';
            }
            debugPanel.log('info', 'Debug log cleared');
        };

        // Mass action functions
        window.applyAllResolutionEffects = function() {
            const effects = ['resolution_240p', 'resolution_360p', 'resolution_480p'];
            effects.forEach((effect, index) => {
                setTimeout(() => window.applyEffect(effect), index * 2000);
            });
        };

        window.applyAllBitrateEffects = function() {
            const effects = ['bitrate_potato', 'bitrate_low', 'bitrate_throttle'];
            effects.forEach((effect, index) => {
                setTimeout(() => window.applyEffect(effect), index * 3000);
            });
        };

        window.applyAllVisualEffects = function() {
            const effects = ['pixelate', 'blur', 'grayscale', 'sepia', 'static_noise', 'glitch'];
            effects.forEach((effect, index) => {
                setTimeout(() => window.applyEffect(effect), index * 2500);
            });
        };

        window.applyAllAudioEffects = function() {
            const effects = ['audio_pitch_high', 'audio_pitch_low', 'audio_echo'];
            effects.forEach((effect, index) => {
                setTimeout(() => window.applyEffect(effect), index * 4000);
            });
        };

        window.applyRandomEffect = function() {
            const allEffects = [
                'resolution_240p', 'resolution_360p', 'resolution_480p',
                'bitrate_potato', 'bitrate_low', 'bitrate_throttle',
                'framerate_slideshow', 'framerate_choppy', 'framerate_cinematic',
                'packet_loss_mild', 'packet_loss_severe', 'jitter',
                'pixelate', 'blur', 'grayscale', 'sepia', 'static_noise', 'glitch',
                'audio_pitch_high', 'audio_pitch_low', 'audio_echo',
                'freeze_frame', 'stutter'
            ];
            const randomEffect = allEffects[Math.floor(Math.random() * allEffects.length)];
            debugPanel.log('info', `Applying random effect: ${randomEffect}`);
            window.applyEffect(randomEffect);
        };

        // Initialize connection and load effects
        setTimeout(() => {
            debugPanel.log('info', 'Simple panel initialized in overlay');
            window.loadEffectsDirectly();
        }, 500);
    }

    setupSocketConnection() {
        // Connect to the main server for Socket.IO
        this.socket = io('https://onestreamer.live', {
            transports: ['websocket', 'polling'],
            reconnection: true
        });
        
        // Initialize client-side visual FX processor
        this.initializeClientProcessor();

        this.socket.on('connect', () => {
            this.log('success', 'Connected to server');
            this.socket.emit('join-as-viewer');
            this.requestData();
        });

        this.socket.on('disconnect', () => {
            this.log('error', 'Disconnected from server');
        });

        // VisualFX events
        this.socket.on('visual-effect-applied', (data) => {
            this.log('success', `Effect applied: ${data.effectName}`);
            this.requestData();
            
            // Apply client-side visual effect for immediate feedback
            this.applyClientSideEffect(data.effectId, {
                duration: data.duration,
                serverApplied: true
            });
        });

        this.socket.on('visual-effect-removed', (data) => {
            this.log('info', `Effect removed: ${data.effectInstanceId}`);
            this.requestData();
        });

        this.socket.on('visual-effect-error', (error) => {
            this.log('error', `Effect error: ${error.error}`);
        });

        this.socket.on('visual-effects-list', (data) => {
            this.effects = data.availableEffects || [];
            this.activeEffects = data.activeEffects || [];
            this.updatePanel();
        });

        this.socket.on('visual-fx-stats', (data) => {
            this.stats = data.stats || {};
            this.currentStreamId = data.streamId;
            this.updateStatsDisplay();
        });
    }

    togglePanel() {
        if (!this.isAdmin) {
            // Silently fail for security
            return;
        }

        if (this.isPanelVisible()) {
            this.closePanel();
        } else {
            this.openPanel();
        }
    }

    openPanel() {
        // Additional admin check
        if (!this.isAdmin) {
            // Silently fail for security
            return;
        }
        
        if (!this.panel) return;
        
        this.panel.style.display = 'flex';
        this.panel.style.flexDirection = 'column';
        
        // Request fresh data
        this.requestData();
        
        this.log('info', 'Debug panel opened');
    }

    closePanel() {
        if (!this.panel) return;
        
        this.panel.style.display = 'none';
        this.log('info', 'Debug panel closed');
    }

    isPanelVisible() {
        return this.panel && this.panel.style.display !== 'none';
    }

    requestData() {
        if (this.socket) {
            this.socket.emit('get-visual-effects');
            this.socket.emit('get-visual-fx-stats');
        }
    }

    applyEffect(effectId) {
        if (!this.socket) {
            this.log('error', 'Not connected to server');
            return;
        }

        this.log('info', `Applying effect: ${effectId}`);
        this.socket.emit('apply-visual-effect', {
            effectId: effectId,
            options: {
                requestedBy: 'debug-panel',
                debugMode: true
            }
        });
    }

    applyPreset(presetName) {
        this.log('info', `Applying preset: ${presetName}`);
        
        fetch(`/api/visualfx/preset/${presetName}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                options: {
                    requestedBy: 'debug-panel',
                    debugMode: true
                }
            })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                this.log('success', `Preset applied: ${presetName}`);
            } else {
                this.log('error', `Preset failed: ${data.error}`);
            }
        })
        .catch(error => {
            this.log('error', `Preset request failed: ${error.message}`);
        });
    }

    clearAllEffects() {
        if (!this.currentStreamId) {
            this.log('error', 'No active stream');
            return;
        }

        this.log('warning', 'Clearing all effects...');
        
        // Clear client-side effects immediately
        this.clearClientSideEffects();
        
        fetch(`/api/visualfx/clear/${this.currentStreamId}`, {
            method: 'DELETE'
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                this.log('success', `Cleared ${data.clearedEffects} server effects`);
            } else {
                this.log('error', `Clear failed: ${data.error}`);
            }
        })
        .catch(error => {
            this.log('error', `Clear request failed: ${error.message}`);
        });
    }

    removeEffect(effectInstanceId) {
        if (!this.socket) {
            this.log('error', 'Not connected to server');
            return;
        }

        this.socket.emit('remove-visual-effect', {
            effectInstanceId: effectInstanceId
        });
    }

    updatePanel() {
        // This would update the panel UI - implementation depends on the loaded content
        // The full implementation is in the HTML file's JavaScript
    }

    updateStatsDisplay() {
        // Update stats in the panel if elements exist
        const elements = {
            'active-effects-count': this.stats.activeEffects || 0,
            'queued-effects-count': this.stats.queuedEffects || 0,
            'cpu-usage': this.stats.cpuUsage || '0%',
            'memory-usage': this.stats.memoryUsage || '0MB',
            'current-stream-id': this.currentStreamId || 'No active stream'
        };

        Object.keys(elements).forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.textContent = elements[id];
            }
        });
    }

    log(level, message) {
        // Try to find the log element in the overlay
        const logEl = document.getElementById('debug-log') || document.getElementById('console-log');
        
        // Always log to console as well
        console.log(`[VisualFX Debug] ${level.toUpperCase()}: ${message}`);
        
        if (!logEl) {
            return;
        }

        const time = new Date().toLocaleTimeString();
        const entry = document.createElement('div');
        entry.className = `log-entry log-${level}`;
        entry.innerHTML = `
            <span class="log-time">[${time}]</span>
            <span>${message}</span>
        `;
        
        logEl.appendChild(entry);
        logEl.scrollTop = logEl.scrollHeight;

        // Keep only last 50 log entries
        while (logEl.children.length > 50) {
            logEl.removeChild(logEl.firstChild);
        }
    }

    clearConsoleLog() {
        const logEl = document.getElementById('console-log');
        if (logEl) {
            logEl.innerHTML = '';
        }
        this.log('info', 'Console cleared');
    }

    initializeClientProcessor() {
        // Try to find video elements on the page
        const videoElements = document.querySelectorAll('video');
        
        if (videoElements.length > 0) {
            // Use the first video element found
            const videoElement = videoElements[0];
            
            // Load the ClientVisualFxProcessor if not already loaded
            if (typeof ClientVisualFxProcessor === 'undefined') {
                this.loadClientProcessor();
            } else {
                this.clientProcessor = new ClientVisualFxProcessor();
                this.clientProcessor.initialize(videoElement);
                this.log('info', 'Client-side visual processor initialized');
            }
        } else {
            // Try again after a delay in case video elements aren't loaded yet
            setTimeout(() => {
                this.initializeClientProcessor();
            }, 2000);
        }
    }

    loadClientProcessor() {
        // Dynamically load the client processor script
        const script = document.createElement('script');
        script.src = '/ClientVisualFxProcessor.js';
        script.onload = () => {
            this.clientProcessor = new ClientVisualFxProcessor();
            const videoElements = document.querySelectorAll('video');
            if (videoElements.length > 0) {
                this.clientProcessor.initialize(videoElements[0]);
                this.log('info', 'Client-side visual processor loaded and initialized');
            }
        };
        script.onerror = () => {
            this.log('warning', 'Could not load client-side visual processor');
        };
        document.head.appendChild(script);
    }

    applyClientSideEffect(effectId, options = {}) {
        if (this.clientProcessor) {
            const success = this.clientProcessor.applyEffect(effectId, options);
            if (success) {
                this.log('info', `Applied client-side effect: ${effectId}`);
            } else {
                this.log('warning', `Client-side effect not available: ${effectId}`);
            }
        } else {
            this.log('warning', 'Client-side processor not available');
        }
    }

    clearClientSideEffects() {
        if (this.clientProcessor) {
            this.clientProcessor.clearAllEffects();
            this.log('info', 'Cleared all client-side effects');
        }
    }

    // Quick test methods for fallback panel
    applyTestEffect() {
        const testEffects = ['pixelate', 'grayscale', 'resolution_240p', 'packet_loss_mild'];
        const randomEffect = testEffects[Math.floor(Math.random() * testEffects.length)];
        this.applyEffect(randomEffect);
    }
}

// Auto-initialize when script loads
let visualFxDebugPanel;

// Initialize after DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        visualFxDebugPanel = new VisualFxDebugPanel();
    });
} else {
    visualFxDebugPanel = new VisualFxDebugPanel();
}

// Also make it globally available
window.visualFxDebugPanel = visualFxDebugPanel;

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = VisualFxDebugPanel;
}

// Show initialization message in console
console.log(`
🎬 VisualFX Debug Panel loaded!
   
📋 Quick Commands:
   • Ctrl+Shift+V - Toggle debug panel
   • ESC - Close panel (when open)
   • Ctrl+Shift+C - Clear all effects (when panel is open)

🔧 Available via console:
   • visualFxDebugPanel.togglePanel()
   • visualFxDebugPanel.applyEffect('effect_id')
   • visualFxDebugPanel.clearAllEffects()

ℹ️  Loading admin status...
`);