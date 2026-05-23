const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Open database connection
const dbPath = path.join(__dirname, '..', '..', 'server', 'data', 'onestreamer.db');
console.log('📂 Opening database at:', dbPath);

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('❌ Error opening database:', err);
        process.exit(1);
    }
    console.log('✅ Database opened successfully');
    
    // Add sample emojis
    addSampleEmojis();
});

function addSampleEmojis() {
    // Sample emojis for testing (using placeholder URLs - in production, you'd upload actual files)
    const sampleEmojis = [
        { name: 'Kek', code: 'kek', category: 'memes', url: '/uploads/emojis/kek.png' },
        { name: 'PogChamp', code: 'pogchamp', category: 'reactions', url: '/uploads/emojis/pogchamp.png' },
        { name: 'MonkaS', code: 'monkas', category: 'reactions', url: '/uploads/emojis/monkas.png' },
        { name: 'PepeHands', code: 'pepehands', category: 'reactions', url: '/uploads/emojis/pepehands.png' },
        { name: 'KEKW', code: 'kekw', category: 'memes', url: '/uploads/emojis/kekw.png' },
        { name: 'EZ', code: 'ez', category: 'general', url: '/uploads/emojis/ez.png' },
        { name: 'NotLikeThis', code: 'notlikethis', category: 'reactions', url: '/uploads/emojis/notlikethis.png' },
        { name: 'LUL', code: 'lul', category: 'memes', url: '/uploads/emojis/lul.png' }
    ];
    
    console.log('📝 Adding sample emojis...');
    
    let completed = 0;
    sampleEmojis.forEach(emoji => {
        db.run(`
            INSERT OR IGNORE INTO custom_emojis (name, code, file_path, url, category, is_active)
            VALUES (?, ?, ?, ?, ?, 1)
        `, [emoji.name, emoji.code, '', emoji.url, emoji.category], function(err) {
            if (err) {
                console.error(`❌ Error adding ${emoji.name}:`, err);
            } else if (this.changes > 0) {
                console.log(`✅ Added ${emoji.name} (:${emoji.code}:)`);
            } else {
                console.log(`⏭️ ${emoji.name} already exists`);
            }
            
            completed++;
            if (completed === sampleEmojis.length) {
                // Show all emojis
                db.all("SELECT name, code, category FROM custom_emojis ORDER BY category, name", (err, rows) => {
                    if (err) {
                        console.error('❌ Error fetching emojis:', err);
                    } else {
                        console.log('\n📦 All custom emojis in database:');
                        rows.forEach(emoji => {
                            console.log(`  :${emoji.code}: - ${emoji.name} (${emoji.category})`);
                        });
                        console.log(`\n✨ Total: ${rows.length} emojis`);
                    }
                    
                    db.close((err) => {
                        if (err) {
                            console.error('Error closing database:', err);
                        } else {
                            console.log('\n✨ Done! Sample emojis have been added.');
                            console.log('Note: You\'ll need to upload actual image files through the admin panel for these to display properly.');
                        }
                    });
                });
            }
        });
    });
}