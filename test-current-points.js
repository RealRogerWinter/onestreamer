const fetch = require('node-fetch');

async function testPoints() {
    console.log('🔍 Testing Current Points Display\n');
    console.log('=' .repeat(50));
    
    // Check what the API returns
    try {
        // You'll need to provide your auth token
        const response = await fetch('http://localhost:3001/api/auth/me', {
            headers: {
                'Authorization': 'Bearer YOUR_TOKEN_HERE'
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            console.log('\n📊 API Response:');
            console.log('User:', data.user?.username);
            console.log('Points from API:', data.stats?.points);
            console.log('\nFull stats:', data.stats);
        } else {
            console.log('❌ API request failed:', response.status);
            console.log('You need to provide a valid auth token');
        }
    } catch (error) {
        console.log('❌ Error:', error.message);
        console.log('\n⚠️  Make sure the server is running on port 3001');
    }
    
    // Check database directly
    const sqlite3 = require('sqlite3').verbose();
    const path = require('path');
    const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');
    const db = new sqlite3.Database(dbPath);
    
    db.get('SELECT * FROM user_stats WHERE user_id = 3', (err, row) => {
        if (row) {
            console.log('\n💾 Database Values:');
            console.log('Points in DB:', row.points);
            console.log('Stream time:', row.total_stream_time, 'seconds');
            console.log('View time:', row.total_view_time, 'seconds');
            console.log('Chat count:', row.chat_message_count);
            
            if (row.points === 2296868) {
                console.log('\n✅ Database has correct value (2.29M points)');
                console.log('❌ But server/client showing old value');
                console.log('\n🔧 SOLUTION: Restart the server!');
            }
        }
        db.close();
    });
}

testPoints();