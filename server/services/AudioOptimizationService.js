const EventEmitter = require('events');

/**
 * AudioOptimizationService - Handles audio quality optimization for streaming
 * Provides audio processing enhancements and quality monitoring
 */
class AudioOptimizationService extends EventEmitter {
    constructor() {
        super();
        
        // Optimal audio configuration for streaming
        this.config = {
            // Audio codec settings
            opus: {
                stereo: true,
                fec: true,  // Forward Error Correction for packet loss
                dtx: false,  // Disabled to prevent audio cutoff
                cbr: false,  // Variable bitrate for better quality
                useinbandfec: true,
                usedtx: false,  // Disabled to prevent audio cutoff
                maxplaybackrate: 48000,
                minptime: 10,
                ptime: 20,
                maxaveragebitrate: 128000,
                
                // Opus specific optimizations
                application: 'audio',  // Can be 'voip', 'audio', or 'lowdelay'
                complexity: 10,  // 0-10, higher = better quality but more CPU
                packet_loss_percentage: 5,  // Expected packet loss for FEC
            },
            
            // Processing settings
            processing: {
                // Echo cancellation settings
                echoCancellation: {
                    enabled: false,  // Disabled to prevent audio filtering
                    mode: 'default',  // 'default', 'aggressive', 'moderate'
                    tailLength: 128,  // ms
                },
                
                // Noise suppression settings
                noiseSuppression: {
                    enabled: false,  // Disabled to prevent audio filtering
                    level: 'low',  // 'low', 'moderate', 'high', 'very-high'
                    spectralSubtraction: false,
                },
                
                // Automatic gain control settings
                autoGainControl: {
                    enabled: false,  // Disabled to prevent audio manipulation
                    targetLevel: -3,  // dBFS
                    compressionGain: 9,  // dB
                    limiterEnable: false,
                    targetLevelDbfs: -3,
                    compressionGainDb: 20,
                    enableLimiter: false,
                },
                
                // Voice activity detection
                voiceActivityDetection: {
                    enabled: false,  // Disabled to prevent audio cutoff
                    likelihood: 'unlikely',  // Less aggressive when enabled
                    mode: 'quality',  // Prioritize quality over detection when enabled
                },
                
                // Audio level monitoring
                levelMonitoring: {
                    enabled: true,
                    interval: 100,  // ms
                    smoothing: 0.8,
                    clipThreshold: -1.0,  // dBFS
                    silenceThreshold: -50.0,  // dBFS
                },
            },
            
            // Streaming quality settings
            streaming: {
                // Adaptive bitrate settings
                adaptiveBitrate: {
                    enabled: true,
                    minBitrate: 32000,   // 32 kbps
                    maxBitrate: 320000,  // 320 kbps
                    startBitrate: 128000, // 128 kbps
                    targetLatency: 50,    // ms
                },
                
                // Buffer settings for smooth playback
                buffering: {
                    jitterBuffer: 50,     // ms
                    playoutDelay: 100,    // ms
                    adaptiveBuffering: true,
                    minBuffer: 20,        // ms
                    maxBuffer: 200,       // ms
                },
                
                // Network adaptation
                networkAdaptation: {
                    enabled: true,
                    packetLossThreshold: 0.02,  // 2%
                    rttThreshold: 150,           // ms
                    enableFEC: true,
                    enableRED: true,  // Redundancy Encoding
                },
            },
            
            // Quality monitoring thresholds
            qualityThresholds: {
                minAcceptableLevel: -40,  // dBFS
                maxAcceptableLevel: -3,   // dBFS
                silenceDetection: -60,    // dBFS
                clippingDetection: -0.5,  // dBFS
                noiseFloor: -50,          // dBFS
            },
        };
        
        // Statistics tracking
        this.stats = {
            sessions: new Map(),
            globalStats: {
                totalSessions: 0,
                activeStreams: 0,
                averageQuality: 0,
                packetLossRate: 0,
                averageLatency: 0,
            }
        };
        
        // Start monitoring
        this.startMonitoring();
    }
    
    /**
     * Get optimized MediaSoup RTP parameters for audio
     */
    getOptimizedRtpParameters() {
        return {
            codecs: [
                {
                    mimeType: 'audio/opus',
                    clockRate: 48000,
                    channels: 2,
                    parameters: {
                        'stereo': 1,
                        'sprop-stereo': 1,
                        'minptime': this.config.opus.minptime,
                        'ptime': this.config.opus.ptime,
                        'useinbandfec': 1,
                        'usedtx': 1,
                        'maxaveragebitrate': this.config.opus.maxaveragebitrate,
                        'maxplaybackrate': this.config.opus.maxplaybackrate,
                        'cbr': this.config.opus.cbr ? 1 : 0,
                    },
                    rtcpFeedback: [
                        { type: 'transport-cc' },
                        { type: 'nack' },
                    ],
                }
            ],
            headerExtensions: [
                {
                    uri: 'urn:ietf:params:rtp-hdrext:ssrc-audio-level',
                    id: 1,
                },
                {
                    uri: 'urn:ietf:params:rtp-hdrext:sdes:mid',
                    id: 4,
                },
                {
                    uri: 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
                    id: 2,
                },
                {
                    uri: 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
                    id: 5,
                },
            ],
        };
    }
    
