const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');
const db = new sqlite3.Database(dbPath);

console.log('🔍 Testing CanvasFx Integration\n');

// Check if tomato item exists
db.get(`SELECT * FROM items WHERE name = 'tomato'`, (err, item) => {
  if (err) {
    console.error('❌ Error checking for tomato item:', err);
  } else if (item) {
    console.log('✅ Tomato item found in database:');
    console.log(`   Name: ${item.display_name} ${item.emoji}`);
    console.log(`   Price: ${item.base_price} points`);
    console.log(`   Cooldown: ${item.cooldown_seconds}s`);
    console.log(`   Type: ${item.item_type}`);
    console.log(`   Rarity: ${item.rarity}`);
    console.log(`   Max Stack: ${item.max_stack}`);
  } else {
    console.log('⚠️ Tomato item not found, adding it now...');
    
    // Add tomato item
    db.run(`
      INSERT INTO items (
        name, display_name, emoji, description, item_type, 
        rarity, base_price, is_purchasable, is_active, 
        cooldown_seconds, max_stack
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'tomato', 'Tomato', '🍅', 'Throw a tomato at the stream', 'utility',
        'common', 25, 1, 1, 10, 20
      ],
      function(err) {
        if (err) {
          console.error('❌ Error adding tomato item:', err);
        } else {
          console.log('✅ Tomato item added successfully!');
          console.log(`   Item ID: ${this.lastID}`);
        }
      }
    );
  }
});

// Check all items with visual effects
console.log('\n📋 Items with visual effects:');
const visualEffectItems = [
  'tomato', 'confetti_cannon', 'smoke_bomb', 'rainbow_effect', 
  'disco_ball', 'spotlight', 'freeze_frame', 'speed_boost', 
  'slow_mode', 'golden_mic'
];

db.all(`SELECT name, display_name, emoji, item_type, base_price 
        FROM items 
        WHERE name IN (${visualEffectItems.map(() => '?').join(',')})
        AND is_active = 1`, 
  visualEffectItems,
  (err, items) => {
    if (err) {
      console.error('❌ Error fetching items:', err);
    } else {
      items.forEach(item => {
        console.log(`   ${item.emoji} ${item.display_name} (${item.name}) - ${item.base_price} points`);
      });
      console.log(`\n   Total: ${items.length} visual effect items available`);
    }
    
    db.close();
  }
);

console.log('\n💡 Testing Instructions:');
console.log('1. Open the application in your browser');
console.log('2. Log in with a test account');
console.log('3. Open the inventory/shop panel');
console.log('4. Purchase and use the Tomato item');
console.log('5. You should see a red splat effect on the stream');
console.log('\n🐛 Debug Mode:');
console.log('Press Ctrl+Shift+D while viewing a stream to enable debug mode');
console.log('In debug mode, click anywhere on the stream to test the tomato effect');