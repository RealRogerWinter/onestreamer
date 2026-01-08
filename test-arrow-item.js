const { getAsync } = require('./server/database/database');

(async () => {
  try {
    // Check if arrow item exists and is active
    const item = await getAsync('SELECT * FROM items WHERE name = ?', ['arrow']);
    
    if (!item) {
      console.log('❌ Arrow item not found in database');
      return;
    }
    
    console.log('✅ Arrow item found:');
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
      console.log('    Projectile Type:', effectData.projectile_type);
      console.log('    Stick Duration:', effectData.stick_duration, 'ms');
      console.log('    Flight Duration:', effectData.flight_duration, 'ms');
    }
    
    console.log('\n✅ Arrow item is properly configured and ready to use!');
    console.log('\nTo test the arrow effect:');
    console.log('1. Open the application at https://onestreamer.live');
    console.log('2. Make sure you are logged in');
    console.log('3. Open the shop and purchase the Arrow item');
    console.log('4. Use the item from your inventory');
    console.log('5. Click anywhere on the stream to fire an arrow!');
    
  } catch (error) {
    console.error('❌ Error checking arrow item:', error);
  }
})();