    /**
     * Get optimized WebRTC constraints for client-side capture
     */
    getOptimizedConstraints(profile = 'streaming') {
        const profiles = {
            streaming: {
                audio: {
                    // Basic constraints - ALL DISABLED for raw audio
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                    sampleRate: 48000,
                    sampleSize: 24,
                    channelCount: 2,
                    
                    // Advanced constraints for better quality
                    latency: 0.01,  // 10ms target latency
                    volume: 1.0,
                    
                    // Chrome-specific - ALL DISABLED
                    googEchoCancellation: false,
                    googAutoGainControl: false,
                    googNoiseSuppression: false,
                    googHighpassFilter: false,
                    googTypingNoiseDetection: false,
                    googAudioMirroring: false,
                    
                    // Additional processing - DISABLED
                    googNoiseReduction: false,
                    googBeamforming: false,
                    
                    // Experimental features - DISABLED
                    googExperimentalEchoCancellation: false,
                    googExperimentalAutoGainControl: false,
                    googExperimentalNoiseSuppression: false,
                }
            },
            voice: {
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    sampleRate: 16000,  // Lower for voice
                    sampleSize: 16,
                    channelCount: 1,    // Mono for voice
                    latency: 0.005,     // Ultra-low latency
                }
            },
            music: {
                audio: {
                    echoCancellation: false,  // Disable for music
                    noiseSuppression: false,  // Preserve full spectrum
                    autoGainControl: false,   // Manual control for music
                    sampleRate: 48000,
                    sampleSize: 32,         // Higher bit depth
                    channelCount: 2,
                    latency: 0.05,          // Higher latency for quality
                }
            }
        };
        
