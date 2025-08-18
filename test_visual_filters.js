/**
 * Test script to verify all visual filter effects are working
 * This will apply each effect one by one to test both streamer and viewer experience
 */

const io = require('socket.io-client');

// List of all visual filter effects
const visualEffects = [
  // CSS-based effects (client-side)
  { id: 'blur', name: 'Motion Blur', clientSide: true },
  { id: 'grayscale', name: 'Black & White', clientSide: true },
  { id: 'sepia', name: 'Sepia Tone', clientSide: true },
  { id: 'invert', name: 'Invert Colors', clientSide: true },
  { id: 'brightness_dark', name: 'Darkness', clientSide: true },
  { id: 'brightness_bright', name: 'Overexposed', clientSide: true },
  { id: 'contrast_low', name: 'Low Contrast', clientSide: true },
  { id: 'contrast_high', name: 'High Contrast', clientSide: true },
  { id: 'saturate', name: 'Oversaturated', clientSide: true },
  { id: 'desaturate', name: 'Desaturated', clientSide: true },
  { id: 'hue_rotate', name: 'Hue Shift', clientSide: true },
  { id: 'mirror', name: 'Mirror', clientSide: true },
  { id: 'flip_vertical', name: 'Upside Down', clientSide: true },
  { id: 'rotate_90', name: 'Rotate 90°', clientSide: true },
  { id: 'vintage', name: 'Vintage Film', clientSide: true },
  { id: 'thermal', name: 'Thermal Vision', clientSide: true },
  { id: 'vignette', name: 'Vignette', clientSide: true },
  { id: 'edge_detect', name: 'Edge Detection', clientSide: true },
  { id: 'emboss', name: 'Emboss', clientSide: true },
  { id: 'wave', name: 'Wave Distortion', clientSide: true },
  { id: 'wobble', name: 'Wobble', clientSide: true },
  
  // Server-side effects (require stream processing)
  { id: 'resolution_240p', name: 'Ultra Low Resolution', clientSide: false },
  { id: 'resolution_360p', name: 'Low Resolution', clientSide: false },
  { id: 'bitrate_potato', name: 'Potato Quality', clientSide: false },
  { id: 'framerate_slideshow', name: 'Slideshow Mode', clientSide: false },
  { id: 'pixelate', name: 'Pixelation', clientSide: false },
  { id: 'static_noise', name: 'TV Static', clientSide: false },
  { id: 'glitch', name: 'Digital Glitch', clientSide: false }
];

async function testVisualFilters() {
  console.log('🎨 VISUAL FILTER TEST: Starting comprehensive visual filter test...');
  console.log(`📋 Total effects to test: ${visualEffects.length}`);
  console.log(`📋 Client-side effects: ${visualEffects.filter(e => e.clientSide).length}`);
  console.log(`📋 Server-side effects: ${visualEffects.filter(e => !e.clientSide).length}`);
  console.log('');
  
  // Connect as authenticated client (simulating streamer)
  const token = process.env.AUTH_TOKEN || 'test-token';
  const socket = io('http://localhost:8080', {
    transports: ['websocket', 'polling'],
    auth: {
      token: token
    }
  });

  socket.on('connect', () => {
    console.log('✅ Connected to server, socket ID:', socket.id);
    console.log('');
    
    // Start testing effects after a short delay
    setTimeout(() => {
      testNextEffect(0);
    }, 2000);
  });

  socket.on('visual-effect-success', (data) => {
    console.log('✅ Effect applied successfully:', data.effect?.config?.name);
  });

  socket.on('visual-effect-error', (data) => {
    console.error('❌ Effect failed:', data.error);
  });

  socket.on('visual-effect-applied', (data) => {
    const effectType = data.requiresViewSwitch ? 'server-side' : 'client-side';
    console.log(`📺 Effect applied notification received: ${data.effectName} (${effectType})`);
    console.log(`   - Effect ID: ${data.effectId}`);
    console.log(`   - Duration: ${data.duration}ms`);
    console.log(`   - Requires stream switch: ${data.requiresViewSwitch}`);
    console.log(`   - Applied to streamer: ${data.applyToStreamer}`);
  });

  socket.on('visual-effects-cleared', () => {
    console.log('🧹 All visual effects cleared');
  });

  socket.on('connect_error', (error) => {
    console.error('❌ Connection failed:', error.message);
    process.exit(1);
  });

  let currentEffectIndex = 0;
  
  function testNextEffect(index) {
    if (index >= visualEffects.length) {
      console.log('');
      console.log('✅ All effects tested! Clearing effects and disconnecting...');
      
      // Clear all effects
      socket.emit('clear-visual-effects');
      
      setTimeout(() => {
        socket.disconnect();
        console.log('');
        console.log('🎯 VISUAL FILTER TEST COMPLETE!');
        console.log('');
        console.log('📊 TEST RESULTS:');
        console.log('================');
        console.log('Please check the browser to verify:');
        console.log('1. Client-side CSS filters applied instantly to streamer view');
        console.log('2. Server-side effects triggered stream view switching');
        console.log('3. All effects were visible to viewers');
        console.log('4. "Clear All" button properly removed all effects');
        process.exit(0);
      }, 2000);
      return;
    }
    
    const effect = visualEffects[index];
    const effectType = effect.clientSide ? 'CLIENT-SIDE' : 'SERVER-SIDE';
    
    console.log('');
    console.log(`🎨 Testing effect ${index + 1}/${visualEffects.length}: ${effect.name}`);
    console.log(`   Type: ${effectType}`);
    console.log(`   ID: ${effect.id}`);
    
    // Apply the effect
    socket.emit('apply-visual-effect', {
      effectId: effect.id,
      duration: 5000 // 5 seconds for testing
    });
    
    // Move to next effect after delay
    setTimeout(() => {
      // Clear the effect before moving to next
      socket.emit('clear-visual-effects');
      
      setTimeout(() => {
        testNextEffect(index + 1);
      }, 1000);
    }, 6000);
  }

  socket.on('disconnect', () => {
    console.log('🔌 Disconnected from server');
  });
}

// Display instructions
console.log('');
console.log('===========================================');
console.log('    VISUAL FILTER COMPREHENSIVE TEST');
console.log('===========================================');
console.log('');
console.log('This test will:');
console.log('1. Apply each visual effect one by one');
console.log('2. Test both client-side CSS filters and server-side effects');
console.log('3. Verify streamer view switching for server-side effects');
console.log('4. Clear effects between each test');
console.log('');
console.log('⚠️  Make sure:');
console.log('   - The server is running (npm run dev)');
console.log('   - You have a browser open with a stream active');
console.log('   - You are watching both streamer and viewer perspectives');
console.log('');
console.log('Starting test in 3 seconds...');
console.log('');

setTimeout(() => {
  testVisualFilters().catch(console.error);
}, 3000);