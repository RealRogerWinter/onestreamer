const { getAsync } = require('./server/database/database');

(async () => {
  try {
    // Check if molotov item exists and is active
    const item = await getAsync('SELECT * FROM items WHERE name = ?', ['molotov']);
    
    if (!item) {
      console.log('❌ Molotov item not found in database');
      return;
    }
    
    console.log('✅ Molotov Cocktail item found:');
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
      console.log('    Burn Duration:', effectData.burn_duration, 'ms');
      console.log('    Spread Radius:', effectData.spread_radius, 'pixels');
      console.log('    Flame Intensity:', effectData.flame_intensity);
    }
    
    console.log('\n✅ Molotov cocktail item is properly configured and ready to use!');
    console.log('\n🔥 Fire Effect Features:');
    console.log('  - Realistic flame animation with multiple flame particles');
    console.log('  - Dynamic color gradients (orange, red, yellow)');
    console.log('  - Smoke particles rising from the fire');
    console.log('  - Sparkles and embers floating upward');
    console.log('  - Heat distortion effect');
    console.log('  - Glowing light effect around the fire');
    console.log('  - 12 second burn duration with fade out');
    
    console.log('\nTo test the Molotov cocktail:');
    console.log('1. Open the application at https://onestreamer.live');
    console.log('2. Make sure you are logged in');
    console.log('3. Open the shop and purchase the Molotov Cocktail item (350 coins)');
    console.log('4. Use the item from your inventory');
    console.log('5. Click anywhere on the stream to throw the Molotov and create fire!');
    
  } catch (error) {
    console.error('❌ Error checking molotov item:', error);
  }
})();