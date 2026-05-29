/**
 * Buff -> effectId mapping table, extracted verbatim from
 * VisualFxService.handleBuffApplied. Pure data, no logic.
 */

const BUFF_EFFECT_MAP = {
    // Network effects
    'lag_spike': 'packet_loss_severe',
    'mild_packet_loss': 'packet_loss_mild',
    'network_jitter': 'jitter',

    // Resolution/Quality effects
    'potato_mode': 'resolution_240p',
    'potato': 'bitrate_potato',
    'low_bitrate': 'bitrate_low',
    'bandwidth_throttle': 'bitrate_throttle',

    // Stream size/orientation
    'stream_reducer': 'stream_resize_half',
    'mirror': 'mirror',
    'upside_down': 'flip_vertical',
    'rotate_90': 'rotate_90',

    // Frame rate effects
    'slow_motion': 'framerate_slideshow',
    'slideshow_mode': 'framerate_slideshow',
    'choppy_video': 'framerate_choppy',
    'cinematic_mode': 'framerate_cinematic',

    // Visual filters
    'glitch_bomb': 'glitch',
    'static_storm': 'static_noise',
    'tv_static': 'static_noise',
    'pixelate': 'pixelate',
    'motion_blur': 'blur',
    'black_and_white': 'grayscale',
    'sepia_tone': 'sepia',
    'invert_colors': 'invert',
    'darkness': 'brightness_dark',
    'overexposed': 'brightness_bright',
    'low_contrast': 'contrast_low',
    'high_contrast': 'contrast_high',
    'oversaturated': 'saturate',
    'desaturated': 'desaturate',
    'hue_shift': 'hue_rotate',
    'edge_detection': 'edge_detect',
    'emboss': 'emboss',
    'vignette': 'vignette',
    'wave_distortion': 'wave',
    'wobble': 'wobble',
    'vintage_film': 'vintage',
    'thermal_vision': 'thermal',

    // Audio effects
    'voice_modulator': 'audio_pitch_high',
    'chipmunk_voice': 'audio_pitch_high',
    'demon_voice': 'audio_pitch_low',
    'echo_chamber': 'audio_echo',

    // Freeze/Stutter effects
    'freeze_ray': 'freeze_frame',
    'video_stutter': 'stutter'
};

module.exports = { BUFF_EFFECT_MAP };
