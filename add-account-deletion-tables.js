const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Update this path to match your database location
const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    } else {
        console.log('Connected to SQLite database');
        addAccountDeletionTables();
    }
});

function addAccountDeletionTables() {
    console.log('Adding account deletion tables and columns...');
    
    db.serialize(() => {
        // Add deletion-related columns to users table
        db.run(`ALTER TABLE users ADD COLUMN deletion_requested_at DATETIME DEFAULT NULL`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.error('Error adding deletion_requested_at column:', err);
            } else if (!err) {
                console.log('✓ Added deletion_requested_at column to users table');
            }
        });

        db.run(`ALTER TABLE users ADD COLUMN deletion_confirmed_at DATETIME DEFAULT NULL`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.error('Error adding deletion_confirmed_at column:', err);
            } else if (!err) {
                console.log('✓ Added deletion_confirmed_at column to users table');
            }
        });

        db.run(`ALTER TABLE users ADD COLUMN deletion_scheduled_for DATETIME DEFAULT NULL`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.error('Error adding deletion_scheduled_for column:', err);
            } else if (!err) {
                console.log('✓ Added deletion_scheduled_for column to users table');
            }
        });

        db.run(`ALTER TABLE users ADD COLUMN deletion_token TEXT DEFAULT NULL`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.error('Error adding deletion_token column:', err);
            } else if (!err) {
                console.log('✓ Added deletion_token column to users table');
            }
        });

        db.run(`ALTER TABLE users ADD COLUMN deletion_token_expires DATETIME DEFAULT NULL`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.error('Error adding deletion_token_expires column:', err);
            } else if (!err) {
                console.log('✓ Added deletion_token_expires column to users table');
            }
        });

        db.run(`ALTER TABLE users ADD COLUMN account_status TEXT DEFAULT 'active' CHECK(account_status IN ('active', 'pending_deletion', 'deleted'))`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.error('Error adding account_status column:', err);
            } else if (!err) {
                console.log('✓ Added account_status column to users table');
            }
        });

        // Create account deletion audit log table
        db.run(`
            CREATE TABLE IF NOT EXISTS account_deletion_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                username TEXT NOT NULL,
                email TEXT NOT NULL,
                action TEXT NOT NULL CHECK(action IN ('deletion_requested', 'deletion_confirmed', 'deletion_cancelled', 'account_restored', 'data_purged')),
                ip_address TEXT,
                user_agent TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )
        `, (err) => {
            if (err) {
                console.error('Error creating account_deletion_logs table:', err);
            } else {
                console.log('✓ Created account_deletion_logs table');
            }
        });

        // Create indexes for better performance
        db.run(`CREATE INDEX IF NOT EXISTS idx_users_account_status ON users(account_status)`, (err) => {
            if (!err) console.log('✓ Created index on account_status');
        });

        db.run(`CREATE INDEX IF NOT EXISTS idx_users_deletion_scheduled ON users(deletion_scheduled_for)`, (err) => {
            if (!err) console.log('✓ Created index on deletion_scheduled_for');
        });

        db.run(`CREATE INDEX IF NOT EXISTS idx_deletion_logs_user_id ON account_deletion_logs(user_id)`, (err) => {
            if (!err) console.log('✓ Created index on deletion logs user_id');
        });

        // Verify changes
        setTimeout(() => {
            db.all("PRAGMA table_info(users)", (err, rows) => {
                if (err) {
                    console.error('Error checking table info:', err);
                } else {
                    console.log('\nUsers table columns after migration:');
                    const deletionColumns = rows.filter(col => 
                        col.name.includes('deletion') || col.name === 'account_status'
                    );
                    deletionColumns.forEach(col => {
                        console.log(`  - ${col.name}: ${col.type}`);
                    });
                }
                
                db.close((err) => {
                    if (err) {
                        console.error('Error closing database:', err);
                    } else {
                        console.log('\n✅ Database migration completed successfully!');
                    }
                });
            });
        }, 1000);
    });
}