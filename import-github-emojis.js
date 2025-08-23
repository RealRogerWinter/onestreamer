const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Open database connection
const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');
console.log('📂 Opening database at:', dbPath);

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('❌ Error opening database:', err);
        process.exit(1);
    }
    console.log('✅ Database opened successfully');
    
    // Import emojis from the uploads directory
    importEmojis();
});

function importEmojis() {
    const emojiDir = path.join(__dirname, 'server', 'uploads', 'emojis');
    
    // Read all files from the emoji directory
    fs.readdir(emojiDir, (err, files) => {
        if (err) {
            console.error('❌ Error reading emoji directory:', err);
            process.exit(1);
        }
        
        // Filter only .avif files
        const emojiFiles = files.filter(file => file.endsWith('.avif'));
        console.log(`📦 Found ${emojiFiles.length} emoji files to import`);
        
        let completed = 0;
        let added = 0;
        let skipped = 0;
        let errors = 0;
        
        emojiFiles.forEach(file => {
            // Extract name without extension
            const nameWithoutExt = path.parse(file).name;
            
            // Use filename as both name and code
            const emojiName = nameWithoutExt;
            const emojiCode = nameWithoutExt.toLowerCase();
            
            // Determine category based on name patterns
            let category = 'general';
            if (nameWithoutExt.toLowerCase().includes('peepo') || nameWithoutExt.toLowerCase().includes('pepe')) {
                category = 'pepe';
            } else if (nameWithoutExt.toLowerCase().includes('ge') || nameWithoutExt.toLowerCase().includes('kek')) {
                category = 'memes';
            } else if (['monkas', 'madge', 'sadge', 'pog', 'hypers', 'copium'].some(pattern => 
                nameWithoutExt.toLowerCase().includes(pattern))) {
                category = 'reactions';
            } else if (nameWithoutExt.toLowerCase().includes('time')) {
                category = 'activities';
            }
            
            // Construct the URL path
            const url = `/uploads/emojis/${file}`;
            const filePath = `server/uploads/emojis/${file}`;
            
            // Insert into database
            db.run(`
                INSERT OR IGNORE INTO custom_emojis (name, code, file_path, url, category, is_active)
                VALUES (?, ?, ?, ?, ?, 1)
            `, [emojiName, emojiCode, filePath, url, category], function(err) {
                if (err) {
                    console.error(`❌ Error adding ${emojiName}:`, err);
                    errors++;
                } else if (this.changes > 0) {
                    console.log(`✅ Added ${emojiName} (:${emojiCode}:) - ${category}`);
                    added++;
                } else {
                    console.log(`⏭️  ${emojiName} already exists`);
                    skipped++;
                }
                
                completed++;
                if (completed === emojiFiles.length) {
                    // Show summary
                    console.log('\n📊 Import Summary:');
                    console.log(`  ✅ Added: ${added} emojis`);
                    console.log(`  ⏭️  Skipped: ${skipped} emojis (already exist)`);
                    console.log(`  ❌ Errors: ${errors} emojis`);
                    
                    // Show all emojis grouped by category
                    db.all(`
                        SELECT category, COUNT(*) as count, GROUP_CONCAT(code, ', ') as codes
                        FROM custom_emojis 
                        WHERE is_active = 1
                        GROUP BY category
                        ORDER BY category
                    `, (err, rows) => {
                        if (err) {
                            console.error('❌ Error fetching emoji summary:', err);
                        } else {
                            console.log('\n📦 Emojis by category:');
                            rows.forEach(row => {
                                console.log(`\n  ${row.category} (${row.count} emojis):`);
                                const codes = row.codes.split(', ');
                                // Display in chunks of 10 for readability
                                for (let i = 0; i < codes.length; i += 10) {
                                    const chunk = codes.slice(i, i + 10).map(code => `:${code}:`).join(' ');
                                    console.log(`    ${chunk}`);
                                }
                            });
                            
                            // Total count
                            db.get("SELECT COUNT(*) as total FROM custom_emojis WHERE is_active = 1", (err, row) => {
                                if (!err) {
                                    console.log(`\n✨ Total active emojis in database: ${row.total}`);
                                }
                                
                                db.close((err) => {
                                    if (err) {
                                        console.error('Error closing database:', err);
                                    } else {
                                        console.log('\n🎉 Import complete! All emojis from GitHub have been added.');
                                    }
                                });
                            });
                        }
                    });
                }
            });
        });
    });
}