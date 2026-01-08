#!/usr/bin/env node

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');
const db = new sqlite3.Database(dbPath);

// Command line arguments
const [,, action, ...args] = process.argv;

function listShopItems() {
    db.all(`
        SELECT 
            si.id as shop_id,
            si.item_id,
            si.price,
            si.discount_percentage,
            si.is_featured,
            i.name,
            i.display_name,
            i.emoji,
            i.rarity,
            i.category
        FROM shop_items si
        JOIN items i ON si.item_id = i.id
        ORDER BY si.is_featured DESC, i.category, i.name
    `, (err, rows) => {
        if (err) {
            console.error('Error listing shop items:', err);
            process.exit(1);
        }
        
        console.log('\n📦 Current Shop Items:\n');
        console.log('ID | Item ID | Name | Display Name | Price | Discount | Featured | Category');
        console.log('-'.repeat(100));
        
        rows.forEach(row => {
            const featured = row.is_featured ? '⭐' : '';
            const discount = row.discount_percentage > 0 ? `${row.discount_percentage}%` : '-';
            console.log(`${row.shop_id} | ${row.item_id} | ${row.name} | ${row.emoji} ${row.display_name} | ${row.price} | ${discount} | ${featured} | ${row.category}`);
        });
        
        db.close();
    });
}

function listAvailableItems() {
    db.all(`
        SELECT 
            id,
            name,
            display_name,
            emoji,
            base_price,
            category,
            rarity,
            is_purchasable
        FROM items
        WHERE id NOT IN (SELECT item_id FROM shop_items)
        AND is_active = 1
        ORDER BY category, name
    `, (err, rows) => {
        if (err) {
            console.error('Error listing available items:', err);
            process.exit(1);
        }
        
        console.log('\n🛒 Items Not In Shop:\n');
        console.log('ID | Name | Display Name | Base Price | Category | Rarity | Purchasable');
        console.log('-'.repeat(100));
        
        rows.forEach(row => {
            const purchasable = row.is_purchasable ? '✅' : '❌';
            console.log(`${row.id} | ${row.name} | ${row.emoji} ${row.display_name} | ${row.base_price} | ${row.category} | ${row.rarity} | ${purchasable}`);
        });
        
        db.close();
    });
}

function addToShop(itemId, price, featured = false, discount = 0) {
    if (!itemId || !price) {
        console.error('Usage: node manage-shop.js add <item_id> <price> [featured] [discount]');
        process.exit(1);
    }
    
    // First check if item exists
    db.get('SELECT * FROM items WHERE id = ?', [itemId], (err, item) => {
        if (err) {
            console.error('Error checking item:', err);
            db.close();
            process.exit(1);
        }
        
        if (!item) {
            console.error(`❌ Item with ID ${itemId} not found`);
            db.close();
            process.exit(1);
        }
        
        // Check if already in shop
        db.get('SELECT * FROM shop_items WHERE item_id = ?', [itemId], (err, existing) => {
            if (err) {
                console.error('Error checking shop:', err);
                db.close();
                process.exit(1);
            }
            
            if (existing) {
                console.log(`⚠️  Item "${item.display_name}" is already in shop. Use 'update' command to modify.`);
                db.close();
                return;
            }
            
            // Add to shop
            db.run(`
                INSERT INTO shop_items (item_id, price, is_featured, discount_percentage)
                VALUES (?, ?, ?, ?)
            `, [itemId, price, featured ? 1 : 0, discount], function(err) {
                if (err) {
                    console.error('Error adding to shop:', err);
                } else {
                    console.log(`✅ Added "${item.emoji} ${item.display_name}" to shop with price ${price}`);
                    if (featured) console.log('   ⭐ Featured item');
                    if (discount > 0) console.log(`   💸 ${discount}% discount`);
                }
                db.close();
            });
        });
    });
}

