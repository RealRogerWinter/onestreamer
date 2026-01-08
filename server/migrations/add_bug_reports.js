const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'onestreamer.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    } else {
        console.log('Connected to SQLite database for bug reports migration');
        createBugReportsTable();
    }
});

function createBugReportsTable() {
    db.serialize(() => {
        // Create bug_reports table
        db.run(`
            CREATE TABLE IF NOT EXISTS bug_reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                username TEXT,
                ip_address TEXT,
                description TEXT NOT NULL,
                session_data TEXT,
                user_agent TEXT,
                url TEXT,
                status TEXT DEFAULT 'new',
                priority TEXT DEFAULT 'medium',
                admin_notes TEXT,
                resolved_at DATETIME,
                resolved_by INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id),
                FOREIGN KEY (resolved_by) REFERENCES users (id)
            )
        `, (err) => {
            if (err) {
                console.error('Error creating bug_reports table:', err);
                process.exit(1);
            } else {
                console.log('✅ Bug reports table created successfully');
            }
        });

        // Create indexes for performance
        db.run(`
            CREATE INDEX IF NOT EXISTS idx_bug_reports_user_id ON bug_reports(user_id)
        `);

        db.run(`
            CREATE INDEX IF NOT EXISTS idx_bug_reports_status ON bug_reports(status)
        `);

        db.run(`
            CREATE INDEX IF NOT EXISTS idx_bug_reports_created_at ON bug_reports(created_at)
        `, (err) => {
            if (err) {
                console.error('Error creating indexes:', err);
            } else {
                console.log('✅ Bug reports indexes created successfully');
                db.close((err) => {
                    if (err) {
                        console.error('Error closing database:', err);
                    } else {
                        console.log('✅ Migration complete - database connection closed');
                    }
                });
            }
        });
    });
}