-- Live schema dump from /root/onestreamer/server/data/onestreamer.db.
-- Generated 2026-05-26 against the production single-tenant DB (~2.2 GB).
--
-- This is the **observed** schema. server/database/database.js defines the
-- shape for a fresh install (CREATE TABLE statements) plus an accreting
-- list of ad-hoc ALTER TABLE migrations that run on every boot. The two
-- are not guaranteed identical — this file is the source of truth for
-- "what does the live DB actually look like."
--
-- Refresh: sqlite3 server/data/onestreamer.db .schema > docs/architecture/schema-actual.sql
-- (and re-add this header)
--
-- Used by:
--   - The Phase 5 migration baseline (umzug / homegrown user_version runner)
--   - Schema-vs-code drift audits when ALTER TABLE migrations accrete
--   - Anyone asking "is column X actually on table Y in production?"

CREATE TABLE users (
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
                is_banned BOOLEAN DEFAULT 0
            , points_balance INTEGER DEFAULT 0, username_changed BOOLEAN DEFAULT 0, is_moderator BOOLEAN DEFAULT 0, deletion_requested_at DATETIME DEFAULT NULL, deletion_confirmed_at DATETIME DEFAULT NULL, deletion_scheduled_for DATETIME DEFAULT NULL, deletion_token TEXT DEFAULT NULL, deletion_token_expires DATETIME DEFAULT NULL, account_status TEXT DEFAULT 'active' CHECK(account_status IN ('active', 'pending_deletion', 'deleted')), bio TEXT DEFAULT NULL, website TEXT DEFAULT NULL, location TEXT DEFAULT NULL, display_name TEXT DEFAULT NULL, avatar_url TEXT, description TEXT);
CREATE TABLE sqlite_sequence(name,seq);
CREATE TABLE user_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                ip_address TEXT NOT NULL,
                session_data TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                expires_at DATETIME,
                FOREIGN KEY (user_id) REFERENCES users (id)
            );
CREATE TABLE user_stats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                total_stream_time INTEGER DEFAULT 0,
                total_view_time INTEGER DEFAULT 0,
                stream_count INTEGER DEFAULT 0,
                last_stream_at DATETIME,
                chat_message_count INTEGER DEFAULT 0,
                points INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, chat_color TEXT DEFAULT NULL, points_balance INTEGER DEFAULT 0,
                FOREIGN KEY (user_id) REFERENCES users (id)
            );
CREATE TABLE ip_to_user_transfers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                ip_address TEXT NOT NULL,
                session_data TEXT,
                transferred_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id)
            );
CREATE TABLE items (
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
            , duration_seconds INTEGER DEFAULT 0, effect_data TEXT, stack_behavior TEXT DEFAULT 'replace', category TEXT DEFAULT 'general');
CREATE TABLE user_inventory (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                item_id INTEGER NOT NULL,
                quantity INTEGER NOT NULL DEFAULT 0,
                acquired_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_used_at DATETIME,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
                FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE,
                UNIQUE(user_id, item_id)
            );
CREATE TABLE item_usage_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                item_id INTEGER NOT NULL,
                stream_id TEXT,
                used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                effect_duration INTEGER,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
                FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE
            );
CREATE TABLE shop_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                item_id INTEGER NOT NULL,
                price INTEGER NOT NULL,
                discount_percentage INTEGER DEFAULT 0,
                is_featured BOOLEAN DEFAULT 0,
                stock_limit INTEGER DEFAULT -1,
                available_from DATETIME,
                available_until DATETIME,
                FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE
            );
CREATE TABLE item_transactions (
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
            );
CREATE TABLE gift_transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_user_id INTEGER NOT NULL,
                to_user_id INTEGER NOT NULL,
                item_id INTEGER NOT NULL,
                quantity INTEGER NOT NULL DEFAULT 1,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (from_user_id) REFERENCES users (id) ON DELETE CASCADE,
                FOREIGN KEY (to_user_id) REFERENCES users (id) ON DELETE CASCADE,
                FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE
            );
CREATE TABLE active_buffs (
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
            );
CREATE TABLE chatbots (
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
            , use_assigned_name BOOLEAN DEFAULT 1, llm_model TEXT, moviebot_enabled BOOLEAN DEFAULT 0, response_creativity_temperature REAL DEFAULT 0.7, is_temporary BOOLEAN DEFAULT 0, summoned_by_user_id INTEGER, expires_at DATETIME, summon_item_id INTEGER);
