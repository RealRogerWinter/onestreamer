const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'onestreamer.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    } else {
        console.log('Connected to SQLite database for avatar/description migration');
        runMigration();
    }
});

async function runMigration() {
    try {
        console.log('Starting avatar and description migration...');
        
        // Add avatar_url and description columns to users table
        await new Promise((resolve, reject) => {
            db.run(`
                ALTER TABLE users 
                ADD COLUMN avatar_url TEXT
            `, (err) => {
                if (err && !err.message.includes('duplicate column')) {
                    reject(err);
                } else {
                    console.log('✅ Added avatar_url column to users table');
                    resolve();
                }
            });
        });

        await new Promise((resolve, reject) => {
            db.run(`
                ALTER TABLE users 
                ADD COLUMN description TEXT
            `, (err) => {
                if (err && !err.message.includes('duplicate column')) {
                    reject(err);
                } else {
                    console.log('✅ Added description column to users table');
                    resolve();
                }
            });
        });

        // Create uploads directory for avatars if it doesn't exist
        const fs = require('fs');
        const uploadsDir = path.join(__dirname, '..', 'uploads', 'avatars');
        if (!fs.existsSync(uploadsDir)) {
            fs.mkdirSync(uploadsDir, { recursive: true });
            console.log('✅ Created avatars upload directory');
        }

        console.log('🎉 Avatar and description migration completed successfully!');
        process.exit(0);
    } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    }
}