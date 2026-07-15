/**
 * server/database/schema.js — the production schema bootstrap
 * (ADR-0030: this is the SOLE boot DDL source).
 *
 * `initializeSchema(db, log)` queues every CREATE TABLE / CREATE INDEX /
 * seed statement plus the numbered migrations (ADR-0022) onto `db` inside
 * one serialize scope, and resolves once the queue has flushed (a trailing
 * no-op SELECT).
 *
 * It lives in its own module — NOT in database.js — so that tests and
 * fixtures can require it WITHOUT triggering database.js's module self-boot
 * against the real data file (requiring database.js opens the production DB
 * and kicks off an async bootstrap; from a test that races jest's
 * environment teardown). database.js requires this module and re-exports
 * `initializeSchema`, so both import paths work.
 *
 * Rules (ADR-0030):
 *   - New tables/columns go HERE (+ a numbered migration for stale DBs).
 *   - *-schema.sql files may only hold seeds or service-owned isolated
 *     schemas (url-stream, ai-moderation, url-relay-whitelist).
 *   - Test schemas must come from initializeSchema, never hand-copied DDL.
 */

'use strict';

const migrationRunner = require('../migrations/_runner');
const { DEFAULT_GLOBAL_PROMPT } = require('../services/llm/modelCatalog');

const logger = require('../bootstrap/logger').child({ svc: 'database' });

/**
 * Boot the full production schema on `db`.
 *
 * Exported so tests and fixtures can boot the REAL schema against a
 * `:memory:` handle instead of maintaining hand-copied DDL — the drift trap
 * behind audit findings DB1/DB3. `db` only needs the callback-style
 * `serialize(fn)` + `run(sql[, params][, cb])` surface (sqlite3 natively;
 * better-sqlite3 via the shim in server/tests/integration/_helpers/db-fixture.js).
 *
 * @param {sqlite3.Database|{serialize:Function, run:Function}} db
 * @param {{ error: Function, debug?: Function }} [log]
 * @returns {Promise<void>} resolves when every queued statement has run
 */
