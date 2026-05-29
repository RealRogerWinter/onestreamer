/**
 * Canvas FX static effect data — extracted verbatim from CanvasFxService.js
 * (getEffectConfig's effectMappings + getInteractionConfig's interactionConfigs).
 * Pure data only — no `this`, no logic. The default fallback in getEffectConfig
 * (which reads this.config.defaultDuration) intentionally stays in the service.
 */

const CANVAS_EFFECT_MAPPINGS = {
            'tomato': {
                type: 'splat',
                duration: 3000,
                config: {
                    color: '#ff4444',
                    splashColor: '#cc0000',
                    particles: 12,
                    size: 'large',
                    animation: 'splat',
                    drip: true,
                    sound: 'splat'
                }
            },
            'confetti_cannon': {
                type: 'particles',
                duration: 8000,
                config: {
                    colors: ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#ffa500', '#ff69b4'],
                    particleCount: 150,
                    spread: 120,
                    startVelocity: 25,
                    gravity: 0.15,
                    animation: 'confetti',
                    sound: 'pop',
                    animationSpeed: 0.5
                }
            },
            'smoke_bomb': {
                type: 'multi-phase',
                duration: 'buff-duration', // Special flag to use buff duration
                config: {
                    tracksBuff: true, // Track buff status for duration
                    phases: [
                        {
                            name: 'initial_puff',
                            type: 'particles',
                            duration: 2000, // 2 seconds for initial puff
                            config: {
                                color: 'rgba(120, 120, 120, 0.9)',
                                animation: 'smoke-puff',
                                particleCount: 25,
                                spread: 45,
                                startVelocity: 8,
                                gravity: -0.02, // Slight upward drift for smoke
                                particleSize: 'large',
                                smokeStyle: true,
                                billowing: true,
                                turbulence: 0.3,
                                sound: 'poof',
                                fadeOut: true,
                                expandingCloud: true
                            }
                        },
                        {
                            name: 'persistent_smoke',
                            type: 'overlay',
                            duration: 'remaining-duration', // Rest of buff duration
                            delay: 1500, // Start 1.5s after initial puff begins
                            config: {
                                color: 'rgba(100, 100, 100, 0.6)',
                                animation: 'smoke-fill',
                                spread: true,
                                opacity: 0.6,
                                width: 'full',
                                height: 'full',
                                fadeIn: true,
                                fadeInDuration: 3000,
                                persistent: true,
                                waveEffect: true,
                                density: 0.7,
                                hazeEffect: true,
                                smokeClouds: true,
                                cloudCount: 8,
                                cloudMovement: {
                                    enabled: true,
                                    speed: 0.5,
                                    direction: 'random',
                                    drift: 0.2,
                                    rotation: true,
                                    rotationSpeed: 0.3
                                },
                                smokeGrowth: {
                                    enabled: true,
                                    rate: 0.15,
                                    maxScale: 2.5,
                                    pulsing: true,
                                    pulseSpeed: 0.8
                                },
                                turbulence: {
                                    enabled: true,
                                    strength: 0.4,
                                    frequency: 0.6,
                                    scale: 1.2
                                }
                            }
                        }
                    ]
                }
            },
            'rainbow_effect': {
                type: 'overlay',
                duration: 6000,
                config: {
                    animation: 'rainbow',
                    speed: 1.5,
                    intensity: 0.6,
                    opacity: 0.7,
                    waveWidth: 200
                }
            },
            'disco_ball': {
                type: 'disco',
                duration: 10000,
                config: {
                    colors: ['#ff00ff', '#00ff00', '#ffff00', '#00ffff', '#ff0080', '#8000ff', '#ff3333', '#33ff33', '#3333ff', '#ffff33', '#ff33ff', '#33ffff'],
                    rotationSpeed: 2.5,
                    lightBeams: 16,
                    sparkleSize: 12,
                    pulsate: true,
                    glitterCount: 200,
                    beamIntensity: 0.8,
                    reflectionSpots: 30,
                    colorCycleSpeed: 1.5,
                    glitterDensity: 0.8,
                    sound: 'disco'
                }
            },
            'spotlight': {
                type: 'overlay',
                duration: 6000,
                config: {
                    animation: 'spotlight',
                    color: '#ffffff',
                    beamWidth: 150,
                    intensity: 0.9,
                    sweepSpeed: 2,
                    fadeEdges: true,
                    rotateBeam: true
                }
            },
            'freeze_frame': {
                type: 'freeze',
                duration: 3000,
                config: {
                    freezeDuration: 1000,
                    glitchEffect: true,
                    sound: 'freeze'
                }
            },
            'slow_mode': {
                type: 'timeWarp',
                duration: 5000,
                config: {
                    speed: 0.5,
                    warpEffect: true,
                    color: 'rgba(0, 0, 255, 0.2)'
                }
            },
            'speed_boost': {
                type: 'speedLines',
                duration: 3000,
                config: {
                    color: '#00ff00',
                    lineCount: 20,
                    speed: 3,
                    blur: true
                }
            },
            'golden_mic': {
                type: 'aura',
                duration: 6000,
                config: {
                    color: '#ffd700',
                    pulseSpeed: 1,
                    particles: true,
                    sound: 'shine'
                }
            },
            'red_marker': {
                type: 'multi-phase',
                duration: 20000, // 10s draw + 10s display
                config: {
                    phases: [
                        {
                            name: 'drawing_phase',
                            type: 'drawing',
                            duration: 10000,
                            config: {
                                interactive: true,
                                captureMode: 'continuous',
                                lineWidth: 3,
                                lineColor: '#FF0000',
                                lineCap: 'round',
                                lineJoin: 'round',
                                enableDrawing: true,
                                opacity: 1.0
                            }
                        },
                        {
                            name: 'display_phase',
                            type: 'static_drawing',
                            duration: 10000,
                            delay: 10000, // Start after drawing phase ends
                            config: {
                                preserveDrawing: true,
                                fadeOut: true,
                                fadeOutDuration: 2000,
                                fadeStartDelay: 8000,
                                opacity: 1.0
                            }
                        }
                    ]
                }
            },
            'blue_marker': {
                type: 'multi-phase',
                duration: 20000,
                config: {
                    phases: [
                        {
                            name: 'drawing_phase',
                            type: 'drawing',
                            duration: 10000,
                            config: {
                                interactive: true,
                                captureMode: 'continuous',
                                lineWidth: 3,
                                lineColor: '#0000FF',
                                lineCap: 'round',
                                lineJoin: 'round',
                                enableDrawing: true,
                                opacity: 1.0
                            }
                        },
                        {
                            name: 'display_phase',
                            type: 'static_drawing',
                            duration: 10000,
                            delay: 10000, // Start after drawing phase ends
                            config: {
                                preserveDrawing: true,
                                fadeOut: true,
                                fadeOutDuration: 2000,
                                fadeStartDelay: 8000,
                                opacity: 1.0
                            }
                        }
                    ]
                }
            },
            'green_marker': {
                type: 'multi-phase',
                duration: 20000,
                config: {
                    phases: [
                        {
                            name: 'drawing_phase',
                            type: 'drawing',
                            duration: 10000,
                            config: {
                                interactive: true,
                                captureMode: 'continuous',
                                lineWidth: 3,
                                lineColor: '#00AA00',
                                lineCap: 'round',
                                lineJoin: 'round',
                                enableDrawing: true,
                                opacity: 1.0
                            }
                        },
                        {
                            name: 'display_phase',
                            type: 'static_drawing',
                            duration: 10000,
                            delay: 10000, // Start after drawing phase ends
                            config: {
                                preserveDrawing: true,
                                fadeOut: true,
                                fadeOutDuration: 2000,
                                fadeStartDelay: 8000,
                                opacity: 1.0
                            }
                        }
                    ]
                }
            },
            'yellow_marker': {
                type: 'multi-phase',
                duration: 20000,
                config: {
                    phases: [
                        {
                            name: 'drawing_phase',
                            type: 'drawing',
                            duration: 10000,
                            config: {
                                interactive: true,
                                captureMode: 'continuous',
                                lineWidth: 3,
                                lineColor: '#FFDD00',
                                lineCap: 'round',
                                lineJoin: 'round',
                                enableDrawing: true,
                                opacity: 1.0
                            }
                        },
                        {
                            name: 'display_phase',
                            type: 'static_drawing',
                            duration: 10000,
                            delay: 10000, // Start after drawing phase ends
                            config: {
                                preserveDrawing: true,
                                fadeOut: true,
                                fadeOutDuration: 2000,
                                fadeStartDelay: 8000,
                                opacity: 1.0
                            }
                        }
                    ]
                }
            },
            'purple_marker': {
                type: 'multi-phase',
                duration: 20000,
                config: {
                    phases: [
                        {
                            name: 'drawing_phase',
                            type: 'drawing',
                            duration: 10000,
                            config: {
                                interactive: true,
                                captureMode: 'continuous',
                                lineWidth: 3,
                                lineColor: '#AA00AA',
                                lineCap: 'round',
                                lineJoin: 'round',
                                enableDrawing: true,
                                opacity: 1.0
                            }
                        },
                        {
                            name: 'display_phase',
                            type: 'static_drawing',
                            duration: 10000,
                            delay: 10000, // Start after drawing phase ends
                            config: {
                                preserveDrawing: true,
                                fadeOut: true,
                                fadeOutDuration: 2000,
                                fadeStartDelay: 8000,
                                opacity: 1.0
                            }
                        }
                    ]
                }
            },
            'orange_marker': {
                type: 'multi-phase',
                duration: 20000,
                config: {
                    phases: [
                        {
                            name: 'drawing_phase',
                            type: 'drawing',
                            duration: 10000,
                            config: {
                                interactive: true,
                                captureMode: 'continuous',
                                lineWidth: 3,
                                lineColor: '#FF8800',
                                lineCap: 'round',
                                lineJoin: 'round',
                                enableDrawing: true,
                                opacity: 1.0
                            }
                        },
                        {
                            name: 'display_phase',
                            type: 'static_drawing',
                            duration: 10000,
                            delay: 10000, // Start after drawing phase ends
                            config: {
                                preserveDrawing: true,
                                fadeOut: true,
                                fadeOutDuration: 2000,
                                fadeStartDelay: 8000,
                                opacity: 1.0
                            }
                        }
                    ]
                }
            },
            'pink_marker': {
                type: 'multi-phase',
                duration: 20000,
                config: {
                    phases: [
                        {
                            name: 'drawing_phase',
                            type: 'drawing',
                            duration: 10000,
                            config: {
                                interactive: true,
                                captureMode: 'continuous',
                                lineWidth: 3,
                                lineColor: '#FF69B4',
                                lineCap: 'round',
                                lineJoin: 'round',
                                enableDrawing: true,
                                opacity: 1.0
                            }
                        },
                        {
                            name: 'display_phase',
                            type: 'static_drawing',
                            duration: 10000,
                            delay: 10000, // Start after drawing phase ends
                            config: {
                                preserveDrawing: true,
                                fadeOut: true,
                                fadeOutDuration: 2000,
                                fadeStartDelay: 8000,
                                opacity: 1.0
                            }
                        }
                    ]
                }
            },
            'black_marker': {
                type: 'multi-phase',
                duration: 20000,
                config: {
                    phases: [
                        {
                            name: 'drawing_phase',
                            type: 'drawing',
                            duration: 10000,
                            config: {
                                interactive: true,
                                captureMode: 'continuous',
                                lineWidth: 3,
                                lineColor: '#000000',
                                lineCap: 'round',
                                lineJoin: 'round',
                                enableDrawing: true,
                                opacity: 1.0
                            }
                        },
                        {
                            name: 'display_phase',
                            type: 'static_drawing',
                            duration: 10000,
                            delay: 10000, // Start after drawing phase ends
                            config: {
                                preserveDrawing: true,
                                fadeOut: true,
                                fadeOutDuration: 2000,
                                fadeStartDelay: 8000,
                                opacity: 1.0
                            }
                        }
                    ]
                }
            },
            'white_marker': {
                type: 'multi-phase',
                duration: 20000,
                config: {
                    phases: [
                        {
                            name: 'drawing_phase',
                            type: 'drawing',
                            duration: 10000,
                            config: {
                                interactive: true,
                                captureMode: 'continuous',
                                lineWidth: 3,
                                lineColor: '#FFFFFF',
                                lineCap: 'round',
                                lineJoin: 'round',
                                enableDrawing: true,
                                opacity: 1.0
                            }
                        },
                        {
                            name: 'display_phase',
                            type: 'static_drawing',
                            duration: 10000,
                            delay: 10000, // Start after drawing phase ends
                            config: {
                                preserveDrawing: true,
                                fadeOut: true,
                                fadeOutDuration: 2000,
                                fadeStartDelay: 8000,
                                opacity: 1.0
                            }
                        }
                    ]
                }
            },
            'rainbow_marker': {
                type: 'multi-phase',
                duration: 20000,
                config: {
                    phases: [
                        {
                            name: 'drawing_phase',
                            type: 'drawing',
                            duration: 10000,
                            config: {
                                interactive: true,
                                captureMode: 'continuous',
                                lineWidth: 4,
                                lineColor: 'rainbow',
                                lineCap: 'round',
                                lineJoin: 'round',
                                enableDrawing: true,
                                opacity: 1.0,
                                rainbowMode: true
                            }
                        },
                        {
                            name: 'display_phase',
                            type: 'static_drawing',
                            duration: 10000,
                            delay: 10000, // Start after drawing phase ends
                            config: {
                                preserveDrawing: true,
                                fadeOut: true,
                                fadeOutDuration: 2000,
                                fadeStartDelay: 8000,
                                opacity: 1.0,
                                rainbowMode: true
                            }
                        }
                    ]
                }
            },
            'heart_swarm': {
                type: 'particles',
                duration: 15000, // 15 seconds for full animation
                config: {
                    particleType: 'hearts',
                    hearts: ['❤️', '💕', '💖', '💗', '💓', '💜', '💙', '💚', '💛', '🧡'],
                    particleCount: 85,
                    spread: 35, // Tighter spread
                    startVelocity: 5, // Much slower initial upward velocity
                    gravity: -0.015, // Gentler upward force
                    gravityShiftTime: 2000, // Start falling after just 2 seconds!
                    fallGravity: 0.12, // Strong downward gravity for quick fall
                    drift: true,
                    driftSpeed: 0.4, // More sideways drift for floating effect
                    rotation: true,
                    rotationSpeed: 0.08, // Gentle rotation
                    sizeVariation: true,
                    minSize: 0.8,
                    maxSize: 1.5,
                    fadeOut: true,
                    fadeStartTime: 10000, // Start fading at 10 seconds
                    animation: 'heart-swarm',
                    sound: 'love',
                    waveMotion: true,
                    waveAmplitude: 40, // Larger wave for more floating
                    waveFrequency: 0.0025, // Slightly faster wave
                    floatPattern: 'rise-and-fall', // Special pattern
                    spawnPattern: 'burst' // All hearts spawn at once from click point
                }
            },
            'arrow': {
                type: 'projectile',
                duration: 8500, // 500ms flight + 8000ms stuck
                config: {
                    projectileType: 'arrow',
                    emoji: '🏹',
                    size: 80,
                    flightDuration: 500,
                    stickDuration: 8000,
                    animation: 'arrow-flight',
                    sound: 'whoosh',
                    color: '#8B4513',
                    trailEffect: true,
                    trailColor: 'rgba(139, 69, 19, 0.3)',
                    rotateToTarget: true,
                    impactEffect: true,
                    wobbleOnStick: true,
                    fadeOut: true,
                    fadeStartTime: 7000
                }
            },
            'molotov': {
                type: 'fire',
                duration: 12000, // 12 seconds of burning
                config: {
                    fireType: 'molotov',
                    emoji: '🔥',
                    spreadRadius: 120,
                    flameHeight: 80,
                    flameCount: 25,
                    animation: 'burning',
                    sound: 'fire-crackle',
                    colors: ['#FF4500', '#FF6347', '#FF8C00', '#FFD700', '#FFA500'],
                    smokeEffect: true,
                    smokeColor: 'rgba(50, 50, 50, 0.4)',
                    sparkles: true,
                    fadeOut: true,
                    fadeStartTime: 10000,
                    heatDistortion: true,
                    glowEffect: true,
                    glowRadius: 150,
                    glowColor: 'rgba(255, 69, 0, 0.3)'
                }
            },
            'lsd': {
                type: 'psychedelic',
                duration: 20000, // 20 seconds trip
                config: {
                    tripType: 'lsd',
                    emoji: '🌈',
                    animation: 'psychedelic-trip',
                    sound: 'psychedelic',
                    intensity: 'high',
                    waveAmplitude: 30,
                    waveFrequency: 0.02,
                    colorShiftSpeed: 0.001,
                    hueRotationSpeed: 2,
                    saturationBoost: 1.5,
                    fractalDepth: 5,
                    kaleidoscopeSegments: 6,
                    trailLength: 10,
                    pulseSpeed: 0.005,
                    chromaShift: true,
                    melting: true,
                    breathing: true,
                    fadeIn: true,
                    fadeOut: true,
                    fadeInDuration: 2000,
                    fadeOutDuration: 3000
                }
            },
            'bugs': {
                type: 'bugs',
                duration: 15000, // 15 seconds of bugs crawling
                config: {
                    bugType: 'infestation',
                    bugCount: 15,
                    bugTypes: ['🐛', '🐜', '🕷️', '🦗', '🪲', '🪳', '🦟', '🐞'],
                    animation: 'crawling',
                    sound: 'creepy-crawly',
                    minSpeed: 0.5,
                    maxSpeed: 2,
                    wiggleAmount: 5,
                    turnSpeed: 0.02,
                    sizeVariation: 0.5,
                    opacity: 0.9,
                    shadowEffect: true,
                    scatterOnClick: false,
                    fadeOut: true,
                    fadeStartTime: 13000
                }
            },
            'fart': {
                type: 'fart_clouds',
                duration: 8000, // 8 seconds total animation
                config: {
                    cloudType: 'fart',
                    emoji: '💨',
                    cloudCount: 12,
                    animation: 'fart-dispersion',
                    sound: 'fart',
                    minSize: 40,
                    maxSize: 120,
                    startOpacity: 0.7,
                    endOpacity: 0,
                    cloudColor: 'rgba(139, 90, 43, 0.4)', // Brown-green gas color
                    dispersionSpeed: 1.5,
                    riseSpeed: -0.8, // Negative for upward movement
                    driftSpeed: 0.6,
                    rotationSpeed: 0.02,
                    fadeStartTime: 3000,
                    fadeOutDuration: 5000,
                    spawnRadius: 50,
                    spawnPattern: 'explosion', // Clouds burst outward
                    wobbleAmount: 15,
                    greenTint: true,
                    particleTrail: true,
                    trailColor: 'rgba(107, 142, 35, 0.2)' // Olive green trail
                }
            },
            'thunderstorm': {
                type: 'thunderstorm_rain',
                duration: 68000, // 68 seconds to match sound effect
                config: {
                    rainIntensity: 200,
                    lightningFrequency: 'moderate',
                    opacity: 0.8
                }
            }
        };

