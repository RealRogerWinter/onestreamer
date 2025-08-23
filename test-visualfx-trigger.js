#!/usr/bin/env node

const https = require('https');
const axios = require('axios');

// Create an HTTPS agent that accepts self-signed certificates
const agent = new https.Agent({
    rejectUnauthorized: false
});

async function triggerVisualEffect() {
    try {
        console.log('🎯 Testing Visual FX trigger through buff system...');
        
        // First, get the auth token (you may need to adjust this)
        // For testing, we'll use a direct database approach
        const sqlite3 = require('sqlite3').verbose();
        const db = new sqlite3.Database('/root/onestreamer/onestreamer.db');
        
        // Get a test user and item
        db.get(`
            SELECT u.id as user_id, u.username, i.id as item_id, i.name as item_name
            FROM users u, items i
            WHERE u.id = 1 AND i.name = 'darkness'
            LIMIT 1
        `, async (err, row) => {
            if (err || !row) {
                console.error('❌ Could not find test user or darkness item:', err);
                db.close();
                return;
            }
            
            console.log(`✅ Found user ${row.username} (ID: ${row.user_id}) and item ${row.item_name} (ID: ${row.item_id})`);
            
            // Now directly apply the buff using the BuffDebuffService
            // We'll simulate this by directly inserting into the database
            db.run(`
                INSERT INTO active_buffs (
                    user_id, item_id, applied_at, expires_at, 
                    remaining_seconds, is_active, applied_by_user_id
                ) VALUES (?, ?, datetime('now'), datetime('now', '+30 seconds'), 30, 1, ?)
            `, [row.user_id, row.item_id, row.user_id], function(insertErr) {
                if (insertErr) {
                    console.error('❌ Failed to insert buff:', insertErr);
                } else {
                    console.log(`✅ Buff inserted with ID ${this.lastID}`);
                    
                    // Now trigger the buff-applied event manually
                    console.log('📡 Sending HTTP request to trigger buff event...');
                    
                    // Make a request that would trigger the buff system to check
                    axios.get('https://onestreamer.live:8443/api/buffs/active', {
                        httpsAgent: agent,
                        headers: {
                            'Cookie': 'connect.sid=test' // May need real session
                        }
                    }).then(response => {
                        console.log('✅ Buff check triggered');
                        console.log('Active buffs:', response.data);
                    }).catch(error => {
                        console.log('⚠️ Could not check buffs:', error.message);
                    });
                }
                
                db.close();
            });
        });
        
    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

// Also test by emitting directly to the service
async function testDirectEmit() {
    console.log('\n🔧 Testing direct event emission...');
    
    try {
        // Import the services
        const BuffDebuffService = require('/root/onestreamer/server/services/BuffDebuffService');
        const VisualFxService = require('/root/onestreamer/server/services/VisualFxService');
        
        // Create instances
        const buffService = new BuffDebuffService();
        const visualFxService = new VisualFxService();
        
        // Set dependencies
        visualFxService.setDependencies(null, buffService, null, null, null, null);
        
        // Emit a test event
        console.log('📡 Emitting buff-applied event...');
        buffService.emit('buff-applied', {
            id: 999,
            user_id: 1,
            item_id: 1,
            item_name: 'darkness',
            display_name: 'Darkness',
            duration_seconds: 30,
            stream_id: 'test-stream-id'
        });
        
        console.log('✅ Event emitted');
        
        // Give it a moment to process
        setTimeout(() => {
            console.log('🏁 Test complete');
            process.exit(0);
        }, 2000);
        
    } catch (error) {
        console.error('❌ Direct emit error:', error.message);
    }
}

// Run both tests
triggerVisualEffect();
setTimeout(testDirectEmit, 3000);