/**
 * Stream Interceptor Integration
 * Example of how to integrate StreamInterceptorService with existing ItemService
 */

// In your server/index.js or initialization file:

const StreamInterceptorService = require('./services/StreamInterceptorService');

// Initialize the service
const streamInterceptor = new StreamInterceptorService(
    mediasoupService,
    plainTransportService
);

// Hook into ItemService for potato and other debuff items
itemService.on('item-used', async (data) => {
    const { itemId, targetStreamId, userId } = data;
    
    // Check if this is a potato or other effect item
    if (itemId === 'potato') {
        console.log(`🥔 INTEGRATION: Potato item used on stream ${targetStreamId}`);
        
        try {
            // Use stream interception instead of modifying MediaSoup
            await streamInterceptor.interceptStream(targetStreamId, 'potato', {
                duration: 35000,  // 35 seconds
                userId: userId,
                itemId: itemId
            });
            
            // Emit success event
            io.to(targetStreamId).emit('visual-effect-applied', {
                effectId: 'bitrate_potato',
                streamId: targetStreamId,
                duration: 35000,
                applyToAllViewers: true,
                method: 'stream-interception'
            });
            
        } catch (error) {
            console.error('❌ INTEGRATION: Failed to apply potato effect:', error);
            
            // Fallback to client-side only effect
            io.to(targetStreamId).emit('visual-effect-applied', {
                effectId: 'bitrate_potato',
                streamId: targetStreamId,
                duration: 35000,
                applyToAllViewers: true,
                method: 'client-side-fallback'
            });
        }
    }
});

// Hook into VisualFxService for other effects
visualFxService.on('apply-effect', async (data) => {
    const { effectId, streamId, parameters } = data;
    
    // Map effect IDs to interceptor types
    const effectMap = {
        'bitrate_potato': 'potato',
        'blur': 'blur',
        'pixelate': 'pixelate',
        'resolution_240p': 'generic',
        'bitrate_low': 'generic'
    };
    
    const interceptType = effectMap[effectId];
    
    if (interceptType) {
        try {
            const options = {
                duration: parameters.duration || 30000,
                ...parameters
            };
            
            // For generic type, pass specific parameters
            if (interceptType === 'generic') {
                if (effectId === 'resolution_240p') {
                    options.width = 426;
                    options.height = 240;
                } else if (effectId === 'bitrate_low') {
                    options.videoBitrate = 250000;
                    options.audioBitrate = 64000;
                }
            }
            
            await streamInterceptor.interceptStream(streamId, interceptType, options);
            
        } catch (error) {
            console.error(`❌ INTEGRATION: Failed to intercept for ${effectId}:`, error);
        }
    }
});

// Handle stream restoration
streamInterceptor.on('stream-restored', (data) => {
    const { streamId } = data;
    
    // Notify clients that effect has ended
    io.to(streamId).emit('visual-effect-removed', {
        streamId: streamId,
        applyToAllViewers: true
    });
});

// Handle viewer switching
streamInterceptor.on('stream-intercepted', async (data) => {
    const { streamId, processedTransportId } = data;
    
    // Get all viewers for this stream
    const viewers = mediasoupService.getStreamViewers(streamId);
    
    // Switch each viewer to processed stream
    for (const viewerId of viewers) {
        try {
            // This would need to be implemented in your MediasoupService
            await mediasoupService.switchViewerToTransport(viewerId, processedTransportId);
        } catch (error) {
            console.error(`❌ Failed to switch viewer ${viewerId}:`, error);
        }
    }
});

// Alternative: FFmpeg-based implementation
class FFmpegInterceptor {
    constructor() {
        this.ffmpeg = require('fluent-ffmpeg');
    }
    
    /**
     * Create FFmpeg pipeline for potato effect
     */
    createPotatoPipeline(inputRtpPort, outputRtpPort) {
        return this.ffmpeg()
            // Input from MediaSoup RTP
            .input(`rtp://127.0.0.1:${inputRtpPort}`)
            .inputOptions([
                '-protocol_whitelist', 'file,rtp,udp',
                '-analyzeduration', '10M',
                '-probesize', '10M'
            ])
            
            // Potato video processing
            .videoCodec('libvpx')  // VP8 codec
            .size('320x240')  // Ultra low resolution
            .videoBitrate('30k')  // 30kbps
            .fps(10)  // 10 fps
            .videoFilters([
                'scale=320:240:flags=neighbor',  // Pixelated scaling
                'eq=contrast=0.5:brightness=-0.3',  // Reduce contrast/brightness
                'unsharp=5:5:-1.5:5:5:-1.5'  // Add blur
            ])
            
            // Potato audio processing
            .audioCodec('libopus')
            .audioBitrate('8k')  // 8kbps
            .audioFrequency(8000)  // 8kHz sample rate
            .audioChannels(1)  // Mono
            
            // Output back to MediaSoup
            .output(`rtp://127.0.0.1:${outputRtpPort}`)
            .outputOptions([
                '-f', 'rtp',
                '-payload_type', '96'
            ])
            
            .on('start', (commandLine) => {
                console.log('🎬 FFmpeg started:', commandLine);
            })
            .on('error', (err) => {
                console.error('❌ FFmpeg error:', err);
            })
            .on('end', () => {
                console.log('✅ FFmpeg processing complete');
            });
    }
}

// Export for use in other modules
module.exports = {
    streamInterceptor,
    FFmpegInterceptor
};