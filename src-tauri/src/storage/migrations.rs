use anyhow::Result;
use rusqlite::Connection;
use tracing::info;

/// Current schema version.
pub const SCHEMA_VERSION: u32 = 5;

/// Get the current schema version from the database.
pub fn get_schema_version(conn: &Connection) -> u32 {
    conn.query_row(
        "SELECT value FROM app_config WHERE key = 'schema_version'",
        [],
        |row| {
            let v: String = row.get(0)?;
            Ok(v.parse::<u32>().unwrap_or(1))
        },
    )
    .unwrap_or(1) // No row = v1 (original schema)
}

/// Set the schema version.
fn set_schema_version(conn: &Connection, version: u32) -> Result<()> {
    conn.execute(
        "INSERT INTO app_config (key, value) VALUES ('schema_version', ?1)
         ON CONFLICT(key) DO UPDATE SET value = ?1",
        [version.to_string()],
    )?;
    Ok(())
}

/// Run all pending migrations.
pub fn run_migrations(conn: &Connection) -> Result<()> {
    let current = get_schema_version(conn);

    if current >= SCHEMA_VERSION {
        return Ok(());
    }

    if current < 2 {
        migrate_v1_to_v2(conn)?;
    }

    if current < 3 {
        migrate_v2_to_v3(conn)?;
    }

    if current < 4 {
        migrate_v3_to_v4(conn)?;
    }

    if current < 5 {
        migrate_v4_to_v5(conn)?;
    }

    set_schema_version(conn, SCHEMA_VERSION)?;
    info!("Database migrated to schema version {}", SCHEMA_VERSION);
    Ok(())
}

/// Migrate from v1 to v2:
/// - Add source column to nostr_events (table rename deferred to cutover)
/// - Create 10 new tables
/// - Bootstrap cursors, relay hints, tombstones from existing data
fn migrate_v1_to_v2(conn: &Connection) -> Result<()> {
    info!("Running migration v1 → v2...");

    // 1. Add source column to nostr_events (table stays as nostr_events until cutover)
    let has_source: bool = conn
        .prepare("SELECT source FROM nostr_events LIMIT 1")
        .is_ok();
    if !has_source {
        conn.execute_batch(
            "ALTER TABLE nostr_events ADD COLUMN source TEXT NOT NULL DEFAULT 'sync';",
        )?;
    }
    conn.execute_batch(
        r#"
        CREATE INDEX IF NOT EXISTS idx_events_source ON nostr_events(source);
        CREATE INDEX IF NOT EXISTS idx_events_pubkey_created ON nostr_events(pubkey, created_at);
        "#,
    )?;

    // 2. Create v2 tables
    create_v2_tables(conn)?;

    // 3. Bootstrap data from existing events
    bootstrap_cursors(conn)?;
    bootstrap_relay_hints(conn)?;
    bootstrap_tombstones(conn)?;
    bootstrap_retention_defaults(conn)?;

    // 4. Drop old sync_state table
    conn.execute_batch("DROP TABLE IF EXISTS sync_state;")?;

    info!("Migration v1 → v2 complete");
    Ok(())
}

