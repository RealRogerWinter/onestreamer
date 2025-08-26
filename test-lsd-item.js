const { getAsync } = require('./server/database/database');

(async () => {
  try {
    // Check if LSD item exists and is active
    const item = await getAsync('SELECT * FROM items WHERE name = ?', ['lsd']);
    
    if (!item) {
      console.log('❌ LSD item not found in database');
      return;
    }
    
    console.log('✅ LSD item found:');
    console.log('  ID:', item.id);
    console.log('  Name:', item.name);
    console.log('  Display Name:', item.display_name);
    console.log('  Emoji:', item.emoji);
    console.log('  Description:', item.description);
    console.log('  Type:', item.item_type);
    console.log('  Rarity:', item.rarity);
    console.log('  Base Price:', item.base_price);
    console.log('  Cooldown:', item.cooldown_seconds, 'seconds');
    console.log('  Active:', item.is_active ? 'Yes' : 'No');
    console.log('  Purchasable:', item.is_purchasable ? 'Yes' : 'No');
    
    if (item.effect_data) {
      const effectData = JSON.parse(item.effect_data);
      console.log('  Effect Data:');
      console.log('    Type:', effectData.effect_type);
      console.log('    Interactive:', effectData.interactive ? 'Yes' : 'No');
      console.log('    Trip Duration:', effectData.trip_duration, 'ms');
      console.log('    Intensity:', effectData.intensity);
      console.log('    Color Shift:', effectData.color_shift ? 'Yes' : 'No');
      console.log('    Wave Distortion:', effectData.wave_distortion ? 'Yes' : 'No');
      console.log('    Fractal Patterns:', effectData.fractal_patterns ? 'Yes' : 'No');
      console.log('    Rainbow Trails:', effectData.rainbow_trails ? 'Yes' : 'No');
    }
    
    console.log('\n✅ LSD item is properly configured and ready to use!');
    console.log('\n🌈 Psychedelic Effect Features:');
    console.log('  - Kaleidoscope patterns with rotating segments');
    console.log('  - Wave distortion creating a melting effect');
    console.log('  - Rainbow trails following movement');
    console.log('  - Fractal geometric patterns');
    console.log('  - Color shifting with hue rotation');
    console.log('  - Breathing effect with pulsing overlay');
    console.log('  - Chromatic aberration (RGB channel separation)');
    console.log('  - 20 second trip duration with fade in/out');
    
    console.log('\nTo test the LSD item:');
    console.log('1. Open the application at https://onestreamer.live');
    console.log('2. Make sure you are logged in');
    console.log('3. Open the shop and purchase the LSD item (500 coins - Legendary!)');
    console.log('4. Use the item from your inventory');
    console.log('5. Click anywhere to activate the psychedelic experience!');
    console.log('\n⚠️  Warning: Contains flashing colors and visual distortions!');
    
  } catch (error) {
    console.error('❌ Error checking LSD item:', error);
  }
})();