const CANVAS_INTERACTION_CONFIGS = {
            'tomato': {
                mode: 'click-to-throw',
                cursor: 'crosshair',
                indicator: '🍅 Click anywhere to throw {itemName}!',
                chatMessage: '{username} threw a tomato! 🍅',
                borderColor: 'rgba(255, 0, 0, 0.8)',
                glowColor: 'rgba(255, 0, 0, 0.5)'
            },
            'snowball': {
                mode: 'click-to-throw',
                cursor: 'crosshair',
                indicator: '❄️ Click anywhere to throw {itemName}!',
                chatMessage: '{username} threw a snowball! ❄️',
                borderColor: 'rgba(0, 150, 255, 0.8)',
                glowColor: 'rgba(0, 150, 255, 0.5)'
            },
            'paint_balloon': {
                mode: 'click-to-throw',
                cursor: 'crosshair',
                indicator: '🎨 Click anywhere to throw {itemName}!',
                chatMessage: '{username} threw a paint balloon! 🎨',
                borderColor: 'rgba(255, 100, 255, 0.8)',
                glowColor: 'rgba(255, 100, 255, 0.5)'
            },
            'water_balloon': {
                mode: 'click-to-throw',
                cursor: 'crosshair',
                indicator: '💧 Click anywhere to throw {itemName}!',
                chatMessage: '{username} threw a water balloon! 💧',
                borderColor: 'rgba(0, 200, 255, 0.8)',
                glowColor: 'rgba(0, 200, 255, 0.5)'
            },
            'confetti_cannon': {
                mode: 'click-to-throw',
                cursor: 'crosshair',
                indicator: '🎊 Click anywhere to fire {itemName}!',
                chatMessage: '{username} fired a confetti cannon! 🎊',
                borderColor: 'rgba(255, 215, 0, 0.8)',
                glowColor: 'rgba(255, 215, 0, 0.5)'
            },
            'smoke_bomb': {
                mode: 'click-to-throw',
                cursor: 'crosshair',
                indicator: '💨 Click anywhere to deploy {itemName}!',
                chatMessage: '{username} deployed a smoke bomb! 💨',
                borderColor: 'rgba(128, 128, 128, 0.8)',
                glowColor: 'rgba(128, 128, 128, 0.5)'
            },
            'disco_ball': {
                mode: 'click-to-throw',
                cursor: 'pointer',
                indicator: '🪩 Click anywhere to drop {itemName}!',
                chatMessage: '{username} dropped a disco ball! 🪩',
                borderColor: 'rgba(255, 0, 255, 0.8)',
                glowColor: 'rgba(255, 0, 255, 0.5)'
            },
            'spotlight': {
                mode: 'click-to-throw',
                cursor: 'crosshair',
                indicator: '🌟 Click anywhere to shine {itemName}!',
                chatMessage: '{username} activated a spotlight! 🌟',
                borderColor: 'rgba(255, 255, 0, 0.8)',
                glowColor: 'rgba(255, 255, 0, 0.5)'
            },
            'rainbow_effect': {
                mode: 'click-to-throw',
                cursor: 'pointer',
                indicator: '🌈 Click anywhere to create {itemName}!',
                chatMessage: '{username} created a rainbow effect! 🌈',
                borderColor: 'rgba(255, 0, 128, 0.8)',
                glowColor: 'rgba(255, 0, 128, 0.5)'
            },
            'red_marker': {
                mode: 'click-to-draw',
                cursor: 'crosshair',
                indicator: '🔴 Click and drag to draw on the stream!',
                chatMessage: '{username} is drawing on the stream! 🔴',
                borderColor: 'rgba(255, 0, 0, 0.8)',
                glowColor: 'rgba(255, 0, 0, 0.5)',
                drawingMode: true,
                drawDuration: 10000,
                displayDuration: 10000
            },
            'blue_marker': {
                mode: 'click-to-draw',
                cursor: 'crosshair',
                indicator: '🔵 Click and drag to draw on the stream!',
                chatMessage: '{username} is drawing on the stream! 🔵',
                borderColor: 'rgba(0, 0, 255, 0.8)',
                glowColor: 'rgba(0, 0, 255, 0.5)',
                drawingMode: true,
                drawDuration: 10000,
                displayDuration: 10000
            },
            'green_marker': {
                mode: 'click-to-draw',
                cursor: 'crosshair',
                indicator: '🟢 Click and drag to draw on the stream!',
                chatMessage: '{username} is drawing on the stream! 🟢',
                borderColor: 'rgba(0, 170, 0, 0.8)',
                glowColor: 'rgba(0, 170, 0, 0.5)',
                drawingMode: true,
                drawDuration: 10000,
                displayDuration: 10000
            },
            'yellow_marker': {
                mode: 'click-to-draw',
                cursor: 'crosshair',
                indicator: '🟡 Click and drag to draw on the stream!',
                chatMessage: '{username} is drawing on the stream! 🟡',
                borderColor: 'rgba(255, 221, 0, 0.8)',
                glowColor: 'rgba(255, 221, 0, 0.5)',
                drawingMode: true,
                drawDuration: 10000,
                displayDuration: 10000
            },
            'purple_marker': {
                mode: 'click-to-draw',
                cursor: 'crosshair',
                indicator: '🟣 Click and drag to draw on the stream!',
                chatMessage: '{username} is drawing on the stream! 🟣',
                borderColor: 'rgba(170, 0, 170, 0.8)',
                glowColor: 'rgba(170, 0, 170, 0.5)',
                drawingMode: true,
                drawDuration: 10000,
                displayDuration: 10000
            },
            'orange_marker': {
                mode: 'click-to-draw',
                cursor: 'crosshair',
                indicator: '🟠 Click and drag to draw on the stream!',
                chatMessage: '{username} is drawing on the stream! 🟠',
                borderColor: 'rgba(255, 136, 0, 0.8)',
                glowColor: 'rgba(255, 136, 0, 0.5)',
                drawingMode: true,
                drawDuration: 10000,
                displayDuration: 10000
            },
            'pink_marker': {
                mode: 'click-to-draw',
                cursor: 'crosshair',
                indicator: '🩷 Click and drag to draw on the stream!',
                chatMessage: '{username} is drawing on the stream! 🩷',
                borderColor: 'rgba(255, 105, 180, 0.8)',
                glowColor: 'rgba(255, 105, 180, 0.5)',
                drawingMode: true,
                drawDuration: 10000,
                displayDuration: 10000
            },
            'black_marker': {
                mode: 'click-to-draw',
                cursor: 'crosshair',
                indicator: '⚫ Click and drag to draw on the stream!',
                chatMessage: '{username} is drawing on the stream! ⚫',
                borderColor: 'rgba(0, 0, 0, 0.8)',
                glowColor: 'rgba(64, 64, 64, 0.5)',
                drawingMode: true,
                drawDuration: 10000,
                displayDuration: 10000
            },
            'white_marker': {
                mode: 'click-to-draw',
                cursor: 'crosshair',
                indicator: '⚪ Click and drag to draw on the stream!',
                chatMessage: '{username} is drawing on the stream! ⚪',
                borderColor: 'rgba(255, 255, 255, 0.8)',
                glowColor: 'rgba(255, 255, 255, 0.5)',
                drawingMode: true,
                drawDuration: 10000,
                displayDuration: 10000
            },
            'rainbow_marker': {
                mode: 'click-to-draw',
                cursor: 'crosshair',
                indicator: '🌈 Click and drag to draw on the stream!',
                chatMessage: '{username} is drawing on the stream! 🌈',
                borderColor: 'rgba(255, 0, 128, 0.8)',
                glowColor: 'rgba(255, 0, 128, 0.5)',
                drawingMode: true,
                drawDuration: 10000,
                displayDuration: 10000
            },
            'heart_swarm': {
                mode: 'click-to-throw',
                cursor: 'crosshair',
                indicator: '💕 Click anywhere to release hearts!',
                chatMessage: '{username} released a heart swarm! 💕',
                borderColor: 'rgba(255, 105, 180, 0.8)',
                glowColor: 'rgba(255, 105, 180, 0.5)'
            },
            'arrow': {
                mode: 'click-to-throw',
                cursor: 'crosshair',
                indicator: '🏹 Click anywhere to fire an arrow!',
                chatMessage: '{username} fired an arrow! 🏹',
                borderColor: 'rgba(139, 69, 19, 0.8)',
                glowColor: 'rgba(139, 69, 19, 0.5)'
            },
            'molotov': {
                mode: 'click-to-throw',
                cursor: 'crosshair',
                indicator: '🔥 Click anywhere to throw a Molotov cocktail!',
                chatMessage: '{username} threw a Molotov cocktail! 🔥',
                borderColor: 'rgba(255, 69, 0, 0.8)',
                glowColor: 'rgba(255, 69, 0, 0.5)'
            },
            'lsd': {
                mode: 'click-to-throw',
                cursor: 'crosshair',
                indicator: '🌈 Click anywhere to drop acid!',
                chatMessage: '{username} is taking everyone on a trip! 🌈',
                borderColor: 'rgba(255, 0, 255, 0.8)',
                glowColor: 'rgba(255, 0, 255, 0.5)'
            },
            'bugs': {
                mode: 'click-to-throw',
                cursor: 'crosshair',
                indicator: '🐛 Click to release the bugs!',
                chatMessage: '{username} released a bug infestation! 🐛',
                borderColor: 'rgba(101, 67, 33, 0.8)',
                glowColor: 'rgba(101, 67, 33, 0.5)'
            },
            'fart': {
                mode: 'auto-trigger',
                cursor: 'default',
                indicator: '💨 Releasing fart cloud!',
                chatMessage: '{username} let one rip! 💨',
                borderColor: 'rgba(139, 90, 43, 0.6)',
                glowColor: 'rgba(107, 142, 35, 0.4)',
                autoTrigger: true,
                triggerDelay: 500
            }
        };

module.exports = { CANVAS_EFFECT_MAPPINGS, CANVAS_INTERACTION_CONFIGS };