CREATE TABLE chatbot_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chatbot_id INTEGER NOT NULL,
                socket_id TEXT,
                username TEXT NOT NULL,
                color TEXT NOT NULL,
                connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_message_at DATETIME,
                FOREIGN KEY (chatbot_id) REFERENCES chatbots (id) ON DELETE CASCADE
            );
CREATE TABLE chatbot_message_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chatbot_id INTEGER NOT NULL,
                message TEXT NOT NULL,
                context TEXT,
                exact_prompt TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP, content TEXT, message_type TEXT DEFAULT 'chat', metadata TEXT,
                FOREIGN KEY (chatbot_id) REFERENCES chatbots (id) ON DELETE CASCADE
            );
CREATE TABLE messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                message TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
CREATE TABLE chatbot_config (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                global_prompt TEXT DEFAULT 'You are participating in a live stream chat. Be friendly, engaging, and keep responses concise (under 100 characters). Avoid repeating what others have said. Do not use quotes, asterisks for actions, or roleplay formatting.',
                llm_model TEXT DEFAULT 'mistral',
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
CREATE TABLE recordings (
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
                metadata TEXT, quality_profile TEXT DEFAULT '720p',
                FOREIGN KEY (user_id) REFERENCES users (id)
            );
CREATE TABLE recording_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                recording_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                event_data TEXT,
                user_id INTEGER,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id)
            );
CREATE TABLE recording_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                description TEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
CREATE TABLE custom_emojis (
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
            );
CREATE TABLE viewbots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    config TEXT NOT NULL, -- JSON string of bot configuration
    content_type TEXT NOT NULL CHECK(content_type IN ('testPattern', 'customText', 'videoFile', 'webCam', 'screenCapture')),
    is_enabled BOOLEAN DEFAULT 1,
    auto_start BOOLEAN DEFAULT 0,
    time_allotment INTEGER, -- Custom time allotment in milliseconds, NULL for random
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME,
    usage_count INTEGER DEFAULT 0
);
CREATE TABLE viewbot_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT UNIQUE NOT NULL,
    viewbot_id INTEGER NOT NULL,
    bot_id TEXT NOT NULL,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ended_at DATETIME,
    duration_ms INTEGER,
    stream_quality TEXT,
    viewer_count INTEGER DEFAULT 0,
    rotation_reason TEXT, -- 'time-expired', 'manual', 'takeover', etc.
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'completed', 'failed', 'interrupted')),
    error_message TEXT,
    metadata TEXT, -- JSON string for additional session data
    FOREIGN KEY (viewbot_id) REFERENCES viewbots (id) ON DELETE CASCADE
);
CREATE TABLE viewbot_system_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    rotation_enabled BOOLEAN DEFAULT 0,
    current_live_bot TEXT, -- bot_id of currently active ViewBot
    real_streamer_active BOOLEAN DEFAULT 0,
    max_bots INTEGER DEFAULT -1, -- -1 for unlimited
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
, rotation_probability REAL DEFAULT 0.045, rotation_check_interval_min INTEGER DEFAULT 5000, rotation_check_interval_max INTEGER DEFAULT 10000);
CREATE TABLE viewbot_rotation_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_bot_id TEXT,
    to_bot_id TEXT,
    rotation_reason TEXT NOT NULL,
    rotation_type TEXT DEFAULT 'automatic' CHECK(rotation_type IN ('automatic', 'manual', 'forced')),
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    duration_before_rotation INTEGER, -- milliseconds
    viewer_count_at_rotation INTEGER DEFAULT 0,
    metadata TEXT -- JSON string for additional rotation data
);
CREATE TABLE viewbot_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    viewbot_id INTEGER NOT NULL,
    bot_id TEXT NOT NULL,
    session_id TEXT,
    metric_type TEXT NOT NULL CHECK(metric_type IN ('health_check', 'stream_quality', 'viewer_engagement', 'error_rate')),
    metric_value REAL NOT NULL,
    metric_unit TEXT, -- 'percentage', 'count', 'milliseconds', etc.
    measured_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    additional_data TEXT, -- JSON string for detailed metric data
    FOREIGN KEY (viewbot_id) REFERENCES viewbots (id) ON DELETE CASCADE
);
CREATE TABLE viewbot_content_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    content_type TEXT NOT NULL,
    config TEXT NOT NULL, -- JSON configuration
    file_path TEXT, -- For video files, images, etc.
    is_active BOOLEAN DEFAULT 1,
    usage_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE points_transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                amount INTEGER NOT NULL,
                balance_after INTEGER NOT NULL,
                type VARCHAR(50) NOT NULL,
                description TEXT,
                metadata TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id)
            );