function removeFromShop(shopId) {
    if (!shopId) {
        console.error('Usage: node manage-shop.js remove <shop_id>');
        process.exit(1);
    }
    
    db.get(`
        SELECT si.*, i.display_name, i.emoji
        FROM shop_items si
        JOIN items i ON si.item_id = i.id
        WHERE si.id = ?
    `, [shopId], (err, row) => {
        if (err) {
            console.error('Error finding shop item:', err);
            db.close();
            process.exit(1);
        }
        
        if (!row) {
            console.error(`❌ Shop item with ID ${shopId} not found`);
            db.close();
            process.exit(1);
        }
        
        db.run('DELETE FROM shop_items WHERE id = ?', [shopId], function(err) {
            if (err) {
                console.error('Error removing from shop:', err);
            } else {
                console.log(`✅ Removed "${row.emoji} ${row.display_name}" from shop`);
            }
            db.close();
        });
    });
}

function updateShopItem(shopId, field, value) {
    if (!shopId || !field || value === undefined) {
        console.error('Usage: node manage-shop.js update <shop_id> <field> <value>');
        console.error('Fields: price, discount_percentage, is_featured');
        process.exit(1);
    }
    
    const allowedFields = ['price', 'discount_percentage', 'is_featured'];
    if (!allowedFields.includes(field)) {
        console.error(`❌ Invalid field. Allowed fields: ${allowedFields.join(', ')}`);
        process.exit(1);
    }
    
    // Convert boolean strings for is_featured
    if (field === 'is_featured') {
        value = value === 'true' || value === '1' ? 1 : 0;
    }
    
    db.run(`UPDATE shop_items SET ${field} = ? WHERE id = ?`, [value, shopId], function(err) {
        if (err) {
            console.error('Error updating shop item:', err);
        } else if (this.changes === 0) {
            console.error(`❌ No shop item found with ID ${shopId}`);
        } else {
            console.log(`✅ Updated shop item ${shopId}: ${field} = ${value}`);
        }
        db.close();
    });
}

function addAllItems() {
    db.all(`
        SELECT id, name, display_name, base_price, emoji, rarity
        FROM items
        WHERE id NOT IN (SELECT item_id FROM shop_items)
        AND is_purchasable = 1
        AND is_active = 1
    `, (err, items) => {
        if (err) {
            console.error('Error finding items:', err);
            db.close();
            process.exit(1);
        }
        
        if (items.length === 0) {
            console.log('✅ All purchasable items are already in the shop');
            db.close();
            return;
        }
        
        console.log(`Adding ${items.length} items to shop...`);
        
        let added = 0;
        items.forEach((item, index) => {
            const isFeatured = item.rarity === 'epic' || item.rarity === 'legendary';
            const price = item.base_price || 100;
            
            db.run(`
                INSERT INTO shop_items (item_id, price, is_featured, discount_percentage)
                VALUES (?, ?, ?, 0)
            `, [item.id, price, isFeatured ? 1 : 0], function(err) {
                if (err) {
                    console.error(`Error adding ${item.display_name}:`, err.message);
                } else {
                    console.log(`✅ Added ${item.emoji} ${item.display_name} (${price} points)`);
                    added++;
                }
                
                if (index === items.length - 1) {
                    console.log(`\n🎉 Successfully added ${added} items to shop`);
                    db.close();
                }
            });
        });
    });
}

// Main command handler
switch(action) {
    case 'list':
        listShopItems();
        break;
    case 'available':
        listAvailableItems();
        break;
    case 'add':
        addToShop(args[0], args[1], args[2] === 'true', parseInt(args[3]) || 0);
        break;
    case 'remove':
        removeFromShop(args[0]);
        break;
    case 'update':
        updateShopItem(args[0], args[1], args[2]);
        break;
    case 'add-all':
        addAllItems();
        break;
    default:
        console.log(`
Shop Management Tool
===================

Commands:
  list                    - List all items currently in shop
  available               - List items not in shop
  add <id> <price> [featured] [discount] - Add item to shop
  remove <shop_id>        - Remove item from shop
  update <shop_id> <field> <value> - Update shop item
  add-all                 - Add all purchasable items to shop

Examples:
  node manage-shop.js list
  node manage-shop.js add 5 500
  node manage-shop.js add 10 1000 true 20  # Featured with 20% discount
  node manage-shop.js remove 3
  node manage-shop.js update 2 price 750
  node manage-shop.js update 2 is_featured true
  node manage-shop.js add-all
        `);
        db.close();
}