const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');
const applyPragmas = require('./applyPragmas');
const logger = require('../bootstrap/logger');

const dbPath = path.join(__dirname, '..', 'data', 'onestreamer.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        logger.error(err, 'Error opening database');
        return;
    }
    logger.info({ dbPath }, 'Connected to SQLite database');
    applyPragmas(db, { tuneForLargeReads: true })
        .then(({ walActive }) => {
            logger.info({ journalMode: walActive ? 'wal' : 'fallback' }, 'SQLite PRAGMAs applied');
            initializeDatabase();
        })
        .catch((e) => {
            logger.error(e, 'Failed to apply SQLite PRAGMAs');
            // Continue with schema setup; the connection is still usable,
            // it's just running with default (less optimal but correct) settings.
            initializeDatabase();
        });
});

function initializeDatabase() {
    db.serialize(() => {
        db.run(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT UNIQUE NOT NULL,
                username TEXT UNIQUE NOT NULL,
                password TEXT,
                oauth_provider TEXT,
                oauth_id TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_login DATETIME,
                is_verified BOOLEAN DEFAULT 0,
                verification_token TEXT,
                reset_token TEXT,
                reset_token_expires DATETIME,
                is_admin BOOLEAN DEFAULT 0,
                is_moderator BOOLEAN DEFAULT 0,
                is_banned BOOLEAN DEFAULT 0
            )
        `);

        db.run(`
            CREATE TABLE IF NOT EXISTS user_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                ip_address TEXT NOT NULL,
                session_data TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                expires_at DATETIME,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )
        `);

        db.run(`
            CREATE TABLE IF NOT EXISTS user_stats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                total_stream_time INTEGER DEFAULT 0,
                total_view_time INTEGER DEFAULT 0,
                stream_count INTEGER DEFAULT 0,
                last_stream_at DATETIME,
                chat_message_count INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )
        `);

        db.run(`
            CREATE TABLE IF NOT EXISTS ip_to_user_transfers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                ip_address TEXT NOT NULL,
                session_data TEXT,
                transferred_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )
        `);

        db.run(`
            CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)
        `);

        db.run(`
            CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)
        `);

        db.run(`
            CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id)
        `);

        db.run(`
            CREATE INDEX IF NOT EXISTS idx_user_sessions_ip ON user_sessions(ip_address)
        `);

        // Add new columns if they don't exist (migration)
        db.run(`ALTER TABLE users ADD COLUMN is_admin BOOLEAN DEFAULT 0`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.error('Error adding is_admin column:', err);
            }
        });

        db.run(`ALTER TABLE users ADD COLUMN is_banned BOOLEAN DEFAULT 0`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.error('Error adding is_banned column:', err);
            }
        });

        db.run(`ALTER TABLE users ADD COLUMN is_moderator BOOLEAN DEFAULT 0`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.error('Error adding is_moderator column:', err);
            }
        });

        // Drop the legacy `points` column. `user_stats.points_balance` is the
        // authoritative source per the migrate-points-system migration; the
        // `points` column was its calculated-on-read predecessor and has been
        // unread for some time. Idempotent: second run errors with "no such
        // column" which we ignore.
        db.run(`ALTER TABLE user_stats DROP COLUMN points`, (err) => {
            if (err && !err.message.includes('no such column')) {
                console.error('Error dropping legacy points column:', err);
            }
        });

        // Add chat_color column to user_stats if it doesn't exist (migration)
        db.run(`ALTER TABLE user_stats ADD COLUMN chat_color TEXT DEFAULT NULL`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.error('Error adding chat_color column:', err);
            }
        });

        // Item System Tables
        db.run(`
            CREATE TABLE IF NOT EXISTS items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                display_name TEXT NOT NULL,
                emoji TEXT NOT NULL,
                description TEXT NOT NULL,
                item_type TEXT NOT NULL CHECK(item_type IN ('buff', 'debuff', 'utility', 'guard', 'weapon', 'marker')),
                rarity TEXT NOT NULL CHECK(rarity IN ('common', 'uncommon', 'rare', 'epic', 'legendary')),
                base_price INTEGER NOT NULL DEFAULT 0,
                is_purchasable BOOLEAN DEFAULT 1,
                is_active BOOLEAN DEFAULT 1,
                cooldown_seconds INTEGER DEFAULT 0,
                max_stack INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        db.run(`
            CREATE TABLE IF NOT EXISTS user_inventory (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                item_id INTEGER NOT NULL,
                quantity INTEGER NOT NULL DEFAULT 0,
                acquired_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_used_at DATETIME,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
                FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE,
                UNIQUE(user_id, item_id)
            )
        `);

        db.run(`
            CREATE TABLE IF NOT EXISTS item_usage_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                item_id INTEGER NOT NULL,
                stream_id TEXT,
                used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                effect_duration INTEGER,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
                FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE
            )
        `);

        db.run(`
            CREATE TABLE IF NOT EXISTS shop_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                item_id INTEGER NOT NULL,
                price INTEGER NOT NULL,
                discount_percentage INTEGER DEFAULT 0,
                is_featured BOOLEAN DEFAULT 0,
                stock_limit INTEGER DEFAULT -1,
                available_from DATETIME,
                available_until DATETIME,
                FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE
            )
        `);

        db.run(`
            CREATE TABLE IF NOT EXISTS item_transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                item_id INTEGER NOT NULL,
                transaction_type TEXT NOT NULL CHECK(transaction_type IN ('purchase', 'sell', 'gift', 'admin_grant')),
                quantity INTEGER NOT NULL,
                price_per_item INTEGER,
                total_cost INTEGER,
                points_before INTEGER,
                points_after INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
                FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE
            )
        `);

        // Gift Transactions
        db.run(`
            CREATE TABLE IF NOT EXISTS gift_transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_user_id INTEGER NOT NULL,
                to_user_id INTEGER NOT NULL,
                item_id INTEGER NOT NULL,
                quantity INTEGER NOT NULL DEFAULT 1,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (from_user_id) REFERENCES users (id) ON DELETE CASCADE,
                FOREIGN KEY (to_user_id) REFERENCES users (id) ON DELETE CASCADE,
                FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE
            )
        `);

        // Active Buffs/Debuffs System
        db.run(`
            CREATE TABLE IF NOT EXISTS active_buffs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                item_id INTEGER NOT NULL,
                applied_by_user_id INTEGER NOT NULL,
                buff_type TEXT NOT NULL CHECK(buff_type IN ('buff', 'debuff')),
                duration_seconds INTEGER NOT NULL,
                remaining_seconds INTEGER NOT NULL,
                streaming_time_used INTEGER DEFAULT 0,
                applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
                is_active BOOLEAN DEFAULT 1,
                metadata TEXT,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
                FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE,
                FOREIGN KEY (applied_by_user_id) REFERENCES users (id) ON DELETE CASCADE
            )
        `);

        // Add new columns to items table for buff/debuff properties
        db.run(`ALTER TABLE items ADD COLUMN duration_seconds INTEGER DEFAULT 0`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.error('Error adding duration_seconds column:', err);
            }
        });

        db.run(`ALTER TABLE items ADD COLUMN effect_data TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.error('Error adding effect_data column:', err);
            }
        });

        db.run(`ALTER TABLE items ADD COLUMN stack_behavior TEXT DEFAULT 'replace'`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.error('Error adding stack_behavior column:', err);
            }
        });

        // Create indexes for better performance
        db.run(`CREATE INDEX IF NOT EXISTS idx_user_inventory_user_id ON user_inventory(user_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_item_usage_log_user_id ON item_usage_log(user_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_item_transactions_user_id ON item_transactions(user_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_shop_items_item_id ON shop_items(item_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_active_buffs_user_id ON active_buffs(user_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_active_buffs_active ON active_buffs(is_active)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_active_buffs_type ON active_buffs(buff_type)`);

        // ChatBot System Tables
        db.run(`
            CREATE TABLE IF NOT EXISTS chatbots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                prompt TEXT NOT NULL,
                is_enabled BOOLEAN DEFAULT 1,
                response_interval_min INTEGER DEFAULT 60,
                response_interval_max INTEGER DEFAULT 180,
                show_robot_emoji BOOLEAN DEFAULT 1,
                personality_traits TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        db.run(`
            CREATE TABLE IF NOT EXISTS chatbot_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chatbot_id INTEGER NOT NULL,
                socket_id TEXT,
                username TEXT NOT NULL,
                color TEXT NOT NULL,
                connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_message_at DATETIME,
                FOREIGN KEY (chatbot_id) REFERENCES chatbots (id) ON DELETE CASCADE
            )
        `);

        db.run(`
            CREATE TABLE IF NOT EXISTS chatbot_message_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chatbot_id INTEGER NOT NULL,
                message TEXT NOT NULL,
                context TEXT,
                exact_prompt TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (chatbot_id) REFERENCES chatbots (id) ON DELETE CASCADE
            )
        `);

        // Add new columns to existing table if they don't exist
        db.all("PRAGMA table_info(chatbot_message_history)", (err, columns) => {
            if (err) {
                console.error('Error checking table structure:', err);
                return;
            }
            
            const columnNames = columns.map(col => col.name);
            
            if (!columnNames.includes('exact_prompt')) {
                db.run(`ALTER TABLE chatbot_message_history ADD COLUMN exact_prompt TEXT`, (err) => {
                    if (err) console.error('Error adding exact_prompt column:', err);
                    else console.log('Added exact_prompt column to chatbot_message_history');
                });
            }
            
            // Add message_type column for MovieBot logging
            if (!columnNames.includes('message_type')) {
                db.run(`ALTER TABLE chatbot_message_history ADD COLUMN message_type TEXT DEFAULT 'chat'`, (err) => {
                    if (err) console.error('Error adding message_type column:', err);
                    else console.log('Added message_type column to chatbot_message_history');
                });
            }
            
            // Add content column for MovieBot logging (alias for message)
            if (!columnNames.includes('content')) {
                db.run(`ALTER TABLE chatbot_message_history ADD COLUMN content TEXT`, (err) => {
                    if (err) console.error('Error adding content column:', err);
                    else console.log('Added content column to chatbot_message_history');
                });
            }
            
            // Add metadata column for MovieBot logging
            if (!columnNames.includes('metadata')) {
                db.run(`ALTER TABLE chatbot_message_history ADD COLUMN metadata TEXT`, (err) => {
                    if (err) console.error('Error adding metadata column:', err);
                    else console.log('Added metadata column to chatbot_message_history');
                });
            }
        });

        // Add llm_model column to chatbot_config if it doesn't exist
        db.all("PRAGMA table_info(chatbot_config)", (err, columns) => {
            if (err) {
                console.error('Error checking chatbot_config structure:', err);
                return;
            }
            
            const columnNames = columns.map(col => col.name);
            
            if (!columnNames.includes('llm_model')) {
                db.run(`ALTER TABLE chatbot_config ADD COLUMN llm_model TEXT DEFAULT 'mistral'`, (err) => {
                    if (err) console.error('Error adding llm_model column:', err);
                    else console.log('Added llm_model column to chatbot_config');
                });
            }
        });

        // Add missing columns to chatbots table
        db.all("PRAGMA table_info(chatbots)", (err, columns) => {
            if (err) {
                console.error('Error checking chatbots structure:', err);
                return;
            }
            
            const columnNames = columns.map(col => col.name);
            
            // Add use_assigned_name column if it doesn't exist
            if (!columnNames.includes('use_assigned_name')) {
                db.run(`ALTER TABLE chatbots ADD COLUMN use_assigned_name BOOLEAN DEFAULT 1`, (err) => {
                    if (err && !err.message.includes('duplicate column')) {
                        console.error('Error adding use_assigned_name column:', err);
                    } else if (!err) {
                        console.log('Added use_assigned_name column to chatbots');
                    }
                });
            }
            
            // Add llm_model column if it doesn't exist
            if (!columnNames.includes('llm_model')) {
                db.run(`ALTER TABLE chatbots ADD COLUMN llm_model TEXT`, (err) => {
                    if (err && !err.message.includes('duplicate column')) {
                        console.error('Error adding llm_model column to chatbots:', err);
                    } else if (!err) {
                        console.log('Added llm_model column to chatbots');
                    }
                });
            }
            
            // Add moviebot_enabled column if it doesn't exist
            if (!columnNames.includes('moviebot_enabled')) {
                db.run(`ALTER TABLE chatbots ADD COLUMN moviebot_enabled BOOLEAN DEFAULT 0`, (err) => {
                    if (err && !err.message.includes('duplicate column')) {
                        console.error('Error adding moviebot_enabled column to chatbots:', err);
                    } else if (!err) {
                        console.log('Added moviebot_enabled column to chatbots');
                    }
                });
            }

            // VisionBot per-bot opt-in flag.
            if (!columnNames.includes('vision_bot_enabled')) {
                db.run(`ALTER TABLE chatbots ADD COLUMN vision_bot_enabled BOOLEAN DEFAULT 0`, (err) => {
                    if (err && !err.message.includes('duplicate column')) {
                        console.error('Error adding vision_bot_enabled column to chatbots:', err);
                    } else if (!err) {
                        console.log('Added vision_bot_enabled column to chatbots');
                    }
                });
            }
        });

        // Chat Messages Table for MovieBot history
        db.run(`
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                message TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        db.run(`CREATE INDEX IF NOT EXISTS idx_chatbots_enabled ON chatbots(is_enabled)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_chatbot_sessions_bot_id ON chatbot_sessions(chatbot_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_chatbot_message_history_bot_id ON chatbot_message_history(chatbot_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)`);

        // VisionBot singleton config. Mirrors moviebot_config but with the
        // vision-specific knobs (model, frame resolution/quality, retention,
        // url-relay gate, backoff state, status counters).
        db.run(`
            CREATE TABLE IF NOT EXISTS visionbot_config (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                enabled BOOLEAN DEFAULT 0,
                streamer_id TEXT DEFAULT NULL,
                vision_prompt_template TEXT,
                transcription_frequency_s INTEGER DEFAULT 120,
                transcription_duration_s INTEGER DEFAULT 45,
                image_resolution_px INTEGER DEFAULT 384,
                image_quality INTEGER DEFAULT 70,
                vision_model TEXT DEFAULT 'meta-llama/llama-4-scout-17b-16e-instruct',
                max_response_tokens INTEGER DEFAULT 150,
                temperature REAL DEFAULT 0.7,
                max_bots_per_cycle INTEGER DEFAULT 3,
                frame_retention_hours INTEGER DEFAULT 1,
                allow_url_relay BOOLEAN DEFAULT 0,
                last_groq_429_at DATETIME,
                consecutive_failures INTEGER DEFAULT 0,
                last_success_at DATETIME,
                last_error_reason TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Per-user opt-out for vision frame capture (privacy).
        db.all(`PRAGMA table_info(users)`, (err, columns) => {
            if (err) return;
            const colNames = (columns || []).map(c => c.name);
            if (!colNames.includes('vision_audit_optout')) {
                db.run(`ALTER TABLE users ADD COLUMN vision_audit_optout BOOLEAN DEFAULT 0`, (e) => {
                    if (e && !e.message.includes('duplicate column')) {
                        console.error('Error adding vision_audit_optout to users:', e);
                    } else if (!e) {
                        console.log('Added vision_audit_optout column to users');
                    }
                });
            }
        });

        // Global ChatBot Configuration
        db.run(`
            CREATE TABLE IF NOT EXISTS chatbot_config (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                global_prompt TEXT DEFAULT 'You are participating in a live stream chat. Be friendly, engaging, and keep responses concise (under 100 characters). Avoid repeating what others have said. Do not use quotes, asterisks for actions, or roleplay formatting.',
                llm_model TEXT DEFAULT 'mistral',
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Insert default config if it doesn't exist
        db.run(`
            INSERT OR IGNORE INTO chatbot_config (id, global_prompt) 
            VALUES (1, 'You are participating in a live stream chat. Be friendly, engaging, and keep responses concise (under 100 characters). Avoid repeating what others have said. Do not use quotes, asterisks for actions, or roleplay formatting.')
        `);

        // Recording System Tables
        db.run(`
            CREATE TABLE IF NOT EXISTS recordings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                recording_id TEXT UNIQUE NOT NULL,
                stream_id TEXT,
                user_id INTEGER,
                session_id TEXT,
                file_path TEXT,
                file_size INTEGER,
                duration INTEGER,
                quality TEXT,
                status TEXT DEFAULT 'active',
                is_continuous BOOLEAN DEFAULT 0,
                segment_number INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                completed_at DATETIME,
                metadata TEXT,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )
        `);

        db.run(`
            CREATE TABLE IF NOT EXISTS recording_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                recording_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                event_data TEXT,
                user_id INTEGER,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )
        `);

        db.run(`
            CREATE TABLE IF NOT EXISTS recording_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                description TEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Custom Emojis Table
        db.run(`
            CREATE TABLE IF NOT EXISTS custom_emojis (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                code TEXT UNIQUE NOT NULL,
                file_path TEXT NOT NULL,
                url TEXT NOT NULL,
                category TEXT DEFAULT 'general',
                is_active BOOLEAN DEFAULT 1,
                usage_count INTEGER DEFAULT 0,
                created_by INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (created_by) REFERENCES users (id)
            )
        `);

        db.run(`CREATE INDEX IF NOT EXISTS idx_custom_emojis_code ON custom_emojis(code)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_custom_emojis_active ON custom_emojis(is_active)`);

        // Clips System Tables
        // Note: Foreign keys removed to allow clips from continuous recording sessions
        // which don't have entries in the recordings table
        db.run(`
            CREATE TABLE IF NOT EXISTS clips (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                clip_id TEXT UNIQUE NOT NULL,
                recording_id TEXT,
                user_id INTEGER,
                streamer_user_id INTEGER,
                title TEXT NOT NULL,
                description TEXT,
                start_time_ms INTEGER NOT NULL,
                end_time_ms INTEGER NOT NULL,
                duration_ms INTEGER NOT NULL,
                file_path TEXT,
                file_size INTEGER,
                thumbnail_path TEXT,
                status TEXT DEFAULT 'processing',
                view_count INTEGER DEFAULT 0,
                is_public BOOLEAN DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        db.run(`
            CREATE TABLE IF NOT EXISTS clip_views (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                clip_id TEXT NOT NULL,
                user_id INTEGER,
                ip_address TEXT,
                viewed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (clip_id) REFERENCES clips (clip_id),
                FOREIGN KEY (user_id) REFERENCES users (id)
            )
        `);

        db.run(`CREATE INDEX IF NOT EXISTS idx_clips_clip_id ON clips(clip_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_clips_user ON clips(user_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_clips_status ON clips(status)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_clips_public ON clips(is_public)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_clips_created ON clips(created_at)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_clip_views_clip ON clip_views(clip_id)`);

        // Clip Chat Messages - stores chat snapshot for playback with clips
        db.run(`
            CREATE TABLE IF NOT EXISTS clip_chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                clip_id TEXT NOT NULL,
                username TEXT NOT NULL,
                message TEXT NOT NULL,
                relative_time_ms INTEGER NOT NULL,
                original_timestamp DATETIME,
                FOREIGN KEY (clip_id) REFERENCES clips (clip_id) ON DELETE CASCADE
            )
        `);
        db.run(`CREATE INDEX IF NOT EXISTS idx_clip_chat_clip_id ON clip_chat_messages(clip_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_clip_chat_relative_time ON clip_chat_messages(clip_id, relative_time_ms)`);

        // Add missing columns if they don't exist (migration)
        db.run(`ALTER TABLE recordings ADD COLUMN session_id TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                if (!err.message.includes('no such table')) {
                    console.error('Note: session_id column migration:', err.message);
                }
            }
        });
        
        db.run(`ALTER TABLE recordings ADD COLUMN user_id INTEGER`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                if (!err.message.includes('no such table')) {
                    console.error('Note: user_id column migration:', err.message);
                }
            }
        });
        
        db.run(`ALTER TABLE recording_events ADD COLUMN user_id INTEGER`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                if (!err.message.includes('no such table')) {
                    console.error('Note: recording_events user_id column migration:', err.message);
                }
            }
        });

        // IP Ban Management Table
        db.run(`
            CREATE TABLE IF NOT EXISTS ip_bans (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ip_address TEXT UNIQUE NOT NULL,
                reason TEXT,
                banned_by TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        db.run(`CREATE INDEX IF NOT EXISTS idx_ip_bans_ip ON ip_bans(ip_address)`);

        // Create indexes for recording tables after a delay to ensure columns exist
        setTimeout(() => {
            db.run(`CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings(status)`, (err) => {
                if (err && !err.message.includes('already exists')) {
                    console.error('Index creation note:', err.message);
                }
            });
            db.run(`CREATE INDEX IF NOT EXISTS idx_recordings_session ON recordings(session_id)`, (err) => {
                if (err && !err.message.includes('already exists')) {
                    console.error('Index creation note:', err.message);
                }
            });
            db.run(`CREATE INDEX IF NOT EXISTS idx_recordings_user ON recordings(user_id)`, (err) => {
                if (err && !err.message.includes('already exists')) {
                    console.error('Index creation note:', err.message);
                }
            });
            db.run(`CREATE INDEX IF NOT EXISTS idx_recording_events_recording ON recording_events(recording_id)`, (err) => {
                if (err && !err.message.includes('already exists')) {
                    console.error('Index creation note:', err.message);
                }
            });
        }, 1000);

        // Initialize ViewBot tables
        setTimeout(() => {
            try {
                const viewbotMigration = require('../migrations/setup-viewbot-tables');
                viewbotMigration.setupViewBotTables().then(() => {
                    console.log('✅ ViewBot tables initialized');
                }).catch((err) => {
                    console.error('❌ ViewBot tables initialization failed:', err.message);
                });
            } catch (err) {
                console.error('❌ ViewBot migration module not found:', err.message);
            }
        }, 1500);

        // ============================================
        // Admin Recording Review System Tables
        // ============================================

        // Recording Sessions - tracks continuous recording sessions for admin review
        db.run(`
            CREATE TABLE IF NOT EXISTS recording_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT UNIQUE NOT NULL,
                streamer_identity TEXT,
                streamer_user_id INTEGER,
                streamer_username TEXT,
                start_time INTEGER NOT NULL,
                end_time INTEGER,
                duration_ms INTEGER,
                status TEXT DEFAULT 'recording',
                local_path TEXT,
                b2_file_id TEXT,
                b2_file_name TEXT,
                file_size_bytes INTEGER,
                segment_count INTEGER DEFAULT 0,
                chat_message_count INTEGER DEFAULT 0,
                metadata_json TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (streamer_user_id) REFERENCES users (id)
            )
        `);

        // Session Chat Messages - persistent chat storage for session playback
        db.run(`
            CREATE TABLE IF NOT EXISTS session_chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                username TEXT NOT NULL,
                message TEXT NOT NULL,
                color TEXT,
                absolute_time_ms INTEGER NOT NULL,
                relative_time_ms INTEGER NOT NULL,
                is_system INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_id) REFERENCES recording_sessions (session_id) ON DELETE CASCADE
            )
        `);

        // Admin Review Settings - configurable settings for the review system
        db.run(`
            CREATE TABLE IF NOT EXISTS admin_review_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                description TEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Insert default admin review settings
        db.run(`
            INSERT OR IGNORE INTO admin_review_settings (key, value, description) VALUES
            ('retention_days', '7', 'Days to keep recordings on B2 (1-7)'),
            ('upload_enabled', 'true', 'Enable automatic upload to B2'),
            ('local_buffer_hours', '2', 'Hours to keep local copies before upload')
        `);

        // Indexes for admin review tables
        db.run(`CREATE INDEX IF NOT EXISTS idx_recording_sessions_start ON recording_sessions(start_time DESC)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_recording_sessions_status ON recording_sessions(status)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_recording_sessions_streamer ON recording_sessions(streamer_identity)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_session_chat_session_id ON session_chat_messages(session_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_session_chat_time ON session_chat_messages(session_id, relative_time_ms)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_session_chat_absolute ON session_chat_messages(session_id, absolute_time_ms)`);

        console.log('Admin Recording Review tables initialized');

        // ============================================
        // Game System Tables
        // ============================================

        // Game world persistence - stores tile data, buildings, spawn points
        db.run(`
            CREATE TABLE IF NOT EXISTS game_world (
                id INTEGER PRIMARY KEY DEFAULT 1,
                tiles TEXT NOT NULL,
                buildings TEXT NOT NULL,
                spawn_points TEXT NOT NULL,
                config TEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Game player state - for reconnection and persistence
        db.run(`
            CREATE TABLE IF NOT EXISTS game_player_state (
                user_id INTEGER PRIMARY KEY,
                x REAL NOT NULL DEFAULT 100,
                y REAL NOT NULL DEFAULT 100,
                sprite_id TEXT DEFAULT 'player_default',
                inventory TEXT DEFAULT '[]',
                stats TEXT DEFAULT '{}',
                last_active DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
            )
        `);

        // Game items in the world (pickups, drops)
        db.run(`
            CREATE TABLE IF NOT EXISTS game_world_items (
                id TEXT PRIMARY KEY,
                item_type TEXT NOT NULL,
                x REAL NOT NULL,
                y REAL NOT NULL,
                data TEXT,
                spawned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                picked_up_by INTEGER,
                picked_up_at DATETIME,
                FOREIGN KEY (picked_up_by) REFERENCES users (id) ON DELETE SET NULL
            )
        `);

        // Game session history
        db.run(`
            CREATE TABLE IF NOT EXISTS game_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                ended_at DATETIME,
                started_by INTEGER,
                ended_by INTEGER,
                peak_players INTEGER DEFAULT 0,
                total_players INTEGER DEFAULT 0,
                total_items_spawned INTEGER DEFAULT 0,
                total_items_picked_up INTEGER DEFAULT 0,
                FOREIGN KEY (started_by) REFERENCES users (id),
                FOREIGN KEY (ended_by) REFERENCES users (id)
            )
        `);

        // Game player session participation
        db.run(`
            CREATE TABLE IF NOT EXISTS game_player_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                left_at DATETIME,
                items_collected INTEGER DEFAULT 0,
                distance_traveled REAL DEFAULT 0,
                FOREIGN KEY (session_id) REFERENCES game_sessions (id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
            )
        `);

        // Indexes for game tables
        db.run(`CREATE INDEX IF NOT EXISTS idx_game_player_state_user ON game_player_state(user_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_game_world_items_location ON game_world_items(x, y)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_game_world_items_type ON game_world_items(item_type)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_game_sessions_active ON game_sessions(ended_at)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_game_player_sessions_session ON game_player_sessions(session_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_game_player_sessions_user ON game_player_sessions(user_id)`);

        console.log('Database tables initialized (including game system)');
    });
}

function runAsyncSqlite3(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve({ id: this.lastID, changes: this.changes });
        });
    });
}

function getAsyncSqlite3(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function allAsyncSqlite3(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

// ============================================================================
// ADR-0014: better-sqlite3 adapter behind USE_BETTER_SQLITE3 env flag.
//
// When the flag is true, runAsync/getAsync/allAsync are backed by a
// better-sqlite3 connection (with prepared-statement cache) opened against
// the same database file. The sqlite3 `db` handle stays open and exported
// for legacy consumers that call db.run/.get/.all/.serialize directly
// (routes/admin.js, routes/auth.js, several services + migrations).
//
// SQLite supports multiple connections to the same WAL'd file from the
// same process; both backends see each other's commits through WAL.
// busy_timeout=5000 on both handles bounds SQLITE_BUSY surfacing.
//
// Default is OFF — flipping it on is the operator's call, per the brief's
// "the cutover is reversible without code revert" requirement.
// ============================================================================

let runAsync = runAsyncSqlite3;
let getAsync = getAsyncSqlite3;
let allAsync = allAsyncSqlite3;
let betterAdapter = null;

if (process.env.USE_BETTER_SQLITE3 === 'true') {
    try {
        const { createBetterSqlite3Adapter } = require('./database-better');
        betterAdapter = createBetterSqlite3Adapter(dbPath, { tuneForLargeReads: true });
        runAsync = betterAdapter.runAsync;
        getAsync = betterAdapter.getAsync;
        allAsync = betterAdapter.allAsync;
        logger.info(
            { walActive: betterAdapter.walActive, dbPath },
            'better-sqlite3 adapter active (USE_BETTER_SQLITE3=true)'
        );
    } catch (e) {
        logger.error(
            { err: e },
            'better-sqlite3 adapter failed to load; falling back to sqlite3'
        );
        // Leave runAsync/getAsync/allAsync pointing at the sqlite3 impls.
    }
}

// withTransaction (ADR-0015). Closes over the *current* wrappers — captured
// AFTER the USE_BETTER_SQLITE3 swap above. Module-load order is the contract.
const { createWithTransaction } = require('./transaction');
const withTransaction = createWithTransaction({ runAsync, getAsync, allAsync });

module.exports = {
    db,
    runAsync,
    getAsync,
    allAsync,
    withTransaction,
    // Test-only handle for the adapter, when active. Gated on NODE_ENV so
    // production code physically can't reach the adapter's raw Database
    // (which exposes .exec/.transaction/.backup outside the wrappers).
    // Returns null in production OR when the env flag is off.
    _betterAdapter: () => (process.env.NODE_ENV === 'test' ? betterAdapter : null),
};