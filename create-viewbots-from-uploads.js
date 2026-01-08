const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// Database path
const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');
const uploadsPath = path.join(__dirname, 'server', 'uploads');

// Open database
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    }
    console.log('Connected to database');
});

// Function to create a ViewBot for a video file
async function createViewBot(filename) {
    return new Promise((resolve, reject) => {
        // Generate bot ID similar to how the app does it
        const botId = `viewbot-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        
        // Extract a nice name from the filename
        const name = filename
            .replace('.mp4', '')
            .replace(/_\d{13}$/, '') // Remove timestamp
            .replace(/_/g, ' ')
            .replace(/\b\w/g, l => l.toUpperCase()); // Capitalize words
        
        // Create config object
        const config = {
            contentType: 'videoFile',
            videoFile: path.join(uploadsPath, filename),
            width: 1280,
            height: 720,
            frameRate: 30,
            videoBitrate: '1500k',
            audioBitrate: '128k',
            useGStreamer: true,
            autoStart: false,
            streamDuration: 0
        };
        
        const sql = `
            INSERT INTO viewbots 
            (bot_id, name, config, content_type, is_enabled, auto_start, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `;
        
        db.run(sql, [
            botId,
            name,
            JSON.stringify(config),
            'videoFile',
            1, // enabled
            0  // auto_start = false
        ], function(err) {
            if (err) {
                if (err.message.includes('UNIQUE constraint failed')) {
                    console.log(`⚠️  Skipping ${filename} - already exists`);
                    resolve(false);
                } else {
                    reject(err);
                }
            } else {
                console.log(`✅ Created ViewBot: ${name} (${botId})`);
                resolve(true);
            }
        });
    });
}

// Main function
async function main() {
    console.log('🤖 Creating ViewBots from uploads folder...\n');
    
    // Get all MP4 files from uploads
    const files = fs.readdirSync(uploadsPath)
        .filter(file => file.endsWith('.mp4'))
        .sort();
    
    console.log(`Found ${files.length} video files\n`);
    
    let created = 0;
    let skipped = 0;
    
    // Process files with a small delay to avoid database locks
    for (const file of files) {
        try {
            const result = await createViewBot(file);
            if (result) created++;
            else skipped++;
            
            // Small delay between operations
            await new Promise(resolve => setTimeout(resolve, 50));
        } catch (error) {
            console.error(`❌ Error creating ViewBot for ${file}:`, error.message);
        }
    }
    
    console.log('\n📊 Summary:');
    console.log(`   Created: ${created} ViewBots`);
    console.log(`   Skipped: ${skipped} (already existed)`);
    console.log(`   Total ViewBots: ${created + skipped}`);
    
    // Close database
    db.close((err) => {
        if (err) {
            console.error('Error closing database:', err);
        } else {
            console.log('\n✅ Database closed. ViewBots created successfully!');
            console.log('🎬 Restart the server to load the new ViewBots');
        }
    });
}

// Run the script
main().catch(error => {
    console.error('Fatal error:', error);
    db.close();
    process.exit(1);
});