CREATE TABLE bug_reports (
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
            );
CREATE TABLE transcriptions (
    id TEXT PRIMARY KEY,
    streamer_id TEXT,
    start_time INTEGER,
    end_time INTEGER,
    duration INTEGER,
    word_count INTEGER DEFAULT 0,
    model TEXT,
    language TEXT,
    status TEXT DEFAULT 'active',
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
, stream_id TEXT);
CREATE TABLE transcription_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transcription_id TEXT,
    chunk_number INTEGER,
    text TEXT,
    timestamp INTEGER,
    confidence REAL,
    created_at INTEGER DEFAULT (strftime('%s', 'now')), word_count INTEGER DEFAULT 0,
    FOREIGN KEY (transcription_id) REFERENCES transcriptions(id)
);
CREATE TABLE ip_bans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip_address TEXT NOT NULL UNIQUE,
        banned_by_user_id INTEGER,
        banned_by_username TEXT,
        banned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        reason TEXT,
        permanent BOOLEAN DEFAULT 1,
        expires_at DATETIME,
        FOREIGN KEY (banned_by_user_id) REFERENCES users(id)
      );
CREATE TABLE streamer_connections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        streamer_id TEXT NOT NULL,
        streamer_name TEXT,
        ip_address TEXT NOT NULL,
        connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        disconnected_at DATETIME,
        stream_duration INTEGER, -- in seconds
        connection_type TEXT, -- 'webrtc', 'websocket', etc.
        user_agent TEXT,
        was_banned BOOLEAN DEFAULT 0,
        disconnect_reason TEXT
      );
CREATE TABLE streaming_logs (
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
        duration INTEGER, -- in seconds
        viewer_peak INTEGER DEFAULT 0,
        is_viewbot BOOLEAN DEFAULT 0,
        is_banned BOOLEAN DEFAULT 0,
        disconnect_reason TEXT,
        country TEXT,
        city TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
CREATE TABLE moviebot_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    use_groq BOOLEAN DEFAULT 0,
    groq_api_key TEXT,
    transcription_duration INTEGER DEFAULT 45,
    transcription_frequency INTEGER DEFAULT 120,
    chat_history_limit INTEGER DEFAULT 30,
    message_delay_min INTEGER DEFAULT 4000,
    message_delay_max INTEGER DEFAULT 8000,
    movie_prompt_template TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
, enabled BOOLEAN DEFAULT 0, streamer_id TEXT DEFAULT NULL);
CREATE TABLE groq_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled BOOLEAN DEFAULT 0,
    api_key TEXT,
    model TEXT DEFAULT 'llama-3.1-8b-instant',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE account_deletion_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                username TEXT NOT NULL,
                email TEXT NOT NULL,
                action TEXT NOT NULL CHECK(action IN ('deletion_requested', 'deletion_confirmed', 'deletion_cancelled', 'account_restored', 'data_purged')),
                ip_address TEXT,
                user_agent TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id)
            );
CREATE TABLE temporary_bots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chatbot_id INTEGER NOT NULL,
    summoned_by_user_id INTEGER NOT NULL,
    summoned_by_username TEXT NOT NULL,
    personality_prompt TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chatbot_id) REFERENCES chatbots (id) ON DELETE CASCADE
);
CREATE TABLE streambot_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT NOT NULL,
    enabled BOOLEAN DEFAULT 1,
    order_index INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE streambot_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    interval_minutes INTEGER DEFAULT 15,
    enabled BOOLEAN DEFAULT 1,
    current_message_index INTEGER DEFAULT 0,
    last_sent_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE clips (
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
            );
CREATE TABLE clip_views (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                clip_id TEXT NOT NULL,
                user_id INTEGER,
                ip_address TEXT,
                viewed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (clip_id) REFERENCES clips (clip_id),
                FOREIGN KEY (user_id) REFERENCES users (id)
            );
CREATE TABLE clip_chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                clip_id TEXT NOT NULL,
                username TEXT NOT NULL,
                message TEXT NOT NULL,
                relative_time_ms INTEGER NOT NULL,
                original_timestamp DATETIME,
                FOREIGN KEY (clip_id) REFERENCES clips (clip_id) ON DELETE CASCADE
            );