function initializeSchema(db, log = logger) {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
        // users: the profile columns (bio/website/location/display_name/
        // avatar_url/description), username_changed, and the account-deletion
        // lifecycle columns (deletion_* + account_status) were promoted from
        // live-DB drift in the DB1 fresh-boot fix — UserRepository's
        // login-path SELECT and AccountProfileManager read them, so a fresh
        // clone couldn't even log a user in without them. The
        // idx_users_account_status / idx_users_deletion_scheduled indexes
        // live in migration 202607140011 (they must run AFTER the addColumn
        // backfill on stale DBs).
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
                is_banned BOOLEAN DEFAULT 0,
                username_changed BOOLEAN DEFAULT 0,
                deletion_requested_at DATETIME DEFAULT NULL,
                deletion_confirmed_at DATETIME DEFAULT NULL,
                deletion_scheduled_for DATETIME DEFAULT NULL,
                deletion_token TEXT DEFAULT NULL,
                deletion_token_expires DATETIME DEFAULT NULL,
                account_status TEXT DEFAULT 'active' CHECK(account_status IN ('active', 'pending_deletion', 'deleted')),
                bio TEXT DEFAULT NULL,
                website TEXT DEFAULT NULL,
                location TEXT DEFAULT NULL,
                display_name TEXT DEFAULT NULL,
                avatar_url TEXT,
                description TEXT
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

        // user_stats.points_balance is the economy's atomic counter
        // (AccountStatsRepository.atomicAdd/SubtractPoints, the 1 Hz earning
        // timer in TimeTrackingService). It was historically created only by
        // the legacy one-shot migrate-points-system.js, which is NOT in the
        // boot path — so a fresh clone booted with no working economy (audit
        // finding DB1). Inline here + backfilled by migration 202607140010.
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
                points_balance INTEGER DEFAULT 0,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )
        `);

        // points_transactions: 1:N audit log of every points credit/debit
        // (AccountStatsRepository.insertTransaction). Shape matches the live
        // DB byte-for-byte (verified read-only against prod during the DB1
        // fix) — including VARCHAR(50) on `type`. CREATE IF NOT EXISTS runs
        // every boot, so this also converges stale DBs missing the table.
        db.run(`
            CREATE TABLE IF NOT EXISTS points_transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                amount INTEGER NOT NULL,
                balance_after INTEGER NOT NULL,
                type VARCHAR(50) NOT NULL,
                description TEXT,
                metadata TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )
        `);
        db.run(`CREATE INDEX IF NOT EXISTS idx_points_transactions_user_id ON points_transactions(user_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_points_transactions_created_at ON points_transactions(created_at)`);

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

        // Item System Tables
        // items.category matches the live DB (TEXT DEFAULT 'general' — live
        // drift promoted for parity). items.is_tradeable is NEW schema:
        // InventoryService.giftItem gates gifting on it, but no DDL anywhere
        // (live included) ever created it, so gifting was dead against the
        // real schema. DEFAULT 0 preserves that all-gifts-blocked behavior;
        // flipping any item to 1 is a product decision, deliberately not
        // seeded here. Backfilled for stale DBs by migration 202607140012.
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
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                category TEXT DEFAULT 'general',
                is_tradeable BOOLEAN DEFAULT 0
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

        // Global ChatBot Configuration. The global_prompt default is the
        // single-source-of-truth DEFAULT_GLOBAL_PROMPT shared with
        // ChatBotLLMService (escaped for the DDL DEFAULT clause, which can't be
        // parameterized).
        db.run(`
            CREATE TABLE IF NOT EXISTS chatbot_config (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                global_prompt TEXT DEFAULT '${DEFAULT_GLOBAL_PROMPT.replace(/'/g, "''")}',
                llm_model TEXT DEFAULT 'mistral',
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Insert default config if it doesn't exist
        db.run(
            'INSERT OR IGNORE INTO chatbot_config (id, global_prompt) VALUES (1, ?)',
            [DEFAULT_GLOBAL_PROMPT]
        );

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

        // recording_events: THE single boot definition (audit finding DB3).
        // The old server/database/recording-schema.sql carried a second,
        // conflicting CREATE (user_id TEXT + FK to recordings) that was a
        // permanent silent no-op because this one runs first; that file and
        // its loader (setup-recording-tables.js) were deleted. Its three
        // indexes moved here. idx_recording_events_recording_id duplicates
        // idx_recording_events_recording (below, after the migrations) —
        // both exist on the live DB, so both are kept for parity.
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
        db.run(`CREATE INDEX IF NOT EXISTS idx_recording_events_recording_id ON recording_events(recording_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_recording_events_timestamp ON recording_events(timestamp)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_recording_events_event_type ON recording_events(event_type)`);

        db.run(`
            CREATE TABLE IF NOT EXISTS recording_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                description TEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Default recording settings (seed moved from recording-schema.sql).
        // NOTE: recording_settings.retention_days ('30') is a SEPARATE key
        // from admin_review_settings.retention_days ('7' below); they
        // configure different subsystems (legacy recording auto-cleanup vs
        // admin B2 review), so there is nothing to reconcile.
        db.run(`
            INSERT OR IGNORE INTO recording_settings (key, value, description) VALUES
            ('max_concurrent_recordings', '3', 'Maximum number of concurrent recordings allowed'),
            ('max_recording_duration', '3600000', 'Maximum recording duration in milliseconds (1 hour)'),
            ('disk_space_threshold', '0.85', 'Disk space usage threshold (85%)'),
            ('compression_queue_limit', '10', 'Maximum number of recordings in compression queue'),
            ('default_quality', '720p', 'Default recording quality profile'),
            ('auto_cleanup_enabled', 'true', 'Enable automatic cleanup of old recordings'),
            ('retention_days', '30', 'Number of days to keep recordings before auto-cleanup'),
            ('compression_enabled', 'true', 'Enable post-recording compression'),
            ('thumbnail_generation', 'true', 'Enable thumbnail generation for recordings')
        `);

        // ============================================
        // Transcription persistence (promoted from live-DB drift — the
        // legacy setup-transcription-tables.js script was never in the boot
        // path AND declared shapes that contradict what the live DB actually
        // carries, so it was deleted. These shapes are the live ones,
        // verified read-only against prod: TEXT ids, INTEGER epoch times,
        // strftime('%s','now') defaults. TranscriptionRepository
        // INSERT/SELECTs both tables and swallows errors into logger.error,
        // so on a fresh clone transcription persistence silently failed
        // forever until these were promoted here.
        // ============================================
        db.run(`
            CREATE TABLE IF NOT EXISTS transcriptions (
                id TEXT PRIMARY KEY,
                streamer_id TEXT,
                start_time INTEGER,
                end_time INTEGER,
                duration INTEGER,
                word_count INTEGER DEFAULT 0,
                model TEXT,
                language TEXT,
                status TEXT DEFAULT 'active',
                created_at INTEGER DEFAULT (strftime('%s', 'now')),
                stream_id TEXT
            )
        `);
        db.run(`
            CREATE TABLE IF NOT EXISTS transcription_chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                transcription_id TEXT,
                chunk_number INTEGER,
                text TEXT,
                timestamp INTEGER,
                confidence REAL,
                created_at INTEGER DEFAULT (strftime('%s', 'now')),
                word_count INTEGER DEFAULT 0,
                FOREIGN KEY (transcription_id) REFERENCES transcriptions(id)
            )
        `);
        db.run(`CREATE INDEX IF NOT EXISTS idx_transcriptions_streamer ON transcriptions(streamer_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_transcriptions_created ON transcriptions(created_at)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_chunks_transcription ON transcription_chunks(transcription_id)`);

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

        // ============================================
        // Streamer Connection / Streaming Log Tracking
        // (promoted from server/migrations/add_streamer_connections.js
        // and add_streaming_logs.js — those legacy ad-hoc scripts were
        // never auto-run by the numbered migration runner, so a fresh
        // clone was missing these LIVE tables. Readers: streamHandler
        // takeover/lifecycle, admin-moderation, StreamingLogsService,
        // ContinuousRecording*, admin-recordings, AccountLifecycleManager.)
        // ============================================
        db.run(`
            CREATE TABLE IF NOT EXISTS streamer_connections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                streamer_id TEXT NOT NULL,
                streamer_name TEXT,
                ip_address TEXT NOT NULL,
                connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                disconnected_at DATETIME,
                stream_duration INTEGER,
                connection_type TEXT,
                user_agent TEXT,
                was_banned BOOLEAN DEFAULT 0,
                disconnect_reason TEXT
            )
        `);
        db.run(`CREATE INDEX IF NOT EXISTS idx_streamer_connections_ip ON streamer_connections(ip_address)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_streamer_connections_streamer ON streamer_connections(streamer_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_streamer_connections_connected ON streamer_connections(connected_at DESC)`);

        db.run(`
            CREATE TABLE IF NOT EXISTS streaming_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT UNIQUE NOT NULL,
                streamer_id TEXT NOT NULL,
                streamer_name TEXT,
                user_id INTEGER,
                ip_address TEXT NOT NULL,
                user_agent TEXT,
                stream_type TEXT,
                started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                ended_at DATETIME,
                duration INTEGER,
                viewer_peak INTEGER DEFAULT 0,
                is_viewbot BOOLEAN DEFAULT 0,
                is_banned BOOLEAN DEFAULT 0,
                disconnect_reason TEXT,
                country TEXT,
                city TEXT,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        `);
        db.run(`CREATE INDEX IF NOT EXISTS idx_streaming_logs_ip ON streaming_logs(ip_address)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_streaming_logs_started ON streaming_logs(started_at DESC)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_streaming_logs_user ON streaming_logs(user_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_streaming_logs_session ON streaming_logs(session_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_streaming_logs_viewbot ON streaming_logs(is_viewbot)`);

        // ============================================
        // Bug Reports (promoted from server/migrations/add_bug_reports.js —
        // routes/bug-reports.js has no CREATE TABLE of its own, so a fresh
        // clone was missing this LIVE table.)
        // ============================================
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
        `);
        db.run(`CREATE INDEX IF NOT EXISTS idx_bug_reports_user_id ON bug_reports(user_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_bug_reports_status ON bug_reports(status)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_bug_reports_created_at ON bug_reports(created_at)`);

        // ============================================
        // StreamBot periodic messages + settings (promoted from
        // server/migrations/create_streambot_messages.sql — readers:
        // services/streambot/MessageStore.js reads BOTH tables, and
        // getSettings() expects a default row, so seed it here too. The
        // SQL file was never run at boot, so a fresh clone was missing
        // these LIVE tables.)
        // ============================================
        db.run(`
            CREATE TABLE IF NOT EXISTS streambot_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message TEXT NOT NULL,
                enabled BOOLEAN DEFAULT 1,
                order_index INTEGER NOT NULL DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        db.run(`
            CREATE TABLE IF NOT EXISTS streambot_settings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                interval_minutes INTEGER DEFAULT 15,
                enabled BOOLEAN DEFAULT 1,
                current_message_index INTEGER DEFAULT 0,
                last_sent_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        // Seed the singleton settings row + default Discord message (only
        // when empty — mirrors the WHERE NOT EXISTS guards in the old SQL).
        db.run(`
            INSERT INTO streambot_settings (interval_minutes, enabled, current_message_index)
            SELECT 15, 1, 0
            WHERE NOT EXISTS (SELECT 1 FROM streambot_settings)
        `);
        db.run(`
            INSERT INTO streambot_messages (message, enabled, order_index)
            SELECT '📢 Join the OneStreamer Discord community! Connect with other streamers, get support, and stay updated: https://discord.gg/As5CA3ekYA', 1, 0
            WHERE NOT EXISTS (SELECT 1 FROM streambot_messages)
        `);

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

        if (typeof log.debug === 'function') {
            log.debug('Admin Recording Review tables initialized');
        }

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

        // Run numbered schema migrations (ADR-0022). Each migration is
        // idempotent and queues callback-style ALTER statements onto the
        // same handle, so they execute in order after all CREATE TABLE
        // statements above. Filename-order is the contract — see
        // server/migrations/_runner.js.
        migrationRunner.runAll(db, log);

        // One user_stats row per user (audit DB5 / ADR-0035). This is the
        // constraint the AccountStatsRepository ON CONFLICT(user_id) upsert
        // targets. It queues AFTER migrationRunner.runAll deliberately: on a
        // stale DB that accumulated duplicate rows, migration 202607150900
        // must dedup first or this CREATE UNIQUE INDEX would fail. (That
        // migration creates the same index; IF NOT EXISTS makes whichever
        // runs second a no-op. Fresh DBs simply get it here.)
        db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_stats_user_id_unique ON user_stats(user_id)`);

        // Recording-table indexes over migration-added columns. These used
        // to hide in a setTimeout(…, 1000) "to ensure columns exist";
        // recordings.session_id / recordings.user_id are added by migration
        // 202605270009, whose ALTERs queue synchronously on this same handle
        // above — so ordering is guaranteed by the serialize queue and the
        // sleep (plus its test-side 2500 ms mirror) is gone. Error-swallowing
        // callbacks preserved.
        db.run(`CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings(status)`, (err) => {
            if (err && !err.message.includes('already exists')) {
                log.error('Index creation note:', err.message);
            }
        });
        db.run(`CREATE INDEX IF NOT EXISTS idx_recordings_session ON recordings(session_id)`, (err) => {
            if (err && !err.message.includes('already exists')) {
                log.error('Index creation note:', err.message);
            }
        });
        db.run(`CREATE INDEX IF NOT EXISTS idx_recordings_user ON recordings(user_id)`, (err) => {
            if (err && !err.message.includes('already exists')) {
                log.error('Index creation note:', err.message);
            }
        });
        db.run(`CREATE INDEX IF NOT EXISTS idx_recording_events_recording ON recording_events(recording_id)`, (err) => {
            if (err && !err.message.includes('already exists')) {
                log.error('Index creation note:', err.message);
            }
        });

        if (typeof log.debug === 'function') {
            log.debug('Database tables initialized (including game system)');
        }

        // Flush marker: this no-op queues LAST, so its callback firing means
        // every statement above (tables, seeds, migrations, indexes) has run.
        // Fail-loud (audit DB6 / ADR-0035): by this point every migration
        // statement's callback has fired, so drain the runner's async-failure
        // sink — a non-benign migration error must reject the bootstrap (and
        // abort boot at the database.js call site), not scroll past in a log.
        db.run('SELECT 1', (err) => {
            if (err) return reject(err);
            const failures = migrationRunner.drainAsyncFailures();
            if (failures.length > 0) {
                const summary = failures
                    .map((f) => `${f.op || 'statement'}(${f.table || '?'}${f.column ? '.' + f.column : ''}): ${f.err ? f.err.message : 'unknown error'}`)
                    .join('; ');
                return reject(new Error(`${failures.length} migration statement(s) failed — ${summary}`));
            }
            resolve();
        });
        });
    });
}

module.exports = { initializeSchema };