        return profiles[profile] || profiles.streaming;
    }
    
    /**
     * Monitor audio quality for a session
     */
    monitorSession(sessionId, producerId) {
        if (!this.stats.sessions.has(sessionId)) {
            this.stats.sessions.set(sessionId, {
                id: sessionId,
                producerId: producerId,
                startTime: Date.now(),
                quality: {
                    level: 0,
                    peak: 0,
                    average: 0,
                    silence: false,
                    clipping: false,
                },
                network: {
                    packetLoss: 0,
                    jitter: 0,
                    rtt: 0,
                    bitrate: 0,
                },
                history: [],
            });
        }
        
        return this.stats.sessions.get(sessionId);
    }
    
    /**
     * Update session statistics
     */
    updateSessionStats(sessionId, stats) {
        const session = this.stats.sessions.get(sessionId);
        if (!session) return;
        
        // Update quality metrics
        if (stats.audioLevel !== undefined) {
            session.quality.level = stats.audioLevel;
            session.quality.average = (session.quality.average * 0.9) + (stats.audioLevel * 0.1);
            session.quality.peak = Math.max(session.quality.peak, stats.audioLevel);
            
            // Detect issues
            session.quality.silence = stats.audioLevel < this.config.qualityThresholds.silenceDetection;
            session.quality.clipping = stats.audioLevel > this.config.qualityThresholds.clippingDetection;
        }
        
        // Update network metrics
        if (stats.packetLoss !== undefined) {
            session.network.packetLoss = stats.packetLoss;
        }
        if (stats.jitter !== undefined) {
            session.network.jitter = stats.jitter;
        }
        if (stats.rtt !== undefined) {
            session.network.rtt = stats.rtt;
        }
        if (stats.bitrate !== undefined) {
            session.network.bitrate = stats.bitrate;
        }
        
        // Add to history
        session.history.push({
            timestamp: Date.now(),
            ...stats
        });
        
        // Keep only last 100 entries
        if (session.history.length > 100) {
            session.history.shift();
        }
        
        // Check for quality issues and emit events
        this.checkQualityIssues(sessionId, session);
    }
    
    /**
     * Check for audio quality issues
     */
    checkQualityIssues(sessionId, session) {
        const issues = [];
        
        // Check for silence
        if (session.quality.silence) {
            issues.push({
                type: 'silence',
                severity: 'warning',
                message: 'Audio level too low - possible microphone issue',
                suggestion: 'Check microphone connection and gain settings'
            });
        }
        
        // Check for clipping
        if (session.quality.clipping) {
            issues.push({
                type: 'clipping',
                severity: 'warning',
                message: 'Audio clipping detected - level too high',
                suggestion: 'Reduce microphone gain or move further from microphone'
            });
        }
        
        // Check for high packet loss
        if (session.network.packetLoss > 0.05) {
            issues.push({
                type: 'packet_loss',
                severity: 'error',
                message: `High packet loss detected: ${(session.network.packetLoss * 100).toFixed(1)}%`,
                suggestion: 'Check network connection stability'
            });
        }
        
        // Check for high jitter
        if (session.network.jitter > 50) {
            issues.push({
                type: 'jitter',
                severity: 'warning',
                message: `High jitter detected: ${session.network.jitter}ms`,
                suggestion: 'Network instability detected - consider wired connection'
            });
        }
        
        // Check for high latency
        if (session.network.rtt > 200) {
            issues.push({
                type: 'latency',
                severity: 'warning',
                message: `High latency detected: ${session.network.rtt}ms`,
                suggestion: 'Consider using a closer server or better connection'
            });
        }
        
        if (issues.length > 0) {
            this.emit('quality-issues', {
                sessionId,
                issues,
                timestamp: Date.now()
            });
        }
    }
    
    /**
     * Get recommended settings based on network conditions
     */
    getAdaptiveSettings(networkStats) {
        const settings = { ...this.config.opus };
        
        // Adapt based on packet loss
        if (networkStats.packetLoss > 0.02) {
            settings.fec = true;
            settings.packet_loss_percentage = Math.min(networkStats.packetLoss * 100, 20);
        }
        
        // Adapt bitrate based on available bandwidth
        if (networkStats.availableBandwidth) {
            const audioBandwidth = Math.min(networkStats.availableBandwidth * 0.2, 320000);
            settings.maxaveragebitrate = Math.max(32000, audioBandwidth);
        }
        
        // Adapt based on latency
        if (networkStats.rtt > 100) {
            settings.dtx = true;  // Enable discontinuous transmission
            settings.ptime = 40;  // Increase packet time to reduce overhead
        }
        
        return settings;
    }
    
    /**
     * Start monitoring service
     */
    startMonitoring() {
        this.monitoringInterval = setInterval(() => {
            // Calculate global statistics
            let totalQuality = 0;
            let activeCount = 0;
            
            for (const [sessionId, session] of this.stats.sessions) {
                if (Date.now() - session.startTime < 3600000) { // Active in last hour
                    totalQuality += session.quality.average;
                    activeCount++;
                }
            }
            
            this.stats.globalStats.activeStreams = activeCount;
            this.stats.globalStats.averageQuality = activeCount > 0 ? totalQuality / activeCount : 0;
            
            // Emit global stats
            this.emit('global-stats', this.stats.globalStats);
        }, 5000); // Every 5 seconds
    }
    
    /**
     * Stop monitoring service
     */
    stopMonitoring() {
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = null;
        }
    }
    
    /**
     * Clean up old sessions
     */
    cleanupSessions() {
        const now = Date.now();
        const maxAge = 3600000; // 1 hour
        
        for (const [sessionId, session] of this.stats.sessions) {
            if (now - session.startTime > maxAge) {
                this.stats.sessions.delete(sessionId);
            }
        }
    }
    
    /**
     * Get session report
     */
    getSessionReport(sessionId) {
        const session = this.stats.sessions.get(sessionId);
        if (!session) return null;
        
        const duration = Date.now() - session.startTime;
        const report = {
            sessionId,
            duration,
            quality: {
                ...session.quality,
                score: this.calculateQualityScore(session),
            },
            network: session.network,
            recommendations: this.getRecommendations(session),
        };
        
        return report;
    }
    
    /**
     * Calculate overall quality score (0-100)
     */
    calculateQualityScore(session) {
        let score = 100;
        
        // Deduct for silence
        if (session.quality.silence) score -= 30;
        
        // Deduct for clipping
        if (session.quality.clipping) score -= 20;
        
        // Deduct for packet loss
        score -= Math.min(session.network.packetLoss * 500, 30);
        
        // Deduct for high jitter
        score -= Math.min(session.network.jitter / 10, 20);
        
        // Deduct for high latency
        score -= Math.min(session.network.rtt / 20, 20);
        
        return Math.max(0, Math.min(100, score));
    }
    
    /**
     * Get recommendations for improving quality
     */
    getRecommendations(session) {
        const recommendations = [];
        const score = this.calculateQualityScore(session);
        
        if (score < 50) {
            recommendations.push('Critical audio quality issues detected');
        }
        
        if (session.quality.silence) {
            recommendations.push('Increase microphone gain or check microphone connection');
        }
        
        if (session.quality.clipping) {
            recommendations.push('Reduce microphone gain to prevent distortion');
        }
        
        if (session.network.packetLoss > 0.02) {
            recommendations.push('Use wired connection instead of WiFi if possible');
            recommendations.push('Close other bandwidth-heavy applications');
        }
        
        if (session.network.jitter > 30) {
            recommendations.push('Check for network congestion');
            recommendations.push('Consider upgrading internet connection');
        }
        
        if (session.network.rtt > 150) {
            recommendations.push('Consider using a server closer to your location');
        }
        
        return recommendations;
    }
}

module.exports = AudioOptimizationService;