CREATE TABLE url_streams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url_id TEXT UNIQUE NOT NULL,
    source_url TEXT NOT NULL,
    platform TEXT,
    quality TEXT DEFAULT 'best',
    display_name TEXT,
    status TEXT DEFAULT 'pending',
    started_at DATETIME,
    ended_at DATETIME,
    end_reason TEXT,
    total_uptime INTEGER DEFAULT 0,
    reconnect_count INTEGER DEFAULT 0,
    auto_reconnect BOOLEAN DEFAULT 1,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE url_stream_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url_stream_id INTEGER REFERENCES url_streams(id),
    url_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    message TEXT,
    metadata TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE url_stream_health (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url_id TEXT NOT NULL,
    source_status TEXT,
    ffmpeg_status TEXT,
    frame_count INTEGER DEFAULT 0,
    bitrate TEXT,
    fps TEXT,
    overall_health INTEGER DEFAULT 100,
    error_count INTEGER DEFAULT 0,
    warning_count INTEGER DEFAULT 0,
    last_check DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE url_stream_presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    source_url TEXT NOT NULL,
    platform TEXT,
    quality TEXT DEFAULT 'best',
    display_name TEXT,
    auto_reconnect BOOLEAN DEFAULT 1,
    is_active BOOLEAN DEFAULT 1,
    last_used DATETIME,
    use_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE auto_summon_settings (
                id INTEGER PRIMARY KEY DEFAULT 1,
                enabled INTEGER DEFAULT 0,
                interval_minutes INTEGER DEFAULT 70,
                bot_duration_seconds INTEGER DEFAULT 3600,
                last_summoned_at DATETIME,
                total_summoned INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
CREATE TABLE auto_summoned_bots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chatbot_id INTEGER,
                bot_name TEXT NOT NULL,
                personality_prompt TEXT NOT NULL,
                generated_prompt TEXT,
                summoned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                expired_at DATETIME,
                FOREIGN KEY (chatbot_id) REFERENCES chatbots(id)
            );
CREATE TABLE game_world (
                id INTEGER PRIMARY KEY DEFAULT 1,
                tiles TEXT NOT NULL,
                buildings TEXT NOT NULL,
                spawn_points TEXT NOT NULL,
                config TEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
CREATE TABLE game_player_state (
                user_id INTEGER PRIMARY KEY,
                x REAL NOT NULL DEFAULT 100,
                y REAL NOT NULL DEFAULT 100,
                sprite_id TEXT DEFAULT 'player_default',
                inventory TEXT DEFAULT '[]',
                stats TEXT DEFAULT '{}',
                last_active DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
            );
CREATE TABLE game_world_items (
                id TEXT PRIMARY KEY,
                item_type TEXT NOT NULL,
                x REAL NOT NULL,
                y REAL NOT NULL,
                data TEXT,
                spawned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                picked_up_by INTEGER,
                picked_up_at DATETIME,
                FOREIGN KEY (picked_up_by) REFERENCES users (id) ON DELETE SET NULL
            );
CREATE TABLE game_sessions (
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
            );
CREATE TABLE game_player_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                left_at DATETIME,
                items_collected INTEGER DEFAULT 0,
                distance_traveled REAL DEFAULT 0,
                FOREIGN KEY (session_id) REFERENCES game_sessions (id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
            );
CREATE TABLE recording_sessions (
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
            );
CREATE TABLE session_chat_messages (
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
            );
CREATE TABLE admin_review_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                description TEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
CREATE TABLE recording_stream_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    stream_identity TEXT NOT NULL,
    stream_type TEXT NOT NULL,  -- 'url_stream', 'real_streamer', 'viewbot'
    display_name TEXT,
    platform TEXT,
    source_url TEXT,
    started_at INTEGER NOT NULL,  -- Unix ms when this stream started in recording
    ended_at INTEGER,             -- Unix ms when this stream ended (NULL if still active)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, detected_video_time INTEGER, sync_offset_ms INTEGER, detected_video_end_time INTEGER,
    FOREIGN KEY (session_id) REFERENCES recording_sessions(session_id) ON DELETE CASCADE
);
CREATE TABLE black_frame_transitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    black_start_ms INTEGER NOT NULL,
    black_end_ms INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE b2_uploaded_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    segment_name TEXT NOT NULL,
    b2_key TEXT NOT NULL UNIQUE,
    file_size INTEGER,
    uploaded INTEGER DEFAULT 0,
    uploaded_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_users_email ON users(email)
        ;
CREATE INDEX idx_users_username ON users(username)
        ;
CREATE INDEX idx_user_sessions_user_id ON user_sessions(user_id)
        ;
CREATE INDEX idx_user_sessions_ip ON user_sessions(ip_address)
        ;
CREATE INDEX idx_user_inventory_user_id ON user_inventory(user_id);
CREATE INDEX idx_item_usage_log_user_id ON item_usage_log(user_id);
CREATE INDEX idx_item_transactions_user_id ON item_transactions(user_id);
CREATE INDEX idx_shop_items_item_id ON shop_items(item_id);
CREATE INDEX idx_active_buffs_user_id ON active_buffs(user_id);
CREATE INDEX idx_active_buffs_active ON active_buffs(is_active);
CREATE INDEX idx_active_buffs_type ON active_buffs(buff_type);
CREATE INDEX idx_chatbots_enabled ON chatbots(is_enabled);
CREATE INDEX idx_chatbot_sessions_bot_id ON chatbot_sessions(chatbot_id);
CREATE INDEX idx_chatbot_message_history_bot_id ON chatbot_message_history(chatbot_id);
CREATE INDEX idx_messages_created_at ON messages(created_at);
CREATE INDEX idx_custom_emojis_code ON custom_emojis(code);
CREATE INDEX idx_custom_emojis_active ON custom_emojis(is_active);
CREATE INDEX idx_viewbots_bot_id ON viewbots(bot_id);
CREATE INDEX idx_viewbots_enabled ON viewbots(is_enabled);
CREATE INDEX idx_viewbots_content_type ON viewbots(content_type);
CREATE INDEX idx_viewbot_sessions_viewbot_id ON viewbot_sessions(viewbot_id);
CREATE INDEX idx_viewbot_sessions_bot_id ON viewbot_sessions(bot_id);
CREATE INDEX idx_viewbot_sessions_status ON viewbot_sessions(status);
CREATE INDEX idx_viewbot_sessions_started_at ON viewbot_sessions(started_at);
CREATE INDEX idx_viewbot_rotation_from_bot ON viewbot_rotation_history(from_bot_id);
CREATE INDEX idx_viewbot_rotation_to_bot ON viewbot_rotation_history(to_bot_id);
CREATE INDEX idx_viewbot_rotation_timestamp ON viewbot_rotation_history(timestamp);
CREATE INDEX idx_viewbot_metrics_viewbot_id ON viewbot_metrics(viewbot_id);
CREATE INDEX idx_viewbot_metrics_bot_id ON viewbot_metrics(bot_id);
CREATE INDEX idx_viewbot_metrics_type ON viewbot_metrics(metric_type);
CREATE INDEX idx_viewbot_metrics_measured_at ON viewbot_metrics(measured_at);
CREATE INDEX idx_viewbot_content_sources_type ON viewbot_content_sources(content_type);
CREATE INDEX idx_viewbot_content_sources_active ON viewbot_content_sources(is_active);
CREATE INDEX idx_recordings_status ON recordings(status);
CREATE INDEX idx_recordings_session ON recordings(session_id);
CREATE INDEX idx_recording_events_recording ON recording_events(recording_id);
CREATE INDEX idx_recordings_user ON recordings(user_id);
CREATE INDEX idx_points_transactions_user_id 
            ON points_transactions(user_id)
        ;
CREATE INDEX idx_points_transactions_created_at 
            ON points_transactions(created_at)
        ;
CREATE INDEX idx_recordings_created_at ON recordings(created_at);
CREATE INDEX idx_bug_reports_user_id ON bug_reports(user_id)
        ;
CREATE INDEX idx_bug_reports_status ON bug_reports(status)
        ;
CREATE INDEX idx_bug_reports_created_at ON bug_reports(created_at)
        ;
CREATE INDEX idx_transcriptions_streamer ON transcriptions(streamer_id);
CREATE INDEX idx_transcriptions_created ON transcriptions(created_at);
CREATE INDEX idx_chunks_transcription ON transcription_chunks(transcription_id);
CREATE INDEX idx_ip_bans_ip ON ip_bans(ip_address);
CREATE INDEX idx_streamer_connections_ip ON streamer_connections(ip_address);
CREATE INDEX idx_streamer_connections_streamer ON streamer_connections(streamer_id);
CREATE INDEX idx_streamer_connections_connected ON streamer_connections(connected_at DESC);
CREATE INDEX idx_streaming_logs_ip ON streaming_logs(ip_address);
CREATE INDEX idx_streaming_logs_started ON streaming_logs(started_at DESC);
CREATE INDEX idx_streaming_logs_user ON streaming_logs(user_id);
CREATE INDEX idx_streaming_logs_session ON streaming_logs(session_id);
CREATE INDEX idx_streaming_logs_viewbot ON streaming_logs(is_viewbot);
CREATE INDEX idx_users_account_status ON users(account_status);
CREATE INDEX idx_users_deletion_scheduled ON users(deletion_scheduled_for);
CREATE INDEX idx_deletion_logs_user_id ON account_deletion_logs(user_id);
CREATE INDEX idx_chatbots_temporary_expires 
            ON chatbots(is_temporary, expires_at)
        ;
CREATE INDEX idx_clips_clip_id ON clips(clip_id);
CREATE INDEX idx_clips_user ON clips(user_id);
CREATE INDEX idx_clips_status ON clips(status);
CREATE INDEX idx_clips_public ON clips(is_public);
CREATE INDEX idx_clips_created ON clips(created_at);
CREATE INDEX idx_clip_views_clip ON clip_views(clip_id);
CREATE INDEX idx_clips_user_id ON clips(user_id);
CREATE INDEX idx_clips_created_at ON clips(created_at);
CREATE INDEX idx_clips_is_public ON clips(is_public);
CREATE INDEX idx_clip_views_clip_id ON clip_views(clip_id);
CREATE INDEX idx_clip_chat_clip_id ON clip_chat_messages(clip_id);
CREATE INDEX idx_clip_chat_relative_time ON clip_chat_messages(clip_id, relative_time_ms);
CREATE INDEX idx_url_streams_url_id ON url_streams(url_id);
CREATE INDEX idx_url_streams_status ON url_streams(status);
CREATE INDEX idx_url_stream_logs_url_id ON url_stream_logs(url_id);
CREATE INDEX idx_url_stream_logs_timestamp ON url_stream_logs(timestamp);
CREATE INDEX idx_url_stream_health_url_id ON url_stream_health(url_id);
CREATE INDEX idx_url_stream_presets_name ON url_stream_presets(name);
CREATE INDEX idx_game_player_state_user ON game_player_state(user_id);
CREATE INDEX idx_game_world_items_location ON game_world_items(x, y);
CREATE INDEX idx_game_world_items_type ON game_world_items(item_type);
CREATE INDEX idx_game_sessions_active ON game_sessions(ended_at);
CREATE INDEX idx_game_player_sessions_session ON game_player_sessions(session_id);
CREATE INDEX idx_game_player_sessions_user ON game_player_sessions(user_id);
CREATE INDEX idx_recording_sessions_start ON recording_sessions(start_time DESC);
CREATE INDEX idx_recording_sessions_status ON recording_sessions(status);
CREATE INDEX idx_recording_sessions_streamer ON recording_sessions(streamer_identity);
CREATE INDEX idx_session_chat_session_id ON session_chat_messages(session_id);
CREATE INDEX idx_session_chat_time ON session_chat_messages(session_id, relative_time_ms);
CREATE INDEX idx_session_chat_absolute ON session_chat_messages(session_id, absolute_time_ms);
CREATE INDEX idx_recordings_quality_profile ON recordings(quality_profile);
CREATE INDEX idx_recording_events_recording_id ON recording_events(recording_id);
CREATE INDEX idx_recording_events_timestamp ON recording_events(timestamp);
CREATE INDEX idx_recording_events_event_type ON recording_events(event_type);
CREATE INDEX idx_stream_segments_session ON recording_stream_segments(session_id);
CREATE INDEX idx_stream_segments_time ON recording_stream_segments(started_at);
CREATE INDEX idx_black_frame_session ON black_frame_transitions(session_id);
CREATE INDEX idx_black_frame_black_end ON black_frame_transitions(session_id, black_end_ms);
CREATE INDEX idx_b2_segments_session ON b2_uploaded_segments(session_id);
CREATE INDEX idx_b2_segments_b2_key ON b2_uploaded_segments(b2_key);
CREATE INDEX idx_b2_segments_uploaded ON b2_uploaded_segments(uploaded);
CREATE INDEX idx_stream_segments_started ON recording_stream_segments(started_at);
CREATE INDEX idx_stream_segments_session_started ON recording_stream_segments(session_id, started_at);
CREATE INDEX idx_session_chat_abs_time ON session_chat_messages(absolute_time_ms);