/// Create all v2 tables (used by both migration and fresh installs).
pub fn create_v2_tables(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS user_relays (
            pubkey      TEXT NOT NULL,
            relay_url   TEXT NOT NULL,
            direction   TEXT NOT NULL DEFAULT 'both',
            source      TEXT NOT NULL,
            source_ts   INTEGER NOT NULL,
            PRIMARY KEY (pubkey, relay_url)
        );
        CREATE INDEX IF NOT EXISTS idx_user_relays_relay ON user_relays(relay_url);

        CREATE TABLE IF NOT EXISTS user_cursors (
            pubkey          TEXT PRIMARY KEY,
            last_event_ts   INTEGER NOT NULL,
            last_fetched_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS relay_stats (
            relay_url       TEXT PRIMARY KEY,
            success_count   INTEGER NOT NULL DEFAULT 0,
            failure_count   INTEGER NOT NULL DEFAULT 0,
            total_events    INTEGER NOT NULL DEFAULT 0,
            avg_latency_ms  INTEGER NOT NULL DEFAULT 0,
            last_success    INTEGER,
            last_failure    INTEGER,
            last_rate_limited INTEGER
        );

        CREATE TABLE IF NOT EXISTS relay_info (
            relay_url                   TEXT PRIMARY KEY,
            name                        TEXT,
            description                 TEXT,
            supported_nips              TEXT,
            software                    TEXT,
            version                     TEXT,
            limitation_payment_required INTEGER DEFAULT 0,
            limitation_auth_required    INTEGER DEFAULT 0,
            fetched_at                  INTEGER
        );

        CREATE TABLE IF NOT EXISTS deletion_tombstones (
            event_id            TEXT PRIMARY KEY,
            deleted_by          TEXT NOT NULL,
            deletion_event_id   TEXT NOT NULL,
            deleted_at          INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS retention_config (
            tier            TEXT PRIMARY KEY,
            min_events      INTEGER NOT NULL,
            time_window_secs INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS muted_users (
            pubkey      TEXT PRIMARY KEY,
            muted_at    INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS muted_events (
            event_id    TEXT PRIMARY KEY,
            muted_at    INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS muted_words (
            word        TEXT PRIMARY KEY,
            muted_at    INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS muted_hashtags (
            hashtag     TEXT PRIMARY KEY,
            muted_at    INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS thread_refs (
            referenced_id   TEXT NOT NULL,
            referencing_id  TEXT NOT NULL,
            PRIMARY KEY (referenced_id, referencing_id)
        );
        CREATE INDEX IF NOT EXISTS idx_thread_refs_ref ON thread_refs(referenced_id);
        "#,
    )?;
    Ok(())
}

/// Bootstrap user_cursors from existing events.
fn bootstrap_cursors(conn: &Connection) -> Result<()> {
    let now = chrono::Utc::now().timestamp();
    conn.execute(
        "INSERT OR IGNORE INTO user_cursors (pubkey, last_event_ts, last_fetched_at)
         SELECT pubkey, MAX(created_at), ?1 FROM nostr_events GROUP BY pubkey",
        [now],
    )?;
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM user_cursors", [], |r| r.get(0))?;
    info!("Bootstrapped {} user cursors from existing events", count);
    Ok(())
}

/// Bootstrap user_relays from kind:3 relay hints (p-tag position 2).
fn bootstrap_relay_hints(conn: &Connection) -> Result<()> {
    // Get all kind:3 events — we'll parse relay hints from their tags
    let mut stmt = conn.prepare(
        "SELECT pubkey, tags, created_at FROM nostr_events WHERE kind = 3 ORDER BY created_at DESC",
    )?;

    let rows: Vec<(String, String, i64)> = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .filter_map(|r| r.ok())
        .collect();

    let mut insert_stmt = conn.prepare(
        "INSERT OR IGNORE INTO user_relays (pubkey, relay_url, direction, source, source_ts)
         VALUES (?1, ?2, 'write', 'kind3_hint', ?3)",
    )?;

    let mut count = 0u64;
    for (_, tags_json, created_at) in &rows {
        if let Ok(tags) = serde_json::from_str::<Vec<Vec<String>>>(tags_json) {
            for tag in &tags {
                // p-tag format: ["p", pubkey, relay_url?, ...]
                if tag.len() >= 3 && tag[0] == "p" && !tag[2].is_empty() {
                    let followed_pk = &tag[1];
                    let relay_url = &tag[2];
                    if relay_url.starts_with("wss://") || relay_url.starts_with("ws://") {
                        insert_stmt.execute(rusqlite::params![
                            followed_pk,
                            relay_url,
                            created_at
                        ])?;
                        count += 1;
                    }
                }
            }
        }
    }

    info!("Bootstrapped {} relay hints from kind:3 events", count);
    Ok(())
}

/// Bootstrap deletion_tombstones from existing kind:5 events.
fn bootstrap_tombstones(conn: &Connection) -> Result<()> {
    let mut stmt = conn.prepare(
        "SELECT id, pubkey, tags, created_at FROM nostr_events WHERE kind = 5",
    )?;

    let rows: Vec<(String, String, String, i64)> = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?
        .filter_map(|r| r.ok())
        .collect();

    let mut insert_stmt = conn.prepare(
        "INSERT OR IGNORE INTO deletion_tombstones (event_id, deleted_by, deletion_event_id, deleted_at)
         VALUES (?1, ?2, ?3, ?4)",
    )?;

    let mut count = 0u64;
    for (deletion_id, author, tags_json, created_at) in &rows {
        if let Ok(tags) = serde_json::from_str::<Vec<Vec<String>>>(tags_json) {
            for tag in &tags {
                if tag.len() >= 2 && tag[0] == "e" {
                    insert_stmt.execute(rusqlite::params![
                        &tag[1], author, deletion_id, created_at
                    ])?;
                    count += 1;
                }
            }
        }
    }

    info!("Bootstrapped {} deletion tombstones from kind:5 events", count);
    Ok(())
}

/// Insert default retention config rows.
fn bootstrap_retention_defaults(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        INSERT OR IGNORE INTO retention_config (tier, min_events, time_window_secs)
        VALUES ('follows', 50, 2592000);
        INSERT OR IGNORE INTO retention_config (tier, min_events, time_window_secs)
        VALUES ('fof', 10, 604800);
        INSERT OR IGNORE INTO retention_config (tier, min_events, time_window_secs)
        VALUES ('others', 5, 259200);
        "#,
    )?;
    info!("Bootstrapped default retention config");
    Ok(())
}

fn migrate_v2_to_v3(conn: &Connection) -> Result<()> {
    info!("Running migration v2 → v3...");
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS profile_cache (
            pubkey TEXT PRIMARY KEY,
            fetched_at INTEGER NOT NULL
        );",
    )?;
    info!("Migration v2 → v3 complete");
    Ok(())
}

/// Migrate from v3 to v4:
/// - Add priority column to media_queue
/// - Add hop3 retention config
fn migrate_v3_to_v4(conn: &Connection) -> Result<()> {
    info!("Running migration v3 → v4...");

    // Add priority column to media_queue
    let has_priority: bool = conn
        .prepare("SELECT priority FROM media_queue LIMIT 1")
        .is_ok();
    if !has_priority {
        conn.execute_batch(
            "ALTER TABLE media_queue ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;",
        )?;
    }
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_media_queue_priority ON media_queue(priority DESC, queued_at ASC);",
    )?;

    // Add hop3 retention config
    conn.execute_batch(
        "INSERT OR IGNORE INTO retention_config (tier, min_events, time_window_secs) VALUES ('hop3', 3, 172800);",
    )?;

    info!("Migration v3 → v4 complete");
    Ok(())
}

/// Migrate from v4 to v5:
/// - Add bookmarked_media table for permanent media bookmarks
fn migrate_v4_to_v5(conn: &Connection) -> Result<()> {
    info!("Running migration v4 → v5...");

    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS bookmarked_media (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL,
            media_url TEXT NOT NULL,
            event_json TEXT NOT NULL,
            profile_json TEXT NOT NULL,
            bookmarked_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            UNIQUE(event_id, media_url)
        );
        CREATE INDEX IF NOT EXISTS idx_bookmarked_media_at ON bookmarked_media(bookmarked_at DESC);
        "#,
    )?;

    info!("Migration v4 → v5 complete");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_v1_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL;").unwrap();

        // Minimal v1 schema
        conn.execute_batch(
            r#"
            CREATE TABLE nodes (
                id INTEGER PRIMARY KEY,
                pubkey TEXT NOT NULL UNIQUE,
                kind3_event_id TEXT,
                kind3_created_at INTEGER,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE edges (
                follower_id INTEGER NOT NULL,
                followed_id INTEGER NOT NULL,
                PRIMARY KEY (follower_id, followed_id)
            );
            CREATE TABLE sync_state (
                relay_url TEXT PRIMARY KEY,
                last_event_time INTEGER,
                last_sync_at INTEGER
            );
            CREATE TABLE nostr_events (
                id TEXT PRIMARY KEY,
                pubkey TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                kind INTEGER NOT NULL,
                tags TEXT NOT NULL,
                content TEXT NOT NULL,
                sig TEXT NOT NULL,
                stored_at INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE app_config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE media_cache (
                hash TEXT PRIMARY KEY,
                url TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                pubkey TEXT NOT NULL,
                downloaded_at INTEGER NOT NULL,
                last_accessed INTEGER NOT NULL
            );
            CREATE TABLE media_queue (
                url TEXT PRIMARY KEY,
                pubkey TEXT NOT NULL,
                queued_at INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE tracked_profiles (
                pubkey TEXT PRIMARY KEY,
                tracked_at INTEGER NOT NULL DEFAULT 0,
                note TEXT
            );
            "#,
        )
        .unwrap();

        conn
    }

    #[test]
    fn test_fresh_v2_tables() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )
        .unwrap();
        create_v2_tables(&conn).unwrap();

        // Verify all tables exist
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        assert!(tables.contains(&"user_relays".to_string()));
        assert!(tables.contains(&"user_cursors".to_string()));
        assert!(tables.contains(&"relay_stats".to_string()));
        assert!(tables.contains(&"relay_info".to_string()));
        assert!(tables.contains(&"deletion_tombstones".to_string()));
        assert!(tables.contains(&"retention_config".to_string()));
        assert!(tables.contains(&"muted_users".to_string()));
        assert!(tables.contains(&"muted_events".to_string()));
        assert!(tables.contains(&"muted_words".to_string()));
        assert!(tables.contains(&"muted_hashtags".to_string()));
        assert!(tables.contains(&"thread_refs".to_string()));
    }

    #[test]
    fn test_migrate_v1_to_v2() {
        let conn = create_v1_db();

        // Insert some v1 data
        conn.execute(
            "INSERT INTO nostr_events (id, pubkey, created_at, kind, tags, content, sig, stored_at)
             VALUES ('ev1', 'pk1', 1000, 1, '[]', 'hello', 'sig1', 1000)",
            [],
        )
        .unwrap();

        // Insert a kind:5 deletion event
        conn.execute(
            "INSERT INTO nostr_events (id, pubkey, created_at, kind, tags, content, sig, stored_at)
             VALUES ('del1', 'pk1', 1001, 5, '[[\"e\",\"ev_deleted\"]]', '', 'sig2', 1001)",
            [],
        )
        .unwrap();

        // Insert a kind:3 with relay hints
        conn.execute(
            "INSERT INTO nostr_events (id, pubkey, created_at, kind, tags, content, sig, stored_at)
             VALUES ('k3', 'pk1', 999, 3, '[[\"p\",\"pk2\",\"wss://relay.example.com\"]]', '', 'sig3', 999)",
            [],
        ).unwrap();

        assert_eq!(get_schema_version(&conn), 1);

        run_migrations(&conn).unwrap();

        assert_eq!(get_schema_version(&conn), SCHEMA_VERSION);

        // nostr_events should still be a table (not renamed yet — deferred to cutover)
        let table_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='nostr_events'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(table_count, 1);

        // nostr_events should have the source column
        let source: String = conn
            .query_row("SELECT source FROM nostr_events WHERE id='ev1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(source, "sync");

        // All events still accessible
        let event_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM nostr_events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(event_count, 3);

        // Cursors bootstrapped
        let cursor_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM user_cursors", [], |r| r.get(0))
            .unwrap();
        assert!(cursor_count > 0);

        // Tombstones bootstrapped
        let tomb_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM deletion_tombstones", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tomb_count, 1);

        // Relay hints bootstrapped
        let relay_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM user_relays", [], |r| r.get(0))
            .unwrap();
        assert_eq!(relay_count, 1);

        // Retention defaults bootstrapped (follows, fof, others + hop3 from v4)
        let ret_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM retention_config", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ret_count, 4);

        // sync_state should be dropped
        let ss_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='sync_state'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ss_count, 0);
    }

    #[test]
    fn test_migration_idempotent() {
        let conn = create_v1_db();
        run_migrations(&conn).unwrap();

        // Running again should be a no-op
        run_migrations(&conn).unwrap();
        assert_eq!(get_schema_version(&conn), SCHEMA_VERSION);
    }
}
