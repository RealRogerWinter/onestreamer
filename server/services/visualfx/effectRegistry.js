/**
 * VisualFX effect registry — the ~42 pure-data effect configs extracted
 * verbatim from VisualFxService.initializeEffects(). Each entry is
 * [effectId, config]; the service loops over this and calls registerEffect
 * (which adds the `id` field and stores in this.effectRegistry). No logic here.
 */

const VISUAL_FX_EFFECTS = [
        ['resolution_240p', {
            name: 'Ultra Low Resolution',
            type: 'resolution',
            parameters: { width: 426, height: 240, spatialLayer: 0 },
            duration: 30000,
            priority: 5
        }],
        
        ['resolution_360p', {
            name: 'Low Resolution',
            type: 'resolution',
            parameters: { width: 640, height: 360, spatialLayer: 1 },
            duration: 30000,
            priority: 5
        }],
        
        ['resolution_480p', {
            name: 'Medium Resolution',
            type: 'resolution',
            parameters: { width: 854, height: 480, spatialLayer: 2 },
            duration: 30000,
            priority: 5
        }],
        
        // Bitrate effects
        ['bitrate_potato', {
            name: 'Potato Quality',
            type: 'bitrate',
            parameters: { 
                videoBitrate: 30000,  // EXTREME potato - 30kbps video
                audioBitrate: 8000    // 8kbps audio (phone quality)
            },
            duration: 35000,  // Match the Potato item duration
            priority: 6
        }],
        
        ['bitrate_low', {
            name: 'Low Bitrate',
            type: 'bitrate',
            parameters: { videoBitrate: 250000, audioBitrate: 64000 },
            duration: 20000,
            priority: 6
        }],
        
        ['bitrate_throttle', {
            name: 'Bandwidth Throttle',
            type: 'bitrate',
            parameters: { videoBitrate: 500000, audioBitrate: 96000 },
            duration: 30000,
            priority: 6
        }],
        
        // Frame rate effects
        ['framerate_slideshow', {
            name: 'Slideshow Mode',
            type: 'framerate',
            parameters: { fps: 1 },
            duration: 15000,
            priority: 7
        }],
        
        ['framerate_choppy', {
            name: 'Choppy Video',
            type: 'framerate',
            parameters: { fps: 10 },
            duration: 20000,
            priority: 7
        }],
        
        ['framerate_cinematic', {
            name: 'Cinematic Mode',
            type: 'framerate',
            parameters: { fps: 24 },
            duration: 30000,
            priority: 4
        }],
        
        // Network simulation effects
        ['packet_loss_mild', {
            name: 'Mild Packet Loss',
            type: 'packet_loss',
            parameters: { lossRate: 0.02 }, // 2% packet loss
            duration: 15000,
            priority: 8
        }],
        
        ['packet_loss_severe', {
            name: 'Severe Packet Loss',
            type: 'packet_loss',
            parameters: { lossRate: 0.1 }, // 10% packet loss
            duration: 10000,
            priority: 9
        }],
        
        ['jitter', {
            name: 'Network Jitter',
            type: 'jitter',
            parameters: { jitterMs: 100, variance: 50 },
            duration: 20000,
            priority: 7
        }],
        
        // Visual distortion effects
        ['pixelate', {
            name: 'Pixelation',
            type: 'filter',
            parameters: { 
                filter: 'scale=iw/10:ih/10,scale=iw*10:ih*10:flags=neighbor'
            },
            duration: 15000,
            priority: 5,
            requiresProcessing: true
        }],
        
        ['blur', {
            name: 'Motion Blur',
            type: 'filter',
            parameters: { 
                filter: 'boxblur=10:2'
            },
            duration: 20000,
            priority: 5,
            requiresProcessing: true
        }],
        
        ['grayscale', {
            name: 'Black & White',
            type: 'filter',
            parameters: { 
                filter: 'colorchannelmixer=.3:.4:.3:0:.3:.4:.3:0:.3:.4:.3'
            },
            duration: 30000,
            priority: 3,
            requiresProcessing: true
        }],
        
        ['sepia', {
            name: 'Sepia Tone',
            type: 'filter',
            parameters: { 
                filter: 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131'
            },
            duration: 30000,
            priority: 3,
            requiresProcessing: true
        }],
        
        ['static_noise', {
            name: 'TV Static',
            type: 'filter',
            parameters: { 
                filter: 'noise=alls=20:allf=t'
            },
            duration: 10000,
            priority: 6,
            requiresProcessing: true
        }],
        
        ['glitch', {
            name: 'Digital Glitch',
            type: 'filter',
            parameters: { 
                filter: 'rgbashift=rh=5:gh=-5:bv=5:av=0'
            },
            duration: 5000,
            priority: 8,
            requiresProcessing: true
        }],
        
        // Audio effects
        ['audio_pitch_high', {
            name: 'Chipmunk Voice',
            type: 'audio',
            parameters: { 
                pitch: 1.5,
                tempo: 1.2
            },
            duration: 20000,
            priority: 4,
            requiresProcessing: true
        }],
        
        ['audio_pitch_low', {
            name: 'Demon Voice',
            type: 'audio',
            parameters: { 
                pitch: 0.6,
                tempo: 0.9
            },
            duration: 20000,
            priority: 4,
            requiresProcessing: true
        }],
        
        ['audio_echo', {
            name: 'Echo Chamber',
            type: 'audio',
            parameters: { 
                delay: 500,
                decay: 0.5
            },
            duration: 15000,
            priority: 4,
            requiresProcessing: true
        }],
        
        // Freeze effects
        ['freeze_frame', {
            name: 'Freeze Frame',
            type: 'freeze',
            parameters: { 
                freezeDuration: 3000
            },
            duration: 3000,
            priority: 10
        }],
        
        ['stutter', {
            name: 'Video Stutter',
            type: 'stutter',
            parameters: { 
                stutterInterval: 500,
                stutterDuration: 100
            },
            duration: 10000,
            priority: 8
        }],
        
        // Additional visual filter effects
        ['invert', {
            name: 'Invert Colors',
            type: 'filter',
            parameters: { 
                filter: 'negate'
            },
            duration: 20000,
            priority: 4,
            requiresProcessing: true
        }],
        
        ['brightness_dark', {
            name: 'Darkness',
            type: 'filter',
            parameters: { 
                filter: 'eq=brightness=-0.3'
            },
            duration: 25000,
            priority: 4,
            requiresProcessing: true
        }],
        
        ['brightness_bright', {
            name: 'Overexposed',
            type: 'filter',
            parameters: { 
                filter: 'eq=brightness=0.3'
            },
            duration: 25000,
            priority: 4,
            requiresProcessing: true
        }],
        
        ['contrast_low', {
            name: 'Low Contrast',
            type: 'filter',
            parameters: { 
                filter: 'eq=contrast=0.5'
            },
            duration: 25000,
            priority: 4,
            requiresProcessing: true
        }],
        
        ['contrast_high', {
            name: 'High Contrast',
            type: 'filter',
            parameters: { 
                filter: 'eq=contrast=2'
            },
            duration: 25000,
            priority: 4,
            requiresProcessing: true
        }],
        
        ['saturate', {
            name: 'Oversaturated',
            type: 'filter',
            parameters: { 
                filter: 'eq=saturation=2'
            },
            duration: 25000,
            priority: 4,
            requiresProcessing: true
        }],
        
        ['desaturate', {
            name: 'Desaturated',
            type: 'filter',
            parameters: { 
                filter: 'eq=saturation=0.3'
            },
            duration: 25000,
            priority: 4,
            requiresProcessing: true
        }],
        
        ['hue_rotate', {
            name: 'Hue Shift',
            type: 'filter',
            parameters: { 
                filter: 'hue=h=90'
            },
            duration: 20000,
            priority: 4,
            requiresProcessing: true
        }],
        
        ['edge_detect', {
            name: 'Edge Detection',
            type: 'filter',
            parameters: { 
                filter: 'edgedetect=mode=colormix:high=0.2'
            },
            duration: 15000,
            priority: 5,
            requiresProcessing: true
        }],
        
        ['emboss', {
            name: 'Emboss',
            type: 'filter',
            parameters: { 
                filter: 'convolution=0 -1 0 -1 5 -1 0 -1 0:0 -1 0 -1 5 -1 0 -1 0:0 -1 0 -1 5 -1 0 -1 0:0 -1 0 -1 5 -1 0 -1 0'
            },
            duration: 20000,
            priority: 5,
            requiresProcessing: true
        }],
        
        ['vignette', {
            name: 'Vignette',
            type: 'filter',
            parameters: { 
                filter: 'vignette=PI/4'
            },
            duration: 30000,
            priority: 3,
            requiresProcessing: true
        }],
        
        ['mirror', {
            name: 'Mirror',
            type: 'filter',
            parameters: { 
                filter: 'hflip'
            },
            duration: 20000,
            priority: 4,
            requiresProcessing: true
        }],
        
        ['flip_vertical', {
            name: 'Upside Down',
            type: 'filter',
            parameters: { 
                filter: 'vflip'
            },
            duration: 20000,
            priority: 4,
            requiresProcessing: true
        }],
        
        ['rotate_90', {
            name: 'Rotate 90°',
            type: 'filter',
            parameters: { 
                filter: 'transpose=1'
            },
            duration: 20000,
            priority: 4,
            requiresProcessing: true
        }],
        
        ['wave', {
            name: 'Wave Distortion',
            type: 'filter',
            parameters: { 
                filter: 'wave=a=10:r=30'
            },
            duration: 15000,
            priority: 5,
            requiresProcessing: true
        }],
        
        ['wobble', {
            name: 'Wobble',
            type: 'filter',
            parameters: { 
                filter: 'perspective=x0=0:y0=0:x1=W:y1=0:x2=0:y2=H:x3=W:y3=H:interpolation=linear:sense=source'
            },
            duration: 15000,
            priority: 5,
            requiresProcessing: true
        }],
        
        ['vintage', {
            name: 'Vintage Film',
            type: 'filter',
            parameters: { 
                filter: 'curves=vintage'
            },
            duration: 30000,
            priority: 3,
            requiresProcessing: true
        }],
        
        ['thermal', {
            name: 'Thermal Vision',
            type: 'filter',
            parameters: { 
                filter: 'pseudocolor=p=inferno'
            },
            duration: 25000,
            priority: 4,
            requiresProcessing: true
        }],
        
        ['stream_resize_half', {
            name: 'Stream Size Reducer',
            type: 'resize',
            parameters: { 
                scale: 0.5,
                position: 'center'
            },
            duration: 60000,
            priority: 3
        }],
];

module.exports = { VISUAL_FX_EFFECTS };
