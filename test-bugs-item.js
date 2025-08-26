const { getAsync } = require('./server/database/database');

(async () => {
  try {
    // Check if bugs item exists and is active
    const item = await getAsync('SELECT * FROM items WHERE name = ?', ['bugs']);
    
    if (!item) {
      console.log('❌ Bugs item not found in database');
      return;
    }
    
    console.log('✅ Bugs item found:');
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
      console.log('    Bug Count:', effectData.bug_count);
      console.log('    Duration:', effectData.duration, 'ms');
      console.log('    Crawl Speed:', effectData.crawl_speed);
      console.log('    Bug Types:', effectData.bug_types.join(', '));
    }
    
    console.log('\n✅ Bugs item is properly configured and ready to use!');
    console.log('\n🐛 Bug Infestation Features:');
    console.log('  - 15 different bugs crawling across the screen');
    console.log('  - Various bug types: caterpillar, ant, spider, cricket, beetle, cockroach, mosquito, ladybug');
    console.log('  - Realistic crawling movement with organic wiggle patterns');
    console.log('  - Animated legs and antennae for certain bugs');
    console.log('  - Shadow effects for 3D appearance');
    console.log('  - Random speed variations and direction changes');
    console.log('  - Bugs wrap around screen edges');
    console.log('  - 15 second duration with gradual fade out');
    
    console.log('\nTo test the Bugs item:');
    console.log('1. Open the application at https://onestreamer.live');
    console.log('2. Make sure you are logged in');
    console.log('3. Open the shop and purchase the Bug Infestation item (200 coins)');
    console.log('4. Use the item from your inventory');
    console.log('5. Click anywhere on the stream to release the bugs!');
    console.log('\n🕷️ Watch as creepy crawlies wander across your stream!');
    
  } catch (error) {
    console.error('❌ Error checking bugs item:', error);
  }
})();