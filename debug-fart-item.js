const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');
const db = new sqlite3.Database(dbPath);

console.log('🔍 Debugging Fart Item Configuration\n');

// Check if fart item exists and its configuration
db.get(`
    SELECT 
        i.*,
        si.price as shop_price,
        si.id as shop_item_id
    FROM items i
    LEFT JOIN shop_items si ON si.item_id = i.id
    WHERE i.name = 'fart'
`, (err, item) => {
    if (err) {
        console.error('❌ Error querying fart item:', err);
        db.close();
        return;
    }
    
    if (!item) {
        console.log('❌ Fart item not found in database');
        db.close();
        return;
    }
    
    console.log('✅ Fart item found in database:');
    console.log('==================================');
    console.log(`ID: ${item.id}`);
    console.log(`Name: ${item.name}`);
    console.log(`Display Name: ${item.display_name}`);
    console.log(`Emoji: ${item.emoji}`);
    console.log(`Description: ${item.description}`);
    console.log(`Item Type: ${item.item_type}`);
    console.log(`Category: ${item.category}`);
    console.log(`Rarity: ${item.rarity}`);
    console.log(`Base Price: ${item.base_price}`);
    console.log(`Shop Price: ${item.shop_price}`);
    console.log(`Is Purchasable: ${item.is_purchasable}`);
    console.log(`Is Active: ${item.is_active}`);
    console.log(`Cooldown: ${item.cooldown_seconds} seconds`);
    console.log(`Max Stack: ${item.max_stack}`);
    console.log(`Shop Item ID: ${item.shop_item_id}`);
    
    if (item.effect_data) {
        console.log('\nEffect Data:');
        try {
            const effectData = JSON.parse(item.effect_data);
            console.log(JSON.stringify(effectData, null, 2));
        } catch (e) {
            console.log('Raw effect data:', item.effect_data);
        }
    }
    
    // Check if any users have this item in inventory
    console.log('\n📦 Checking user inventories for fart item:');
    db.all(`
        SELECT 
            ui.user_id,
            ui.quantity,
            u.username
        FROM user_inventory ui
        JOIN users u ON u.id = ui.user_id
        WHERE ui.item_id = ?
    `, [item.id], (err, inventories) => {
        if (err) {
            console.error('❌ Error checking inventories:', err);
        } else if (inventories.length === 0) {
            console.log('No users currently have the fart item in inventory');
        } else {
            console.log(`Found ${inventories.length} users with fart item:`);
            inventories.forEach(inv => {
                console.log(`  - ${inv.username}: ${inv.quantity} items`);
            });
        }
        
        // Check recent usage attempts
        console.log('\n📊 Checking recent item usage logs:');
        db.all(`
            SELECT 
                iul.*,
                u.username
            FROM item_usage_log iul
            LEFT JOIN users u ON u.id = iul.user_id
            WHERE iul.item_id = ?
            ORDER BY iul.used_at DESC
            LIMIT 5
        `, [item.id], (err, usages) => {
            if (err) {
                console.error('❌ Error checking usage logs:', err);
            } else if (usages.length === 0) {
                console.log('No usage logs found for fart item');
            } else {
                console.log(`Found ${usages.length} recent usage attempts:`);
                usages.forEach(usage => {
                    console.log(`  - ${usage.username} used at ${usage.used_at}`);
                });
            }
            
            console.log('\n🔧 Configuration Summary:');
            if (item.is_active && item.is_purchasable && item.shop_item_id) {
                console.log('✅ Item is properly configured for shop and usage');
            } else {
                console.log('⚠️  Issues found:');
                if (!item.is_active) console.log('  - Item is not active');
                if (!item.is_purchasable) console.log('  - Item is not purchasable');
                if (!item.shop_item_id) console.log('  - Item is not in shop_items table');
            }
            
            console.log('\n💡 Testing recommendations:');
            console.log('1. Purchase the item from the shop (50 points)');
            console.log('2. Check browser console for errors when clicking');
            console.log('3. Check network tab for API calls');
            console.log('4. Monitor server logs: pm2 logs onestreamer-server --lines 50');
            
            db.close();
        });
    });
});