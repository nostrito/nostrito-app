use anyhow::Result;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use parking_lot::Mutex;
use tracing::{debug, info, warn};

use crate::storage::migrations;
use crate::wot::WotGraph;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileInfo {
    pub pubkey: String,
    pub name: Option<String>,
    pub display_name: Option<String>,
    pub picture: Option<String>,
    pub picture_local: Option<String>,
    pub nip05: Option<String>,
    pub about: Option<String>,
    pub banner: Option<String>,
    pub website: Option<String>,
    pub lud16: Option<String>,
}

pub struct Database {
    conn: Mutex<Connection>,
    pub data_dir: std::path::PathBuf,
}

/// Batch update item for efficient multi-event persistence
pub struct FollowUpdateBatch<'a> {
    pub pubkey: &'a str,
    pub follows: &'a [String],
    pub event_id: Option<&'a str>,
    pub created_at: Option<i64>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct SyncState {
    pub relay_url: String,
    pub last_event_time: Option<i64>,
    pub last_sync_at: Option<i64>,
}

impl Database {
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self> {
        let db_path = path.as_ref();
        let data_dir = db_path.parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| std::path::PathBuf::from("."));
        let conn = Connection::open(db_path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")?;

        let db = Self {
            conn: Mutex::new(conn),
            data_dir,
        };
        db.init_schema()?;
        Ok(db)
    }

    fn init_schema(&self) -> Result<()> {
        let conn = self.conn.lock();

        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS nodes (
                id INTEGER PRIMARY KEY,
                pubkey TEXT NOT NULL UNIQUE,
                kind3_event_id TEXT,
                kind3_created_at INTEGER,
                updated_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_nodes_pubkey ON nodes(pubkey);

            CREATE TABLE IF NOT EXISTS edges (
                follower_id INTEGER NOT NULL,
                followed_id INTEGER NOT NULL,
                PRIMARY KEY (follower_id, followed_id),
                FOREIGN KEY (follower_id) REFERENCES nodes(id),
                FOREIGN KEY (followed_id) REFERENCES nodes(id)
            );

            CREATE INDEX IF NOT EXISTS idx_edges_follower ON edges(follower_id);
            CREATE INDEX IF NOT EXISTS idx_edges_followed ON edges(followed_id);

            CREATE TABLE IF NOT EXISTS sync_state (
                relay_url TEXT PRIMARY KEY,
                last_event_time INTEGER,
                last_sync_at INTEGER
            );

            CREATE TABLE IF NOT EXISTS nostr_events (
                id TEXT PRIMARY KEY,
                pubkey TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                kind INTEGER NOT NULL,
                tags TEXT NOT NULL,
                content TEXT NOT NULL,
                sig TEXT NOT NULL,
                stored_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
            );

            CREATE INDEX IF NOT EXISTS idx_events_pubkey ON nostr_events(pubkey);
            CREATE INDEX IF NOT EXISTS idx_events_kind ON nostr_events(kind);
            CREATE INDEX IF NOT EXISTS idx_events_created ON nostr_events(created_at);
            CREATE TABLE IF NOT EXISTS app_config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS media_cache (
                hash        TEXT PRIMARY KEY,
                url         TEXT NOT NULL,
                mime_type   TEXT NOT NULL,
                size_bytes  INTEGER NOT NULL,
                pubkey      TEXT NOT NULL,
                downloaded_at INTEGER NOT NULL,
                last_accessed INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_media_lru ON media_cache(last_accessed);
            CREATE INDEX IF NOT EXISTS idx_media_pubkey ON media_cache(pubkey);

            CREATE TABLE IF NOT EXISTS media_deleted (
                url TEXT PRIMARY KEY,
                deleted_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
            );

            CREATE TABLE IF NOT EXISTS media_queue (
                url TEXT PRIMARY KEY,
                pubkey TEXT NOT NULL,
                queued_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
                priority INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS tracked_profiles (
                pubkey TEXT PRIMARY KEY,
                tracked_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
                note TEXT
            );

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

            CREATE TABLE IF NOT EXISTS bookmark_lists (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
            );
            CREATE TABLE IF NOT EXISTS bookmark_list_items (
                list_id TEXT NOT NULL,
                event_id TEXT NOT NULL,
                added_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
                PRIMARY KEY (list_id, event_id),
                FOREIGN KEY (list_id) REFERENCES bookmark_lists(id) ON DELETE CASCADE
            );
        "#,
        )?;

        // Migration: add stored_at column if missing (for existing databases)
        let has_stored_at: bool = conn
            .prepare("SELECT stored_at FROM nostr_events LIMIT 1")
            .is_ok();
        if !has_stored_at {
            conn.execute_batch(
                "ALTER TABLE nostr_events ADD COLUMN stored_at INTEGER NOT NULL DEFAULT 0;"
            )?;
            info!("Migrated nostr_events: added stored_at column");
        }

        // Create stored_at index AFTER migration ensures the column exists
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_events_stored ON nostr_events(stored_at);"
        )?;

        // Create v2 tables (idempotent — IF NOT EXISTS)
        migrations::create_v2_tables(&conn)?;

        // Run pending migrations (v1→v2 rename, bootstrap data)
        migrations::run_migrations(&conn)?;

        info!("Database schema initialized (v{})", migrations::SCHEMA_VERSION);
        Ok(())
    }

    pub fn load_graph(&self, graph: &WotGraph) -> Result<()> {
        let conn = self.conn.lock();

        let mut node_stmt = conn.prepare(
            "SELECT id, pubkey, kind3_event_id, kind3_created_at FROM nodes ORDER BY id",
        )?;

        let nodes: Vec<(i64, String, Option<String>, Option<i64>)> = node_stmt
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?
            .filter_map(|r| r.ok())
            .collect();

        info!("Loading {} nodes from database", nodes.len());

        for (_, pubkey, _, _) in &nodes {
            graph.get_or_create_node(pubkey);
        }

        let mut edge_stmt = conn.prepare(
            "SELECT e.follower_id, n.pubkey, GROUP_CONCAT(n2.pubkey) as follows
             FROM edges e
             JOIN nodes n ON e.follower_id = n.id
             JOIN nodes n2 ON e.followed_id = n2.id
             GROUP BY e.follower_id",
        )?;

        let mut edge_count = 0;
        let edges: Vec<(String, String)> = edge_stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(1)?, row.get::<_, String>(2)?))
            })?
            .filter_map(|r| r.ok())
            .collect();

        for (follower_pubkey, follows_csv) in edges {
            let follows: Vec<String> = follows_csv.split(',').map(|s| s.to_string()).collect();
            edge_count += follows.len();

            let node_info = nodes
                .iter()
                .find(|(_, pk, _, _)| pk == &follower_pubkey);

            let (event_id, created_at) = node_info
                .map(|(_, _, eid, cat)| (eid.clone(), *cat))
                .unwrap_or((None, None));

            graph.update_follows(&follower_pubkey, &follows, event_id, created_at);
        }

        info!("Loaded {} edges from database", edge_count);
        Ok(())
    }

    pub fn update_follows_batch(&self, updates: &[FollowUpdateBatch<'_>]) -> Result<usize> {
        if updates.is_empty() {
            return Ok(0);
        }

        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        let now = chrono::Utc::now().timestamp();

        let success_count = {
            let mut upsert_node_stmt = tx.prepare_cached(
                r#"
                INSERT INTO nodes (pubkey, kind3_event_id, kind3_created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4)
                ON CONFLICT(pubkey) DO UPDATE SET
                    kind3_event_id = CASE
                        WHEN ?3 IS NOT NULL AND (kind3_created_at IS NULL OR ?3 > kind3_created_at)
                        THEN COALESCE(?2, kind3_event_id)
                        ELSE kind3_event_id
                    END,
                    kind3_created_at = CASE
                        WHEN ?3 IS NOT NULL AND (kind3_created_at IS NULL OR ?3 > kind3_created_at)
                        THEN ?3
                        ELSE kind3_created_at
                    END,
                    updated_at = ?4
                "#,
            )?;

            let mut get_id_stmt =
                tx.prepare_cached("SELECT id FROM nodes WHERE pubkey = ?1")?;

            let mut delete_edges_stmt =
                tx.prepare_cached("DELETE FROM edges WHERE follower_id = ?1")?;

            let mut insert_follow_node_stmt = tx.prepare_cached(
                "INSERT INTO nodes (pubkey, updated_at) VALUES (?1, ?2) ON CONFLICT(pubkey) DO NOTHING",
            )?;

            let mut insert_edge_stmt = tx.prepare_cached(
                "INSERT OR IGNORE INTO edges (follower_id, followed_id) VALUES (?1, ?2)",
            )?;

            let mut success_count = 0;

            for update in updates {
                upsert_node_stmt.execute(params![
                    update.pubkey,
                    update.event_id,
                    update.created_at,
                    now
                ])?;

                let follower_id: i64 =
                    get_id_stmt.query_row(params![update.pubkey], |row| row.get(0))?;

                delete_edges_stmt.execute(params![follower_id])?;

                if update.follows.is_empty() {
                    success_count += 1;
                    continue;
                }

                for follow_pubkey in update.follows {
                    insert_follow_node_stmt.execute(params![follow_pubkey, now])?;
                }

                const CHUNK_SIZE: usize = 500;
                let mut followed_ids: Vec<i64> = Vec::with_capacity(update.follows.len());

                for chunk in update.follows.chunks(CHUNK_SIZE) {
                    let placeholders: Vec<&str> = chunk.iter().map(|_| "?").collect();
                    let in_clause = placeholders.join(",");
                    let select_sql =
                        format!("SELECT id FROM nodes WHERE pubkey IN ({})", in_clause);

                    let mut select_stmt = tx.prepare(&select_sql)?;
                    let params_vec: Vec<&dyn rusqlite::ToSql> = chunk
                        .iter()
                        .map(|s| s as &dyn rusqlite::ToSql)
                        .collect();

                    let rows = select_stmt
                        .query_map(params_vec.as_slice(), |row| row.get::<_, i64>(0))?;
                    followed_ids.extend(rows.filter_map(|r| r.ok()));
                }

                for followed_id in &followed_ids {
                    insert_edge_stmt.execute(params![follower_id, followed_id])?;
                }

                success_count += 1;
            }

            success_count
        };

        tx.commit()?;
        debug!("Batch persisted {} follow updates", success_count);

        Ok(success_count)
    }

    #[allow(dead_code)]
    pub fn get_sync_state(&self, relay_url: &str) -> Result<Option<SyncState>> {
        let conn = self.conn.lock();

        let result = conn.query_row(
            "SELECT relay_url, last_event_time, last_sync_at FROM sync_state WHERE relay_url = ?1",
            params![relay_url],
            |row| {
                Ok(SyncState {
                    relay_url: row.get(0)?,
                    last_event_time: row.get(1)?,
                    last_sync_at: row.get(2)?,
                })
            },
        );

        match result {
            Ok(state) => Ok(Some(state)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    #[allow(dead_code)]
    pub fn set_sync_state(&self, relay_url: &str, last_event_time: Option<i64>) -> Result<()> {
        let conn = self.conn.lock();
        let now = chrono::Utc::now().timestamp();

        conn.execute(
            r#"
            INSERT INTO sync_state (relay_url, last_event_time, last_sync_at)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(relay_url) DO UPDATE SET
                last_event_time = ?2,
                last_sync_at = ?3
            "#,
            params![relay_url, last_event_time, now],
        )?;

        Ok(())
    }

    pub fn get_stats(&self) -> Result<(usize, usize)> {
        let conn = self.conn.lock();

        let node_count: usize =
            conn.query_row("SELECT COUNT(*) FROM nodes", [], |row| row.get(0))?;

        let edge_count: usize =
            conn.query_row("SELECT COUNT(*) FROM edges", [], |row| row.get(0))?;

        Ok((node_count, edge_count))
    }

    /// Store app config key-value
    pub fn set_config(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO app_config (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
            params![key, value],
        )?;
        Ok(())
    }

    /// Get app config value
    pub fn get_config(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock();
        let result = conn.query_row(
            "SELECT value FROM app_config WHERE key = ?1",
            params![key],
            |row| row.get(0),
        );
        match result {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Delete an app config key
    pub fn delete_config(&self, key: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM app_config WHERE key = ?1", params![key])?;
        Ok(())
    }

    /// Query events by kind, returning (id, tags_json) pairs.
    pub fn query_events_by_kind(&self, kind: u32, limit: u32) -> Result<Vec<(String, String)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, tags FROM nostr_events WHERE kind = ?1 ORDER BY created_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![kind, limit], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }
        Ok(results)
    }

    /// Clear all sync_state rows (per-relay cursors)
    pub fn clear_sync_state(&self) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM sync_state", [])?;
        info!("Cleared sync_state table");
        Ok(())
    }

    /// Store a nostr event. Returns Ok(true) if inserted, Ok(false) if duplicate.
    pub fn store_event(
        &self,
        id: &str,
        pubkey: &str,
        created_at: i64,
        kind: u32,
        tags_json: &str,
        content: &str,
        sig: &str,
    ) -> Result<bool> {
        let conn = self.conn.lock();
        let now = chrono::Utc::now().timestamp();
        let result = conn.execute(
            "INSERT OR IGNORE INTO nostr_events (id, pubkey, created_at, kind, tags, content, sig, stored_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, pubkey, created_at, kind as i64, tags_json, content, sig, now],
        )?;
        let inserted = result > 0;
        if inserted {
            debug!("[db] store_event: id={}… kind={} pubkey={}…", &id[..std::cmp::min(12, id.len())], kind, &pubkey[..std::cmp::min(8, pubkey.len())]);
        }
        Ok(inserted)
    }

    /// Query nostr events with optional filters. Returns (id, pubkey, created_at, kind, tags_json, content, sig).
    pub fn query_events(
        &self,
        ids: Option<&[String]>,
        authors: Option<&[String]>,
        kinds: Option<&[u32]>,
        since: Option<u64>,
        until: Option<u64>,
        limit: u32,
    ) -> Result<Vec<(String, String, i64, i64, String, String, String)>> {
        let conn = self.conn.lock();

        let mut sql = String::from(
            "SELECT id, pubkey, created_at, kind, tags, content, sig FROM nostr_events WHERE 1=1",
        );
        let mut param_values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        if let Some(ids) = ids {
            if !ids.is_empty() {
                let placeholders: Vec<String> = ids.iter().enumerate().map(|(i, _)| format!("?{}", param_values.len() + i + 1)).collect();
                sql.push_str(&format!(" AND id IN ({})", placeholders.join(",")));
                for id in ids {
                    param_values.push(Box::new(id.clone()));
                }
            }
        }

        if let Some(authors) = authors {
            if !authors.is_empty() {
                let placeholders: Vec<String> = (0..authors.len()).map(|i| format!("?{}", param_values.len() + i + 1)).collect();
                sql.push_str(&format!(" AND pubkey IN ({})", placeholders.join(",")));
                for a in authors {
                    param_values.push(Box::new(a.clone()));
                }
            }
        }

        if let Some(kinds) = kinds {
            if !kinds.is_empty() {
                let placeholders: Vec<String> = (0..kinds.len()).map(|i| format!("?{}", param_values.len() + i + 1)).collect();
                sql.push_str(&format!(" AND kind IN ({})", placeholders.join(",")));
                for k in kinds {
                    param_values.push(Box::new(*k as i64));
                }
            }
        }

        if let Some(since) = since {
            let idx = param_values.len() + 1;
            sql.push_str(&format!(" AND created_at >= ?{}", idx));
            param_values.push(Box::new(since as i64));
        }

        if let Some(until) = until {
            let idx = param_values.len() + 1;
            sql.push_str(&format!(" AND created_at <= ?{}", idx));
            param_values.push(Box::new(until as i64));
        }

        // Exclude muted users and muted events
        sql.push_str(" AND pubkey NOT IN (SELECT pubkey FROM muted_users)");
        sql.push_str(" AND id NOT IN (SELECT event_id FROM muted_events)");

        sql.push_str(" ORDER BY created_at DESC");

        {
            let idx = param_values.len() + 1;
            sql.push_str(&format!(" LIMIT ?{}", idx));
            param_values.push(Box::new(limit as i64));
        }

        debug!("[db] query_events: ids={:?}, authors={}, kinds={:?}, since={:?}, until={:?}, limit={}", ids.map(|i| i.len()), authors.map(|a| a.len()).unwrap_or(0), kinds, since, until, limit);

        let params_refs: Vec<&dyn rusqlite::ToSql> =
            param_values.iter().map(|p| p.as_ref()).collect();

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params_refs.as_slice(), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(rows)
    }

    /// Query feed events restricted to WoT pubkeys (using nodes table subquery).
    /// Avoids SQLite parameter limit by not passing pubkeys as bind params.
    pub fn query_wot_feed(
        &self,
        own_pubkey: Option<&str>,
        kinds: Option<&[u32]>,
        since: Option<u64>,
        until: Option<u64>,
        limit: u32,
        exclude_replies: bool,
    ) -> Result<Vec<(String, String, i64, i64, String, String, String)>> {
        let conn = self.conn.lock();

        let mut sql = String::from(
            "SELECT id, pubkey, created_at, kind, tags, content, sig FROM nostr_events WHERE ",
        );
        let mut param_values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        // WoT filter: restrict to direct follows (hop 1) via edges table
        if let Some(own_pk) = own_pubkey {
            let idx = param_values.len() + 1;
            sql.push_str(&format!(
                "(pubkey IN (SELECT n2.pubkey FROM nodes n1 JOIN edges e ON e.follower_id = n1.id JOIN nodes n2 ON n2.id = e.followed_id WHERE n1.pubkey = ?{}) OR pubkey = ?{})",
                idx, idx
            ));
            param_values.push(Box::new(own_pk.to_string()));
        } else {
            sql.push_str("1=1");
        }

        if let Some(kinds) = kinds {
            if !kinds.is_empty() {
                let placeholders: Vec<String> = (0..kinds.len())
                    .map(|i| format!("?{}", param_values.len() + i + 1))
                    .collect();
                sql.push_str(&format!(" AND kind IN ({})", placeholders.join(",")));
                for k in kinds {
                    param_values.push(Box::new(*k as i64));
                }
            }
        }

        if let Some(since) = since {
            let idx = param_values.len() + 1;
            sql.push_str(&format!(" AND created_at >= ?{}", idx));
            param_values.push(Box::new(since as i64));
        }

        if let Some(until) = until {
            let idx = param_values.len() + 1;
            sql.push_str(&format!(" AND created_at <= ?{}", idx));
            param_values.push(Box::new(until as i64));
        }

        // Exclude replies (kind:1 events that have e-tags)
        if exclude_replies {
            sql.push_str(
                " AND NOT (kind = 1 AND EXISTS (SELECT 1 FROM json_each(nostr_events.tags) j WHERE json_extract(j.value, '$[0]') = 'e'))"
            );
        }

        // Exclude muted users and muted events
        sql.push_str(" AND pubkey NOT IN (SELECT pubkey FROM muted_users)");
        sql.push_str(" AND id NOT IN (SELECT event_id FROM muted_events)");

        sql.push_str(" ORDER BY created_at DESC");

        {
            let idx = param_values.len() + 1;
            sql.push_str(&format!(" LIMIT ?{}", idx));
            param_values.push(Box::new(limit as i64));
        }

        debug!(
            "[db] query_wot_feed: kinds={:?}, since={:?}, until={:?}, limit={}, exclude_replies={}",
            kinds, since, until, limit, exclude_replies
        );

        let params_refs: Vec<&dyn rusqlite::ToSql> =
            param_values.iter().map(|p| p.as_ref()).collect();

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params_refs.as_slice(), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(rows)
    }

    /// Query WoT replies: kind:1 events that have e-tags (i.e. replies to other notes).
    pub fn query_wot_replies(
        &self,
        own_pubkey: Option<&str>,
        since: Option<u64>,
        until: Option<u64>,
        limit: u32,
    ) -> Result<Vec<(String, String, i64, i64, String, String, String)>> {
        let conn = self.conn.lock();

        let mut sql = String::from(
            "SELECT id, pubkey, created_at, kind, tags, content, sig FROM nostr_events WHERE kind = 1",
        );
        let mut param_values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        // Must have e-tags (is a reply)
        sql.push_str(
            " AND EXISTS (SELECT 1 FROM json_each(nostr_events.tags) j WHERE json_extract(j.value, '$[0]') = 'e')"
        );

        // WoT filter
        if let Some(own_pk) = own_pubkey {
            let idx = param_values.len() + 1;
            sql.push_str(&format!(
                " AND (pubkey IN (SELECT n2.pubkey FROM nodes n1 JOIN edges e ON e.follower_id = n1.id JOIN nodes n2 ON n2.id = e.followed_id WHERE n1.pubkey = ?{}) OR pubkey = ?{})",
                idx, idx
            ));
            param_values.push(Box::new(own_pk.to_string()));
        }

        if let Some(since) = since {
            let idx = param_values.len() + 1;
            sql.push_str(&format!(" AND created_at >= ?{}", idx));
            param_values.push(Box::new(since as i64));
        }

        if let Some(until) = until {
            let idx = param_values.len() + 1;
            sql.push_str(&format!(" AND created_at <= ?{}", idx));
            param_values.push(Box::new(until as i64));
        }

        sql.push_str(" AND pubkey NOT IN (SELECT pubkey FROM muted_users)");
        sql.push_str(" ORDER BY created_at DESC");

        {
            let idx = param_values.len() + 1;
            sql.push_str(&format!(" LIMIT ?{}", idx));
            param_values.push(Box::new(limit as i64));
        }

        let params_refs: Vec<&dyn rusqlite::ToSql> =
            param_values.iter().map(|p| p.as_ref()).collect();

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params_refs.as_slice(), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(rows)
    }

    /// Count total replies referencing a given root event ID.
    pub fn count_thread_replies(&self, root_id: &str) -> Result<u32> {
        let conn = self.conn.lock();
        let count: u32 = conn.query_row(
            "SELECT COUNT(*) FROM nostr_events e, json_each(e.tags) j
             WHERE e.kind = 1
               AND json_extract(j.value, '$[0]') = 'e'
               AND json_extract(j.value, '$[1]') = ?1",
            params![root_id],
            |row| row.get(0),
        )?;
        Ok(count)
    }

    /// Query events that have a specific tag (e.g. ["e", note_id]).
    /// Optionally restricted to WoT pubkeys.
    pub fn query_events_by_tag(
        &self,
        tag_name: &str,
        tag_value: &str,
        kinds: Option<&[u32]>,
        own_pubkey: Option<&str>,
        until: Option<u64>,
        limit: u32,
    ) -> Result<Vec<(String, String, i64, i64, String, String, String)>> {
        let conn = self.conn.lock();

        let mut sql = String::from(
            "SELECT id, pubkey, created_at, kind, tags, content, sig FROM nostr_events WHERE ",
        );
        let mut param_values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        // Tag filter using json_each
        let idx1 = param_values.len() + 1;
        let idx2 = param_values.len() + 2;
        sql.push_str(&format!(
            "EXISTS (SELECT 1 FROM json_each(tags) WHERE json_extract(value, '$[0]') = ?{} AND json_extract(value, '$[1]') = ?{})",
            idx1, idx2
        ));
        param_values.push(Box::new(tag_name.to_string()));
        param_values.push(Box::new(tag_value.to_string()));

        // WoT filter
        if let Some(own_pk) = own_pubkey {
            let idx = param_values.len() + 1;
            sql.push_str(&format!(
                " AND (pubkey IN (SELECT n2.pubkey FROM nodes n1 JOIN edges e ON e.follower_id = n1.id JOIN nodes n2 ON n2.id = e.followed_id WHERE n1.pubkey = ?{}) OR pubkey = ?{})",
                idx, idx
            ));
            param_values.push(Box::new(own_pk.to_string()));
        }

        if let Some(kinds) = kinds {
            if !kinds.is_empty() {
                let placeholders: Vec<String> = (0..kinds.len())
                    .map(|i| format!("?{}", param_values.len() + i + 1))
                    .collect();
                sql.push_str(&format!(" AND kind IN ({})", placeholders.join(",")));
                for k in kinds {
                    param_values.push(Box::new(*k as i64));
                }
            }
        }

        if let Some(until) = until {
            let idx = param_values.len() + 1;
            sql.push_str(&format!(" AND created_at <= ?{}", idx));
            param_values.push(Box::new(until as i64));
        }

        // Exclude muted users and muted events
        sql.push_str(" AND pubkey NOT IN (SELECT pubkey FROM muted_users)");
        sql.push_str(" AND id NOT IN (SELECT event_id FROM muted_events)");

        sql.push_str(" ORDER BY created_at DESC");
        {
            let idx = param_values.len() + 1;
            sql.push_str(&format!(" LIMIT ?{}", idx));
            param_values.push(Box::new(limit as i64));
        }

        let params_refs: Vec<&dyn rusqlite::ToSql> =
            param_values.iter().map(|p| p.as_ref()).collect();

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params_refs.as_slice(), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(rows)
    }

    /// Get notifications: events mentioning own pubkey via p-tags (kinds 1, 7, 6, 9735).
    /// Excludes own events and muted users.
    pub fn get_notifications(
        &self,
        own_pubkey: &str,
        until: Option<u64>,
        limit: u32,
    ) -> Result<Vec<(String, String, i64, i64, String, String, String)>> {
        let conn = self.conn.lock();

        let mut sql = String::from(
            "SELECT id, pubkey, created_at, kind, tags, content, sig FROM nostr_events \
             WHERE kind IN (1, 7, 6, 9735) \
             AND pubkey != ?1 \
             AND EXISTS (SELECT 1 FROM json_each(tags) WHERE json_extract(value, '$[0]') = 'p' AND json_extract(value, '$[1]') = ?1) \
             AND pubkey NOT IN (SELECT pubkey FROM muted_users) \
             AND id NOT IN (SELECT event_id FROM muted_events)",
        );
        let mut param_values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        param_values.push(Box::new(own_pubkey.to_string()));

        if let Some(u) = until {
            let idx = param_values.len() + 1;
            sql.push_str(&format!(" AND created_at <= ?{}", idx));
            param_values.push(Box::new(u as i64));
        }

        sql.push_str(" ORDER BY created_at DESC");
        let idx = param_values.len() + 1;
        sql.push_str(&format!(" LIMIT ?{}", idx));
        param_values.push(Box::new(limit as i64));

        let params_refs: Vec<&dyn rusqlite::ToSql> =
            param_values.iter().map(|p| p.as_ref()).collect();

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params_refs.as_slice(), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(rows)
    }

    /// Count notification events stored since a given timestamp (for unread badge).
    pub fn get_notification_count_since(
        &self,
        own_pubkey: &str,
        since_stored_at: i64,
    ) -> Result<i64> {
        let conn = self.conn.lock();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM nostr_events \
             WHERE kind IN (1, 7, 6, 9735) \
             AND pubkey != ?1 \
             AND stored_at > ?2 \
             AND EXISTS (SELECT 1 FROM json_each(tags) WHERE json_extract(value, '$[0]') = 'p' AND json_extract(value, '$[1]') = ?1) \
             AND pubkey NOT IN (SELECT pubkey FROM muted_users)",
            rusqlite::params![own_pubkey, since_stored_at],
            |row| row.get(0),
        )?;
        Ok(count)
    }

    /// Get popular hashtags from the last 7 days, ranked by usage count.
    pub fn get_popular_hashtags(&self, limit: u32) -> Result<Vec<(String, i64)>> {
        let conn = self.conn.lock();
        let week_ago = chrono::Utc::now().timestamp() - 7 * 86400;
        let mut stmt = conn.prepare(
            "SELECT LOWER(json_extract(t.value, '$[1]')) as tag, COUNT(*) as cnt \
             FROM nostr_events e, json_each(e.tags) t \
             WHERE e.kind = 1 \
             AND json_extract(t.value, '$[0]') = 't' \
             AND e.created_at > ?1 \
             AND json_extract(t.value, '$[1]') IS NOT NULL \
             AND LENGTH(json_extract(t.value, '$[1]')) > 0 \
             GROUP BY tag \
             ORDER BY cnt DESC \
             LIMIT ?2"
        )?;
        let rows = stmt.query_map(rusqlite::params![week_ago, limit as i64], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .filter_map(|r| r.ok())
        .collect();
        Ok(rows)
    }

    /// Search events by keyword in content and/or by author pubkey.
    /// Returns feed-worthy kinds (1, 6, 30023) ordered by created_at DESC.
    pub fn search_events(
        &self,
        keyword: Option<&str>,
        author: Option<&str>,
        limit: u32,
    ) -> Result<Vec<(String, String, i64, i64, String, String, String)>> {
        let conn = self.conn.lock();

        let mut sql = String::from(
            "SELECT id, pubkey, created_at, kind, tags, content, sig FROM nostr_events WHERE kind IN (1, 6, 30023)",
        );
        let mut param_values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        if let Some(q) = keyword {
            let lower_q = q.to_lowercase();
            if lower_q.starts_with('#') && lower_q.len() > 1 {
                // Hashtag search: match in content AND search t-tags in JSON
                let tag_name = &lower_q[1..];
                let idx_content = param_values.len() + 1;
                let idx_tag = param_values.len() + 2;
                sql.push_str(&format!(
                    " AND (LOWER(content) LIKE ?{} OR EXISTS (\
                        SELECT 1 FROM json_each(tags) \
                        WHERE json_extract(value, '$[0]') = 't' \
                        AND LOWER(json_extract(value, '$[1]')) = ?{}\
                    ))",
                    idx_content, idx_tag
                ));
                param_values.push(Box::new(format!("%{}%", lower_q)));
                param_values.push(Box::new(tag_name.to_string()));
            } else {
                // General keyword search in content and tags
                let idx = param_values.len() + 1;
                sql.push_str(&format!(" AND (LOWER(content) LIKE ?{0} OR LOWER(tags) LIKE ?{0})", idx));
                param_values.push(Box::new(format!("%{}%", lower_q)));
            }
        }

        if let Some(author_pk) = author {
            let idx = param_values.len() + 1;
            sql.push_str(&format!(" AND pubkey = ?{}", idx));
            param_values.push(Box::new(author_pk.to_string()));
        }

        // Exclude muted users and muted events
        sql.push_str(" AND pubkey NOT IN (SELECT pubkey FROM muted_users)");
        sql.push_str(" AND id NOT IN (SELECT event_id FROM muted_events)");

        sql.push_str(" ORDER BY created_at DESC");

        {
            let idx = param_values.len() + 1;
            sql.push_str(&format!(" LIMIT ?{}", idx));
            param_values.push(Box::new(limit as i64));
        }

        debug!("[db] search_events: keyword={:?}, author={:?}, limit={}", keyword, author, limit);

        let params_refs: Vec<&dyn rusqlite::ToSql> =
            param_values.iter().map(|p| p.as_ref()).collect();

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params_refs.as_slice(), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(rows)
    }

    /// Get event count
    pub fn event_count(&self) -> Result<u64> {
        let conn = self.conn.lock();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM nostr_events", [], |row| row.get(0))?;
        debug!("[db] event_count: {}", count);
        Ok(count as u64)
    }

    /// Count events for a specific pubkey.
    pub fn count_events_for_pubkey(&self, pubkey: &str) -> Result<u64> {
        let conn = self.conn.lock();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM nostr_events WHERE pubkey = ?1",
            [pubkey],
            |row| row.get(0),
        )?;
        debug!("[db] count_events_for_pubkey({}…): {}", &pubkey[..pubkey.len().min(8)], count);
        Ok(count as u64)
    }

    /// Check if a pubkey has kind 0 (metadata) event stored.
    pub fn has_profile_metadata(&self, pubkey: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM nostr_events WHERE pubkey = ?1 AND kind = 0",
            [pubkey],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    /// Count events of a specific kind.
    pub fn count_events_by_kind(&self, kind: u32) -> Result<u64> {
        let conn = self.conn.lock();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM nostr_events WHERE kind = ?1",
            [kind],
            |row| row.get(0),
        )?;
        debug!("[db] count_events_by_kind({}): {}", kind, count);
        Ok(count as u64)
    }

    /// NIP-45: Count events matching filters (same signature as query_events but returns count).
    pub fn count_events(
        &self,
        ids: Option<&[String]>,
        authors: Option<&[String]>,
        kinds: Option<&[u32]>,
        since: Option<u64>,
        until: Option<u64>,
    ) -> Result<u64> {
        let conn = self.conn.lock();
        let mut sql = String::from("SELECT COUNT(*) FROM nostr_events WHERE 1=1");
        let mut param_values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        if let Some(ids) = ids {
            if !ids.is_empty() {
                let placeholders: Vec<String> = ids.iter().enumerate().map(|(i, _)| format!("?{}", param_values.len() + i + 1)).collect();
                sql.push_str(&format!(" AND id IN ({})", placeholders.join(",")));
                for id in ids {
                    param_values.push(Box::new(id.clone()));
                }
            }
        }
        if let Some(authors) = authors {
            if !authors.is_empty() {
                let placeholders: Vec<String> = (0..authors.len()).map(|i| format!("?{}", param_values.len() + i + 1)).collect();
                sql.push_str(&format!(" AND pubkey IN ({})", placeholders.join(",")));
                for a in authors {
                    param_values.push(Box::new(a.clone()));
                }
            }
        }
        if let Some(kinds) = kinds {
            if !kinds.is_empty() {
                let placeholders: Vec<String> = (0..kinds.len()).map(|i| format!("?{}", param_values.len() + i + 1)).collect();
                sql.push_str(&format!(" AND kind IN ({})", placeholders.join(",")));
                for k in kinds {
                    param_values.push(Box::new(*k as i64));
                }
            }
        }
        if let Some(since) = since {
            let idx = param_values.len() + 1;
            sql.push_str(&format!(" AND created_at >= ?{}", idx));
            param_values.push(Box::new(since as i64));
        }
        if let Some(until) = until {
            let idx = param_values.len() + 1;
            sql.push_str(&format!(" AND created_at <= ?{}", idx));
            param_values.push(Box::new(until as i64));
        }

        let params_refs: Vec<&dyn rusqlite::ToSql> = param_values.iter().map(|p| p.as_ref()).collect();
        let count: i64 = conn.prepare(&sql)?.query_row(params_refs.as_slice(), |row| row.get(0))?;
        Ok(count as u64)
    }

    /// NIP-09: Delete events by IDs, only if they belong to the given pubkey.
    pub fn delete_events_by_ids_and_pubkey(&self, ids: &[&str], pubkey: &str) -> Result<usize> {
        let conn = self.conn.lock();
        let mut deleted = 0;
        for id in ids {
            deleted += conn.execute(
                "DELETE FROM nostr_events WHERE id = ?1 AND pubkey = ?2",
                params![id, pubkey],
            )?;
        }
        debug!("[db] delete_events: {} deleted for pubkey={}…", deleted, &pubkey[..pubkey.len().min(8)]);
        Ok(deleted)
    }

    /// NIP-16: Store a replaceable event (kinds 0, 3, 10000-19999).
    /// Replaces older event with same pubkey+kind.
    pub fn store_replaceable_event(
        &self,
        id: &str,
        pubkey: &str,
        created_at: i64,
        kind: u32,
        tags_json: &str,
        content: &str,
        sig: &str,
    ) -> Result<bool> {
        let conn = self.conn.lock();
        let existing: Option<i64> = conn.query_row(
            "SELECT created_at FROM nostr_events WHERE pubkey = ?1 AND kind = ?2",
            params![pubkey, kind as i64],
            |row| row.get(0),
        ).ok();

        if let Some(existing_ts) = existing {
            if created_at <= existing_ts {
                return Ok(false);
            }
            conn.execute(
                "DELETE FROM nostr_events WHERE pubkey = ?1 AND kind = ?2",
                params![pubkey, kind as i64],
            )?;
        }

        let now = chrono::Utc::now().timestamp();
        let result = conn.execute(
            "INSERT OR IGNORE INTO nostr_events (id, pubkey, created_at, kind, tags, content, sig, stored_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, pubkey, created_at, kind as i64, tags_json, content, sig, now],
        )?;
        Ok(result > 0)
    }

    /// NIP-33: Store a parameterized replaceable event (kinds 30000-39999).
    /// Replaces older event with same pubkey+kind+d-tag.
    pub fn store_parameterized_replaceable_event(
        &self,
        id: &str,
        pubkey: &str,
        created_at: i64,
        kind: u32,
        tags_json: &str,
        content: &str,
        sig: &str,
        d_tag: &str,
    ) -> Result<bool> {
        let conn = self.conn.lock();
        // Find existing events with same pubkey+kind, then check d-tag in memory
        let mut stmt = conn.prepare(
            "SELECT id, created_at, tags FROM nostr_events WHERE pubkey = ?1 AND kind = ?2",
        )?;
        let rows: Vec<(String, i64, String)> = stmt
            .query_map(params![pubkey, kind as i64], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?
            .filter_map(|r| r.ok())
            .collect();

        for (existing_id, existing_ts, existing_tags) in rows {
            let parsed_tags: Vec<Vec<String>> = serde_json::from_str(&existing_tags).unwrap_or_default();
            let existing_d = parsed_tags.iter()
                .find(|t| t.len() >= 2 && t[0] == "d")
                .map(|t| t[1].as_str())
                .unwrap_or("");
            if existing_d == d_tag {
                if created_at <= existing_ts {
                    return Ok(false);
                }
                conn.execute("DELETE FROM nostr_events WHERE id = ?1", params![existing_id])?;
                break;
            }
        }

        let now = chrono::Utc::now().timestamp();
        let result = conn.execute(
            "INSERT OR IGNORE INTO nostr_events (id, pubkey, created_at, kind, tags, content, sig, stored_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, pubkey, created_at, kind as i64, tags_json, content, sig, now],
        )?;
        Ok(result > 0)
    }

    /// NIP-40: Delete expired events.
    pub fn delete_expired_events(&self) -> Result<usize> {
        let conn = self.conn.lock();
        let now = chrono::Utc::now().timestamp();
        // Events with an expiration tag where the value is a past timestamp.
        // Tags are stored as JSON arrays, so we look for ["expiration", "<timestamp>"].
        let mut stmt = conn.prepare(
            "SELECT id, tags FROM nostr_events",
        )?;
        let rows: Vec<(String, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .filter_map(|r| r.ok())
            .collect();

        let mut deleted = 0;
        for (id, tags_json) in rows {
            let tags: Vec<Vec<String>> = serde_json::from_str(&tags_json).unwrap_or_default();
            if let Some(exp_tag) = tags.iter().find(|t| t.len() >= 2 && t[0] == "expiration") {
                if let Ok(exp_ts) = exp_tag[1].parse::<i64>() {
                    if exp_ts <= now {
                        deleted += conn.execute("DELETE FROM nostr_events WHERE id = ?1", params![id])?;
                    }
                }
            }
        }
        if deleted > 0 {
            debug!("[db] delete_expired_events: {} deleted", deleted);
        }
        Ok(deleted)
    }

    /// Get database file size in bytes
    pub fn db_size_bytes(&self) -> Result<u64> {
        let conn = self.conn.lock();
        let page_count: i64 = conn.query_row("PRAGMA page_count", [], |row| row.get(0))?;
        let page_size: i64 = conn.query_row("PRAGMA page_size", [], |row| row.get(0))?;
        let size = (page_count * page_size) as u64;
        debug!("[db] db_size: {} bytes", size);
        Ok(size)
    }

    /// Get oldest and newest event timestamps
    pub fn event_time_range(&self) -> Result<(u64, u64)> {
        let conn = self.conn.lock();
        let oldest: i64 = conn
            .query_row("SELECT COALESCE(MIN(created_at), 0) FROM nostr_events", [], |row| row.get(0))?;
        let newest: i64 = conn
            .query_row("SELECT COALESCE(MAX(created_at), 0) FROM nostr_events", [], |row| row.get(0))?;
        Ok((oldest as u64, newest as u64))
    }

    /// Get hourly event counts for the last N hours (for activity chart).
    /// Returns a Vec of length `hours`, index 0 = oldest hour, last = most recent.
    pub fn get_hourly_counts(&self, hours: u32) -> Result<Vec<u64>> {
        let conn = self.conn.lock();
        let now = chrono::Utc::now().timestamp();
        let start = now - (hours as i64 * 3600);

        let mut counts = vec![0u64; hours as usize];

        let mut stmt = conn.prepare(
            "SELECT (stored_at - ?1) / 3600 AS bucket, COUNT(*) \
             FROM nostr_events \
             WHERE stored_at >= ?1 \
             GROUP BY bucket \
             ORDER BY bucket",
        )?;

        let rows = stmt.query_map(params![start], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
        })?;

        for row in rows {
            if let Ok((bucket, count)) = row {
                let idx = bucket as usize;
                if idx < counts.len() {
                    counts[idx] = count as u64;
                }
            }
        }

        Ok(counts)
    }

    /// Get event counts grouped by kind
    pub fn get_kind_counts(&self) -> Result<HashMap<u32, u64>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT kind, COUNT(*) FROM nostr_events GROUP BY kind ORDER BY COUNT(*) DESC",
        )?;

        let mut map = HashMap::new();
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
        })?;

        for row in rows {
            if let Ok((kind, count)) = row {
                map.insert(kind as u32, count as u64);
            }
        }

        Ok(map)
    }

    /// Get profile info (kind:0 metadata) for given pubkeys.
    /// Parses the JSON content of the most recent kind:0 event per pubkey.
    /// Resolves profile picture URLs to local cached paths when available.
    pub fn get_profiles(&self, pubkeys: &[String]) -> Result<Vec<ProfileInfo>> {
        if pubkeys.is_empty() {
            return Ok(vec![]);
        }

        let mut profiles = Vec::new();

        {
            let conn = self.conn.lock();

            // Process in chunks to avoid SQLite variable limits
            for chunk in pubkeys.chunks(500) {
                let placeholders: Vec<String> = (0..chunk.len())
                    .map(|i| format!("?{}", i + 1))
                    .collect();
                let sql = format!(
                    "SELECT pubkey, content FROM nostr_events \
                     WHERE kind = 0 AND pubkey IN ({}) \
                     ORDER BY created_at DESC",
                    placeholders.join(",")
                );

                let mut stmt = conn.prepare(&sql)?;
                let params_vec: Vec<&dyn rusqlite::ToSql> =
                    chunk.iter().map(|s| s as &dyn rusqlite::ToSql).collect();

                let rows = stmt.query_map(params_vec.as_slice(), |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?;

                let mut seen = std::collections::HashSet::new();
                for row in rows {
                    if let Ok((pubkey, content)) = row {
                        // Only take the first (most recent) per pubkey
                        if !seen.insert(pubkey.clone()) {
                            continue;
                        }
                        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                            profiles.push(ProfileInfo {
                                pubkey,
                                name: parsed.get("name").and_then(|v| v.as_str()).map(String::from),
                                display_name: parsed.get("display_name").and_then(|v| v.as_str()).map(String::from),
                                picture: parsed.get("picture").and_then(|v| v.as_str()).map(String::from),
                                picture_local: None,
                                nip05: parsed.get("nip05").and_then(|v| v.as_str()).map(String::from),
                                about: parsed.get("about").and_then(|v| v.as_str()).map(String::from),
                                banner: parsed.get("banner").and_then(|v| v.as_str()).map(String::from),
                                website: parsed.get("website").and_then(|v| v.as_str()).map(String::from),
                                lud16: parsed.get("lud16").and_then(|v| v.as_str()).map(String::from),
                            });
                        }
                    }
                }
            }
        } // conn lock dropped here

        // Resolve local media paths for profile pictures
        let picture_urls: Vec<String> = profiles.iter()
            .filter_map(|p| p.picture.clone())
            .collect();

        if !picture_urls.is_empty() {
            if let Ok(cache_map) = self.media_cache_lookup_by_urls(&picture_urls) {
                for profile in &mut profiles {
                    if let Some(ref pic_url) = profile.picture {
                        if let Some((hash, _mime, _size, _dl)) = cache_map.get(pic_url) {
                            let local_path = crate::paths::media_file_path(&self.data_dir, hash)
                                .to_string_lossy()
                                .to_string();
                            if std::path::Path::new(&local_path).exists() {
                                profile.picture_local = Some(local_path);
                            }
                        }
                    }
                }
            }
        }

        debug!("[db] get_profiles: requested={}, found={}", pubkeys.len(), profiles.len());
        Ok(profiles)
    }

    /// Search profiles by name, display_name, or nip05 in kind-0 metadata events.
    pub fn search_profiles(&self, query: &str, limit: u32) -> Result<Vec<ProfileInfo>> {
        let pattern = format!("%{}%", query.to_lowercase());
        let mut profiles = Vec::new();

        {
            let conn = self.conn.lock();
            let sql = "SELECT pubkey, content FROM nostr_events \
                        WHERE kind = 0 \
                        AND ( \
                          LOWER(json_extract(content, '$.name')) LIKE ?1 \
                          OR LOWER(json_extract(content, '$.display_name')) LIKE ?1 \
                          OR LOWER(json_extract(content, '$.nip05')) LIKE ?1 \
                        ) \
                        ORDER BY created_at DESC \
                        LIMIT ?2";

            let mut stmt = conn.prepare(sql)?;
            let rows = stmt.query_map(rusqlite::params![pattern, limit], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;

            let mut seen = std::collections::HashSet::new();
            for row in rows {
                if let Ok((pubkey, content)) = row {
                    if !seen.insert(pubkey.clone()) {
                        continue;
                    }
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                        profiles.push(ProfileInfo {
                            pubkey,
                            name: parsed.get("name").and_then(|v| v.as_str()).map(String::from),
                            display_name: parsed.get("display_name").and_then(|v| v.as_str()).map(String::from),
                            picture: parsed.get("picture").and_then(|v| v.as_str()).map(String::from),
                            picture_local: None,
                            nip05: parsed.get("nip05").and_then(|v| v.as_str()).map(String::from),
                            about: parsed.get("about").and_then(|v| v.as_str()).map(String::from),
                            banner: parsed.get("banner").and_then(|v| v.as_str()).map(String::from),
                            website: parsed.get("website").and_then(|v| v.as_str()).map(String::from),
                            lud16: parsed.get("lud16").and_then(|v| v.as_str()).map(String::from),
                        });
                    }
                }
            }
        }

        // Resolve local media paths for profile pictures
        let picture_urls: Vec<String> = profiles.iter()
            .filter_map(|p| p.picture.clone())
            .collect();

        if !picture_urls.is_empty() {
            if let Ok(cache_map) = self.media_cache_lookup_by_urls(&picture_urls) {
                for profile in &mut profiles {
                    if let Some(ref pic_url) = profile.picture {
                        if let Some((hash, _mime, _size, _dl)) = cache_map.get(pic_url) {
                            let local_path = crate::paths::media_file_path(&self.data_dir, hash)
                                .to_string_lossy()
                                .to_string();
                            if std::path::Path::new(&local_path).exists() {
                                profile.picture_local = Some(local_path);
                            }
                        }
                    }
                }
            }
        }

        debug!("[db] search_profiles: query={:?}, found={}", query, profiles.len());
        Ok(profiles)
    }

    /// Get the last time a profile was fetched from relays.
    pub fn get_profile_fetched_at(&self, pubkey: &str) -> Result<Option<i64>> {
        let conn = self.conn.lock();
        let result = conn.query_row(
            "SELECT fetched_at FROM profile_cache WHERE pubkey = ?1",
            [pubkey],
            |row| row.get(0),
        );
        match result {
            Ok(ts) => Ok(Some(ts)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Record that a profile was fetched from relays now.
    pub fn set_profile_fetched_at(&self, pubkey: &str, fetched_at: i64) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO profile_cache (pubkey, fetched_at) VALUES (?1, ?2)
             ON CONFLICT(pubkey) DO UPDATE SET fetched_at = ?2",
            rusqlite::params![pubkey, fetched_at],
        )?;
        Ok(())
    }

    /// Count DM events stored locally since a given timestamp (uses stored_at, not created_at).
    /// Detects new DMs from ANY source (sync engine, relay WebSocket, fetch_new_dms).
    pub fn count_new_dms_since(&self, own_pubkey: &str, since_stored_at: i64) -> Result<i64> {
        let conn = self.conn.lock();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM nostr_events \
             WHERE kind IN (4, 1059) AND stored_at > ?1 \
             AND (pubkey = ?2 OR tags LIKE '%' || ?2 || '%')",
            params![since_stored_at, own_pubkey],
            |row| row.get(0),
        )?;
        Ok(count)
    }

    /// Get DM events (kind:4 NIP-04 + kind:1059 NIP-17 gift wrap) involving a specific pubkey.
    /// Returns (id, pubkey, created_at, kind, tags_json, content, sig).
    pub fn get_dm_events(
        &self,
        own_pubkey: &str,
        limit: u32,
    ) -> Result<Vec<(String, String, i64, i64, String, String, String)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, pubkey, created_at, kind, tags, content, sig \
             FROM nostr_events \
             WHERE kind IN (4, 1059) AND (pubkey = ?1 OR tags LIKE '%' || ?1 || '%') \
             ORDER BY created_at DESC \
             LIMIT ?2",
        )?;

        let rows = stmt
            .query_map(params![own_pubkey, limit as i64], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(rows)
    }

    /// Clear all data from the database (reset to fresh state)
    pub fn clear_all(&self) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute_batch(
            r#"
            DELETE FROM edges;
            DELETE FROM nodes;
            DELETE FROM nostr_events;
            DELETE FROM sync_state;
            DELETE FROM app_config;
        "#,
        )?;
        info!("Database cleared — all data deleted");
        Ok(())
    }

    // ── Tracked Profiles ──────────────────────────────────────────

    /// Track a profile — its events are never pruned.
    pub fn track_profile(&self, pubkey: &str, note: Option<&str>) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO tracked_profiles (pubkey, tracked_at, note) VALUES (?1, strftime('%s','now'), ?2)",
            params![pubkey, note],
        )?;
        info!("[db] track_profile: {}", &pubkey[..std::cmp::min(12, pubkey.len())]);
        Ok(())
    }

    /// Untrack a profile.
    pub fn untrack_profile(&self, pubkey: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM tracked_profiles WHERE pubkey = ?1", params![pubkey])?;
        info!("[db] untrack_profile: {}", &pubkey[..std::cmp::min(12, pubkey.len())]);
        Ok(())
    }

    /// Check if a profile is tracked.
    pub fn is_tracked(&self, pubkey: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM tracked_profiles WHERE pubkey = ?1",
            params![pubkey],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    /// Get all tracked profiles: (pubkey, tracked_at, note).
    pub fn get_tracked_profiles(&self) -> Result<Vec<(String, i64, Option<String>)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT pubkey, tracked_at, note FROM tracked_profiles ORDER BY tracked_at DESC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// Get just the tracked pubkeys (for pruning exclusion).
    pub fn get_tracked_pubkeys(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT pubkey FROM tracked_profiles")?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// Normalize any npub entries in tracked_profiles to hex format.
    /// Should be called once at startup.
    pub fn normalize_tracked_profiles(&self) -> Result<u32> {
        use nostr_sdk::prelude::*;
        let profiles = self.get_tracked_profiles()?;
        let mut fixed = 0u32;
        let conn = self.conn.lock();
        for (pubkey, _tracked_at, note) in &profiles {
            if pubkey.starts_with("npub") {
                if let Ok(pk) = PublicKey::from_bech32(pubkey) {
                    let hex = pk.to_hex();
                    conn.execute("DELETE FROM tracked_profiles WHERE pubkey = ?1", params![pubkey])?;
                    conn.execute(
                        "INSERT OR REPLACE INTO tracked_profiles (pubkey, tracked_at, note) VALUES (?1, strftime('%s','now'), ?2)",
                        params![hex, note],
                    )?;
                    info!("[db] normalized tracked profile npub→hex: {}...", &hex[..hex.len().min(12)]);
                    fixed += 1;
                } else {
                    warn!("[db] invalid npub in tracked_profiles: {}...", &pubkey[..pubkey.len().min(16)]);
                }
            }
        }
        Ok(fixed)
    }

    /// Prune events older than max_age_secs, excluding own events and tracked profiles.
    pub fn prune_old_events(&self, own_pubkey: &str, max_age_secs: u64) -> Result<u64> {
        let conn = self.conn.lock();
        let cutoff = chrono::Utc::now().timestamp() as i64 - max_age_secs as i64;
        let deleted = conn.execute(
            "DELETE FROM nostr_events WHERE created_at < ?1 AND pubkey != ?2 AND pubkey NOT IN (SELECT pubkey FROM tracked_profiles)",
            params![cutoff, own_pubkey],
        )?;
        Ok(deleted as u64)
    }

    // ── Media Cache Methods ────────────────────────────────────────

    /// Batch lookup media_cache records by URL.
    /// Returns a map: url → (hash, mime_type, size_bytes, downloaded_at).
    pub fn media_cache_lookup_by_urls(&self, urls: &[String]) -> Result<HashMap<String, (String, String, u64, i64)>> {
        if urls.is_empty() {
            return Ok(HashMap::new());
        }
        let conn = self.conn.lock();
        let mut map = HashMap::new();

        // Process in batches of 200 to stay within SQLite parameter limits
        for chunk in urls.chunks(200) {
            let placeholders: Vec<String> = (0..chunk.len()).map(|i| format!("?{}", i + 1)).collect();
            let sql = format!(
                "SELECT url, hash, mime_type, size_bytes, downloaded_at FROM media_cache WHERE url IN ({})",
                placeholders.join(",")
            );
            let params_refs: Vec<&dyn rusqlite::ToSql> = chunk.iter().map(|u| u as &dyn rusqlite::ToSql).collect();
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params_refs.as_slice(), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)? as u64,
                    row.get::<_, i64>(4)?,
                ))
            })?;
            for row in rows.flatten() {
                map.insert(row.0, (row.1, row.2, row.3, row.4));
            }
        }
        Ok(map)
    }

    /// Check if a media blob is already cached
    pub fn media_exists(&self, hash: &str) -> bool {
        let conn = self.conn.lock();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM media_cache WHERE hash = ?1",
                params![hash],
                |row| row.get(0),
            )
            .unwrap_or(0);
        count > 0
    }

    /// Reassign a media record's pubkey if the new pubkey has higher ownership priority.
    /// Priority: own_pubkey > tracked > everything else.
    pub fn media_reassign_if_higher_priority(
        &self,
        hash: &str,
        new_pubkey: &str,
        own_pubkey: &str,
        tracked_pubkeys: &std::collections::HashSet<String>,
    ) -> Result<bool> {
        let conn = self.conn.lock();
        let existing_pubkey: String = conn.query_row(
            "SELECT pubkey FROM media_cache WHERE hash = ?1",
            params![hash],
            |row| row.get(0),
        )?;

        if existing_pubkey == new_pubkey {
            return Ok(false);
        }

        let priority = |pk: &str| -> u8 {
            if pk == own_pubkey { 2 }
            else if tracked_pubkeys.contains(pk) { 1 }
            else { 0 }
        };

        if priority(new_pubkey) > priority(&existing_pubkey) {
            conn.execute(
                "UPDATE media_cache SET pubkey = ?1 WHERE hash = ?2",
                params![new_pubkey, hash],
            )?;
            debug!(
                "[db] media_reassign: {}… {} → {} (priority {} > {})",
                &hash[..hash.len().min(12)],
                &existing_pubkey[..existing_pubkey.len().min(8)],
                &new_pubkey[..new_pubkey.len().min(8)],
                priority(new_pubkey),
                priority(&existing_pubkey),
            );
            return Ok(true);
        }

        Ok(false)
    }

    /// Record a downloaded media item (file already written to disk)
    pub fn store_media_record(
        &self,
        hash: &str,
        url: &str,
        mime_type: &str,
        size_bytes: u64,
        pubkey: &str,
    ) -> Result<()> {
        let conn = self.conn.lock();
        let now = chrono::Utc::now().timestamp();
        conn.execute(
            "INSERT OR REPLACE INTO media_cache (hash, url, mime_type, size_bytes, pubkey, downloaded_at, last_accessed) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![hash, url, mime_type, size_bytes as i64, pubkey, now, now],
        )?;
        debug!("[db] store_media_record: hash={}… size={}", &hash[..std::cmp::min(12, hash.len())], size_bytes);
        Ok(())
    }

    /// Delete media_cache records by hash (used during eviction).
    pub fn media_delete_records(&self, hashes: &[String]) -> Result<()> {
        if hashes.is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock();
        for hash in hashes {
            conn.execute(
                "DELETE FROM media_cache WHERE hash = ?1",
                params![hash],
            )?;
        }
        Ok(())
    }

    /// Number of cached media files
    pub fn media_file_count(&self) -> Result<u64> {
        let conn = self.conn.lock();
        let count: i64 =
            conn.query_row("SELECT COUNT(*) FROM media_cache", [], |row| row.get(0))?;
        Ok(count as u64)
    }

    /// Total bytes used by cached media
    pub fn media_total_bytes(&self) -> Result<u64> {
        let conn = self.conn.lock();
        let total: i64 = conn.query_row(
            "SELECT COALESCE(SUM(size_bytes), 0) FROM media_cache",
            [],
            |row| row.get(0),
        )?;
        Ok(total as u64)
    }

    /// List media ordered by last_accessed ASC (oldest first = evict first), limited to `limit` rows
    /// Returns Vec<(hash, size_bytes)>
    pub fn media_list_lru(&self, limit: usize) -> Result<Vec<(String, u64)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT hash, size_bytes FROM media_cache ORDER BY last_accessed ASC LIMIT ?1",
        )?;
        let rows = stmt
            .query_map(params![limit as i64], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64))
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// List media ordered by last_accessed ASC, EXCLUDING items from a specific pubkey (never evict own media)
    pub fn media_list_lru_excluding_pubkey(&self, limit: usize, exclude_pubkey: &str) -> Result<Vec<(String, u64)>> {
        let conn = self.conn.lock();
        let one_hour_ago = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64 - 3600;
        let mut stmt = conn.prepare(
            "SELECT hash, size_bytes FROM media_cache WHERE pubkey != ?1 AND pubkey NOT IN (SELECT pubkey FROM tracked_profiles) AND downloaded_at < ?3 ORDER BY last_accessed ASC LIMIT ?2"
        )?;
        let rows = stmt
            .query_map(params![exclude_pubkey, limit as i64, one_hour_ago], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64))
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// Total bytes used by evictable media (excluding own pubkey and tracked profiles)
    pub fn media_others_bytes(&self, exclude_pubkey: &str) -> Result<u64> {
        let conn = self.conn.lock();
        let total: i64 = conn.query_row(
            "SELECT COALESCE(SUM(size_bytes), 0) FROM media_cache WHERE pubkey != ?1 AND pubkey NOT IN (SELECT pubkey FROM tracked_profiles)",
            params![exclude_pubkey],
            |row| row.get(0),
        )?;
        Ok(total as u64)
    }

    /// Total bytes used by tracked profiles' media (excluding own pubkey)
    pub fn media_tracked_bytes(&self, exclude_pubkey: &str) -> Result<u64> {
        let conn = self.conn.lock();
        let total: i64 = conn.query_row(
            "SELECT COALESCE(SUM(size_bytes), 0) FROM media_cache WHERE pubkey != ?1 AND pubkey IN (SELECT pubkey FROM tracked_profiles)",
            params![exclude_pubkey],
            |row| row.get(0),
        )?;
        Ok(total as u64)
    }

    /// List tracked-profile media ordered by last_accessed ASC (oldest first), excluding own pubkey
    pub fn media_list_lru_tracked(&self, limit: usize, exclude_pubkey: &str) -> Result<Vec<(String, u64)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT hash, size_bytes FROM media_cache WHERE pubkey != ?1 AND pubkey IN (SELECT pubkey FROM tracked_profiles) ORDER BY last_accessed ASC LIMIT ?2"
        )?;
        let rows = stmt
            .query_map(params![exclude_pubkey, limit as i64], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64))
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// Delete oldest events from others (NOT from own pubkey) — used for storage enforcement
    pub fn delete_oldest_others_events(&self, own_pubkey: &str, count: u32) -> Result<u64> {
        let conn = self.conn.lock();
        let deleted: usize = conn.execute(
            "DELETE FROM nostr_events WHERE id IN (
                SELECT id FROM nostr_events
                WHERE pubkey != ?1
                ORDER BY created_at ASC
                LIMIT ?2
            )",
            params![own_pubkey, count as i64],
        )?;
        Ok(deleted as u64)
    }

    /// Get the Tier 2 sync cursor (wall-clock timestamp of last successful sync).
    /// Stored in app_config under key "tier2_since".
    pub fn get_sync_cursor(&self) -> Result<Option<u64>> {
        match self.get_config("tier2_since")? {
            Some(val) => Ok(val.parse::<u64>().ok()),
            None => Ok(None),
        }
    }

    /// Set the Tier 2 sync cursor to a wall-clock timestamp.
    pub fn set_sync_cursor(&self, ts: u64) -> Result<()> {
        self.set_config("tier2_since", &ts.to_string())
    }

    /// Get the Tier 2 historical backfill cursor (walks backward in time).
    /// Stored in app_config under key "tier2_history_until".
    pub fn get_history_cursor(&self) -> Result<Option<u64>> {
        match self.get_config("tier2_history_until")? {
            Some(val) => Ok(val.parse::<u64>().ok()),
            None => Ok(None),
        }
    }

    /// Set the Tier 2 historical backfill cursor.
    pub fn set_history_cursor(&self, ts: u64) -> Result<()> {
        self.set_config("tier2_history_until", &ts.to_string())
    }

    /// Get the articles (kind 30023) historical backfill cursor.
    /// Separate from the main history cursor so articles can backfill independently
    /// without being crowded out by high-volume kinds (notes, reposts).
    pub fn get_articles_history_cursor(&self) -> Result<Option<u64>> {
        match self.get_config("tier2_history_until_articles")? {
            Some(val) => Ok(val.parse::<u64>().ok()),
            None => Ok(None),
        }
    }

    /// Set the articles historical backfill cursor.
    pub fn set_articles_history_cursor(&self, ts: u64) -> Result<()> {
        self.set_config("tier2_history_until_articles", &ts.to_string())
    }

    /// Get the latest created_at timestamp from stored nostr events.
    pub fn get_latest_event_timestamp(&self) -> Result<Option<u64>> {
        let conn = self.conn.lock();
        let result: i64 = conn.query_row(
            "SELECT COALESCE(MAX(created_at), 0) FROM nostr_events",
            [],
            |row| row.get(0),
        )?;
        if result == 0 {
            Ok(None)
        } else {
            Ok(Some(result as u64))
        }
    }

    // ── Media deleted tracking ──────────────────────────────────

    /// Record URLs as user-deleted so they don't reappear in the gallery.
    pub fn media_mark_deleted(&self, urls: &[String]) -> Result<()> {
        if urls.is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock();
        for url in urls {
            conn.execute(
                "INSERT OR IGNORE INTO media_deleted (url) VALUES (?1)",
                params![url],
            )?;
        }
        Ok(())
    }

    /// Return the set of deleted URLs from a list of candidates.
    pub fn media_get_deleted(&self, urls: &[String]) -> Result<std::collections::HashSet<String>> {
        if urls.is_empty() {
            return Ok(std::collections::HashSet::new());
        }
        let conn = self.conn.lock();
        let mut deleted = std::collections::HashSet::new();
        for chunk in urls.chunks(200) {
            let placeholders: Vec<String> = (0..chunk.len()).map(|i| format!("?{}", i + 1)).collect();
            let sql = format!(
                "SELECT url FROM media_deleted WHERE url IN ({})",
                placeholders.join(",")
            );
            let params_refs: Vec<&dyn rusqlite::ToSql> = chunk.iter().map(|u| u as &dyn rusqlite::ToSql).collect();
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params_refs.as_slice(), |row| row.get::<_, String>(0))?;
            for row in rows {
                if let Ok(url) = row {
                    deleted.insert(url);
                }
            }
        }
        Ok(deleted)
    }

    // ── Media queue ─────────────────────────────────────────────

    /// Queue a media URL for later download. Higher priority upgrades existing entries.
    /// Also updates the pubkey if the new pubkey is a tracked profile (higher ownership priority).
    pub fn queue_media_url(&self, url: &str, pubkey: &str, priority: i32) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO media_queue (url, pubkey, priority) VALUES (?1, ?2, ?3)
             ON CONFLICT(url) DO UPDATE SET
               priority = MAX(priority, excluded.priority),
               pubkey = CASE
                 WHEN excluded.pubkey IN (SELECT pubkey FROM tracked_profiles) THEN excluded.pubkey
                 ELSE media_queue.pubkey
               END",
            params![url, pubkey, priority],
        )?;
        Ok(())
    }

    /// Dequeue up to `limit` media URLs (FIFO by queued_at). Deletes them from the queue.
    pub fn dequeue_media_urls(&self, limit: usize) -> Result<Vec<(String, String)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT url, pubkey FROM media_queue ORDER BY priority DESC, queued_at ASC LIMIT ?1",
        )?;
        let rows: Vec<(String, String)> = stmt
            .query_map(params![limit as i64], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .filter_map(|r| r.ok())
            .collect();

        if !rows.is_empty() {
            let placeholders: Vec<String> = rows.iter().enumerate().map(|(i, _)| format!("?{}", i + 1)).collect();
            let sql = format!("DELETE FROM media_queue WHERE url IN ({})", placeholders.join(","));
            let param_refs: Vec<&dyn rusqlite::ToSql> = rows.iter().map(|(u, _)| u as &dyn rusqlite::ToSql).collect();
            conn.execute(&sql, param_refs.as_slice())?;
        }

        Ok(rows)
    }

    /// Dequeue up to `limit` media URLs for a specific pubkey. Deletes them from the queue.
    pub fn dequeue_media_urls_for_pubkey(&self, pubkey: &str, limit: usize) -> Result<Vec<(String, String)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT url, pubkey FROM media_queue WHERE pubkey = ?1 ORDER BY priority DESC, queued_at ASC LIMIT ?2",
        )?;
        let rows: Vec<(String, String)> = stmt
            .query_map(params![pubkey, limit as i64], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .filter_map(|r| r.ok())
            .collect();

        if !rows.is_empty() {
            let placeholders: Vec<String> = rows.iter().enumerate().map(|(i, _)| format!("?{}", i + 1)).collect();
            let sql = format!("DELETE FROM media_queue WHERE url IN ({})", placeholders.join(","));
            let param_refs: Vec<&dyn rusqlite::ToSql> = rows.iter().map(|(u, _)| u as &dyn rusqlite::ToSql).collect();
            conn.execute(&sql, param_refs.as_slice())?;
        }

        Ok(rows)
    }

    /// Count pending media queue items for a specific pubkey.
    pub fn media_queue_count_for_pubkey(&self, pubkey: &str) -> Result<u64> {
        let conn = self.conn.lock();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM media_queue WHERE pubkey = ?1",
            params![pubkey],
            |row| row.get(0),
        )?;
        Ok(count as u64)
    }

    /// Get all own media records for the media explorer.
    /// Returns (hash, url, mime_type, size_bytes, downloaded_at) sorted by downloaded_at DESC.
    pub fn get_own_media(&self, own_pubkey: &str) -> Result<Vec<(String, String, String, u64, i64)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT hash, url, mime_type, size_bytes, downloaded_at FROM media_cache \
             WHERE pubkey = ?1 ORDER BY downloaded_at DESC"
        )?;
        let rows = stmt
            .query_map(params![own_pubkey], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)? as u64,
                    row.get::<_, i64>(4)?,
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// Get cached media for any pubkey (profile media explorer).
    /// Returns (hash, url, mime_type, size_bytes, downloaded_at) sorted by downloaded_at DESC.
    pub fn get_profile_media(&self, pubkey: &str) -> Result<Vec<(String, String, String, u64, i64)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT hash, url, mime_type, size_bytes, downloaded_at FROM media_cache \
             WHERE pubkey = ?1 ORDER BY downloaded_at DESC"
        )?;
        let rows = stmt
            .query_map(params![pubkey], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)? as u64,
                    row.get::<_, i64>(4)?,
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// Get media for a storage category ("own", "tracked", "wot").
    /// Returns (hash, url, mime_type, size_bytes, downloaded_at) sorted by downloaded_at DESC.
    pub fn get_media_for_category(&self, own_pubkey: &str, category: &str) -> Result<Vec<(String, String, String, u64, i64)>> {
        let conn = self.conn.lock();
        let sql = match category {
            "own" => "SELECT hash, url, mime_type, size_bytes, downloaded_at FROM media_cache WHERE pubkey = ?1 ORDER BY downloaded_at DESC",
            "tracked" => "SELECT hash, url, mime_type, size_bytes, downloaded_at FROM media_cache WHERE pubkey != ?1 AND pubkey IN (SELECT pubkey FROM tracked_profiles) ORDER BY downloaded_at DESC",
            _ => "SELECT hash, url, mime_type, size_bytes, downloaded_at FROM media_cache WHERE pubkey != ?1 AND pubkey NOT IN (SELECT pubkey FROM tracked_profiles) ORDER BY downloaded_at DESC",
        };
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt
            .query_map(params![own_pubkey], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)? as u64,
                    row.get::<_, i64>(4)?,
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// Re-queue media URLs from a pubkey's events into the media_queue for download.
    /// Scans events for media URLs and inserts them into the queue if not already cached.
    pub fn requeue_events_media(&self, pubkey: &str) -> Result<u32> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT tags FROM nostr_events WHERE pubkey = ?1 AND kind IN (1, 6, 30023)"
        )?;
        let tag_rows: Vec<String> = stmt
            .query_map(params![pubkey], |row| row.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect();

        let mut queued = 0u32;
        for tags_json in &tag_rows {
            let urls = crate::sync::media::extract_urls_from_tags(tags_json);
            for url in urls {
                // Skip if already cached or deleted
                let cached: bool = conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM media_cache WHERE url = ?1)",
                    params![url],
                    |row| row.get(0),
                ).unwrap_or(false);
                let deleted: bool = conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM media_deleted WHERE url = ?1)",
                    params![url],
                    |row| row.get(0),
                ).unwrap_or(false);
                if !cached && !deleted {
                    conn.execute(
                        "INSERT OR IGNORE INTO media_queue (url, pubkey, priority) VALUES (?1, ?2, 0)",
                        params![url, pubkey],
                    ).ok();
                    queued += 1;
                }
            }
        }
        Ok(queued)
    }

    /// Count own media files.
    pub fn own_media_count(&self, own_pubkey: &str) -> Result<u64> {
        let conn = self.conn.lock();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM media_cache WHERE pubkey = ?1",
            params![own_pubkey],
            |row| row.get(0),
        )?;
        Ok(count as u64)
    }

    /// Count pending items in media queue.
    pub fn media_queue_count(&self) -> Result<u64> {
        let conn = self.conn.lock();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM media_queue", [], |row| row.get(0))?;
        Ok(count as u64)
    }

    // ── Ownership-based storage stats ─────────────────────────────

    /// Count events authored by own pubkey.
    pub fn own_event_count(&self, own_pubkey: &str) -> Result<u64> {
        let conn = self.conn.lock();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM nostr_events WHERE pubkey = ?1",
            params![own_pubkey],
            |row| row.get(0),
        )?;
        Ok(count as u64)
    }

    /// Count events from tracked profiles (excluding own pubkey).
    pub fn tracked_event_count(&self, own_pubkey: &str) -> Result<u64> {
        let conn = self.conn.lock();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM nostr_events WHERE pubkey != ?1 AND pubkey IN (SELECT pubkey FROM tracked_profiles)",
            params![own_pubkey],
            |row| row.get(0),
        )?;
        Ok(count as u64)
    }

    /// Count events from WoT profiles (not own, not tracked — everything else).
    pub fn wot_event_count(&self, own_pubkey: &str) -> Result<u64> {
        let conn = self.conn.lock();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM nostr_events WHERE pubkey != ?1 AND pubkey NOT IN (SELECT pubkey FROM tracked_profiles)",
            params![own_pubkey],
            |row| row.get(0),
        )?;
        Ok(count as u64)
    }

    /// Returns (own_events, tracked_events, wot_events, total_events, db_size_bytes).
    pub fn get_ownership_stats_batch(&self, own_pubkey: &str) -> Result<(u64, u64, u64, u64, u64)> {
        let conn = self.conn.lock();

        // Event counts in a single query
        let (own_events, tracked_events, wot_events, total_events): (i64, i64, i64, i64) = conn.query_row(
            "SELECT
                SUM(CASE WHEN pubkey = ?1 THEN 1 ELSE 0 END),
                SUM(CASE WHEN pubkey != ?1 AND pubkey IN (SELECT pubkey FROM tracked_profiles) THEN 1 ELSE 0 END),
                SUM(CASE WHEN pubkey != ?1 AND pubkey NOT IN (SELECT pubkey FROM tracked_profiles) THEN 1 ELSE 0 END),
                COUNT(*)
            FROM nostr_events",
            params![own_pubkey],
            |row| Ok((
                row.get::<_, Option<i64>>(0)?.unwrap_or(0),
                row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                row.get::<_, i64>(3)?,
            )),
        )?;

        // DB size
        let db_size: i64 = conn.query_row(
            "SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()",
            [],
            |row| row.get(0),
        )?;

        Ok((
            own_events as u64,
            tracked_events as u64,
            wot_events as u64,
            total_events as u64,
            db_size as u64,
        ))
    }

    /// Get the number of events stored in the last 24 hours (for growth estimation).
    pub fn events_last_24h(&self) -> Result<u64> {
        let conn = self.conn.lock();
        let cutoff = chrono::Utc::now().timestamp() - 86400;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM nostr_events WHERE stored_at > ?1",
            params![cutoff],
            |row| row.get(0),
        )?;
        Ok(count as u64)
    }

    /// Kind counts for a specific pubkey.
    pub fn kind_counts_for_pubkey(&self, pubkey: &str) -> Result<HashMap<u32, u64>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT kind, COUNT(*) FROM nostr_events WHERE pubkey = ?1 GROUP BY kind ORDER BY COUNT(*) DESC"
        )?;
        let mut map = HashMap::new();
        let rows = stmt.query_map(params![pubkey], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
        })?;
        for row in rows {
            if let Ok((kind, count)) = row {
                map.insert(kind as u32, count as u64);
            }
        }
        Ok(map)
    }

    /// Kind counts for all tracked profiles (excluding own pubkey).
    pub fn kind_counts_for_tracked(&self, own_pubkey: &str) -> Result<HashMap<u32, u64>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT kind, COUNT(*) FROM nostr_events WHERE pubkey != ?1 AND pubkey IN (SELECT pubkey FROM tracked_profiles) GROUP BY kind ORDER BY COUNT(*) DESC"
        )?;
        let mut map = HashMap::new();
        let rows = stmt.query_map(params![own_pubkey], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
        })?;
        for row in rows {
            if let Ok((kind, count)) = row {
                map.insert(kind as u32, count as u64);
            }
        }
        Ok(map)
    }

    /// Kind counts for WoT profiles (excluding own pubkey and tracked profiles).
    pub fn kind_counts_for_wot(&self, own_pubkey: &str) -> Result<HashMap<u32, u64>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT kind, COUNT(*) FROM nostr_events WHERE pubkey != ?1 AND pubkey NOT IN (SELECT pubkey FROM tracked_profiles) GROUP BY kind ORDER BY COUNT(*) DESC"
        )?;
        let mut map = HashMap::new();
        let rows = stmt.query_map(params![own_pubkey], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
        })?;
        for row in rows {
            if let Ok((kind, count)) = row {
                map.insert(kind as u32, count as u64);
            }
        }
        Ok(map)
    }

    /// Query events by ownership category (own/tracked/wot) with optional kind filter and pagination.
    pub fn query_events_for_category(
        &self,
        own_pubkey: &str,
        category: &str,
        kinds: Option<&[u32]>,
        until: Option<u64>,
        limit: u32,
    ) -> Result<Vec<(String, String, i64, i64, String, String, String)>> {
        let conn = self.conn.lock();

        let cat_filter = match category {
            "own" => "pubkey = ?1",
            "tracked" => "pubkey != ?1 AND pubkey IN (SELECT pubkey FROM tracked_profiles)",
            "wot" => "pubkey != ?1 AND pubkey NOT IN (SELECT pubkey FROM tracked_profiles)",
            _ => return Err(anyhow::anyhow!("Invalid category")),
        };

        let mut sql = format!(
            "SELECT id, pubkey, created_at, kind, tags, content, sig FROM nostr_events WHERE {}",
            cat_filter
        );
        let mut param_values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        param_values.push(Box::new(own_pubkey.to_string()));

        if let Some(kinds) = kinds {
            if !kinds.is_empty() {
                let placeholders: Vec<String> = (0..kinds.len())
                    .map(|i| format!("?{}", param_values.len() + i + 1))
                    .collect();
                sql.push_str(&format!(" AND kind IN ({})", placeholders.join(",")));
                for k in kinds {
                    param_values.push(Box::new(*k as i64));
                }
            }
        }

        if let Some(until) = until {
            let idx = param_values.len() + 1;
            sql.push_str(&format!(" AND created_at < ?{}", idx));
            param_values.push(Box::new(until as i64));
        }

        // Exclude muted users and muted events
        sql.push_str(" AND pubkey NOT IN (SELECT pubkey FROM muted_users)");
        sql.push_str(" AND id NOT IN (SELECT event_id FROM muted_events)");

        sql.push_str(" ORDER BY created_at DESC");
        {
            let idx = param_values.len() + 1;
            sql.push_str(&format!(" LIMIT ?{}", idx));
            param_values.push(Box::new(limit as i64));
        }

        let params_refs: Vec<&dyn rusqlite::ToSql> =
            param_values.iter().map(|p| p.as_ref()).collect();

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params_refs.as_slice(), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(rows)
    }

    // ── V2: User Relays ──────────────────────────────────────────

    /// Upsert a user relay, respecting source priority (higher source wins).
    pub fn upsert_user_relay(
        &self,
        pubkey: &str,
        relay_url: &str,
        direction: &str,
        source: &str,
        source_ts: i64,
    ) -> Result<bool> {
        let conn = self.conn.lock();
        // Only replace if new source has equal or higher priority
        let source_priority = |s: &str| -> i32 {
            match s {
                "nip65" => 2,
                "nip05" => 1,
                "kind3_hint" => 0,
                _ => -1,
            }
        };

        // Check existing
        let existing: Option<(String, i64)> = conn
            .query_row(
                "SELECT source, source_ts FROM user_relays WHERE pubkey = ?1 AND relay_url = ?2",
                params![pubkey, relay_url],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();

        if let Some((existing_source, existing_ts)) = existing {
            if source_priority(source) < source_priority(&existing_source) {
                return Ok(false); // Lower priority source, skip
            }
            if source == existing_source && source_ts <= existing_ts {
                return Ok(false); // Same source, not newer
            }
        }

        conn.execute(
            "INSERT INTO user_relays (pubkey, relay_url, direction, source, source_ts)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(pubkey, relay_url) DO UPDATE SET
                direction = ?3, source = ?4, source_ts = ?5",
            params![pubkey, relay_url, direction, source, source_ts],
        )?;
        Ok(true)
    }

    /// Get write relays for a pubkey (for outbox routing).
    pub fn get_write_relays(&self, pubkey: &str) -> Result<Vec<(String, String)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT relay_url, source FROM user_relays
             WHERE pubkey = ?1 AND direction IN ('write', 'both')
             ORDER BY CASE source WHEN 'nip65' THEN 0 WHEN 'nip05' THEN 1 ELSE 2 END",
        )?;
        let rows = stmt
            .query_map(params![pubkey], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// Get read relays for a pubkey.
    pub fn get_read_relays(&self, pubkey: &str) -> Result<Vec<(String, String)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT relay_url, source FROM user_relays
             WHERE pubkey = ?1 AND direction IN ('read', 'both')
             ORDER BY CASE source WHEN 'nip65' THEN 0 WHEN 'nip05' THEN 1 ELSE 2 END",
        )?;
        let rows = stmt
            .query_map(params![pubkey], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// Get deduplicated write relay URLs for multiple pubkeys, sorted by frequency, capped.
    pub fn get_write_relays_for_pubkeys(&self, pubkeys: &[String], cap: usize) -> Result<Vec<String>> {
        let conn = self.conn.lock();
        if pubkeys.is_empty() {
            return Ok(Vec::new());
        }

        // Build query with placeholders for each pubkey
        let placeholders: Vec<String> = (1..=pubkeys.len()).map(|i| format!("?{}", i)).collect();
        let sql = format!(
            "SELECT relay_url, COUNT(*) as freq FROM user_relays
             WHERE pubkey IN ({}) AND direction IN ('write', 'both')
             GROUP BY relay_url
             ORDER BY freq DESC
             LIMIT ?{}",
            placeholders.join(","),
            pubkeys.len() + 1
        );

        let mut stmt = conn.prepare(&sql)?;
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = pubkeys
            .iter()
            .map(|pk| Box::new(pk.clone()) as Box<dyn rusqlite::ToSql>)
            .collect();
        params.push(Box::new(cap as i64));

        let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let rows: Vec<String> = stmt
            .query_map(param_refs.as_slice(), |row| row.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(rows)
    }

    /// Replace all relays for a pubkey from a given source (e.g. when processing a new kind:10002).
    pub fn replace_user_relays(
        &self,
        pubkey: &str,
        source: &str,
        source_ts: i64,
        relays: &[(String, String)], // (relay_url, direction)
    ) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "DELETE FROM user_relays WHERE pubkey = ?1 AND source = ?2",
            params![pubkey, source],
        )?;
        let mut stmt = conn.prepare(
            "INSERT OR REPLACE INTO user_relays (pubkey, relay_url, direction, source, source_ts)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        for (relay_url, direction) in relays {
            stmt.execute(params![pubkey, relay_url, direction, source, source_ts])?;
        }
        Ok(())
    }

    // ── V2: User Cursors ─────────────────────────────────────────

    /// Get the cursor for a pubkey.
    pub fn get_user_cursor(&self, pubkey: &str) -> Result<Option<(i64, i64)>> {
        let conn = self.conn.lock();
        let result = conn.query_row(
            "SELECT last_event_ts, last_fetched_at FROM user_cursors WHERE pubkey = ?1",
            params![pubkey],
            |row| Ok((row.get(0)?, row.get(1)?)),
        );
        match result {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Advance cursor — only moves forward, never backward.
    pub fn advance_user_cursor(&self, pubkey: &str, event_ts: i64) -> Result<()> {
        let conn = self.conn.lock();
        let now = chrono::Utc::now().timestamp();
        conn.execute(
            "INSERT INTO user_cursors (pubkey, last_event_ts, last_fetched_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(pubkey) DO UPDATE SET
                last_event_ts = MAX(last_event_ts, ?2),
                last_fetched_at = ?3",
            params![pubkey, event_ts, now],
        )?;
        Ok(())
    }

    /// Get all cursors for batch processing (e.g. cursor banding).
    pub fn get_all_cursors(&self) -> Result<Vec<(String, i64, i64)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT pubkey, last_event_ts, last_fetched_at FROM user_cursors",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// Touch the cursor for a pubkey — updates `last_fetched_at` without requiring
    /// a new event. Creates a cursor row if none exists (with `last_event_ts = 0`).
    /// This ensures subsequent syncs can use `last_fetched_at` as a `since` bound
    /// even when no new events were found.
    pub fn touch_user_cursor(&self, pubkey: &str) -> Result<()> {
        let conn = self.conn.lock();
        let now = chrono::Utc::now().timestamp();
        conn.execute(
            "INSERT INTO user_cursors (pubkey, last_event_ts, last_fetched_at)
             VALUES (?1, 0, ?2)
             ON CONFLICT(pubkey) DO UPDATE SET
                last_fetched_at = ?2",
            params![pubkey, now],
        )?;
        Ok(())
    }

    /// Clear all user cursors (used on account change).
    pub fn clear_user_cursors(&self) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM user_cursors", [])?;
        Ok(())
    }

    // ── V2: Relay Stats ──────────────────────────────────────────

    /// Record a successful relay interaction.
    pub fn record_relay_success(&self, relay_url: &str, events_received: u32, latency_ms: u32) -> Result<()> {
        let conn = self.conn.lock();
        let now = chrono::Utc::now().timestamp();
        conn.execute(
            "INSERT INTO relay_stats (relay_url, success_count, total_events, avg_latency_ms, last_success)
             VALUES (?1, 1, ?2, ?3, ?4)
             ON CONFLICT(relay_url) DO UPDATE SET
                success_count = success_count + 1,
                total_events = total_events + ?2,
                avg_latency_ms = (avg_latency_ms + ?3) / 2,
                last_success = ?4",
            params![relay_url, events_received as i64, latency_ms as i64, now],
        )?;
        Ok(())
    }

    /// Record a relay failure.
    pub fn record_relay_failure(&self, relay_url: &str) -> Result<()> {
        let conn = self.conn.lock();
        let now = chrono::Utc::now().timestamp();
        conn.execute(
            "INSERT INTO relay_stats (relay_url, failure_count, last_failure)
             VALUES (?1, 1, ?2)
             ON CONFLICT(relay_url) DO UPDATE SET
                failure_count = failure_count + 1,
                last_failure = ?2",
            params![relay_url, now],
        )?;
        Ok(())
    }

    /// Record a relay rate limit.
    pub fn record_relay_rate_limit(&self, relay_url: &str) -> Result<()> {
        let conn = self.conn.lock();
        let now = chrono::Utc::now().timestamp();
        conn.execute(
            "INSERT INTO relay_stats (relay_url, last_rate_limited)
             VALUES (?1, ?2)
             ON CONFLICT(relay_url) DO UPDATE SET
                last_rate_limited = ?2",
            params![relay_url, now],
        )?;
        Ok(())
    }

    /// Compute reliability score for a relay.
    pub fn get_relay_reliability(&self, relay_url: &str) -> Result<f64> {
        let conn = self.conn.lock();
        let result = conn.query_row(
            "SELECT success_count, failure_count, avg_latency_ms, last_rate_limited
             FROM relay_stats WHERE relay_url = ?1",
            params![relay_url],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                ))
            },
        );

        match result {
            Ok((success, failure, latency, last_rl)) => {
                let base = success as f64 / (success as f64 + failure as f64 + 1.0);
                let rl_penalty = if let Some(rl_ts) = last_rl {
                    let hours = (chrono::Utc::now().timestamp() - rl_ts) as f64 / 3600.0;
                    1.0 - (0.0_f64.max(1.0 - hours / 24.0) * 0.3)
                } else {
                    1.0
                };
                let latency_factor = 1.0 / (1.0 + latency as f64 / 1000.0);
                Ok(base * rl_penalty * latency_factor)
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(0.5), // Unknown relay gets neutral score
            Err(e) => Err(e.into()),
        }
    }

    // ── V2: Deletion Tombstones ──────────────────────────────────

    /// Check if an event has been deleted.
    pub fn is_tombstoned(&self, event_id: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM deletion_tombstones WHERE event_id = ?1",
            params![event_id],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    /// Create a deletion tombstone (and delete the actual event if it exists).
    pub fn create_tombstone(
        &self,
        event_id: &str,
        deleted_by: &str,
        deletion_event_id: &str,
        deleted_at: i64,
    ) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR IGNORE INTO deletion_tombstones (event_id, deleted_by, deletion_event_id, deleted_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![event_id, deleted_by, deletion_event_id, deleted_at],
        )?;
        // Also delete the event itself from storage
        conn.execute("DELETE FROM nostr_events WHERE id = ?1", params![event_id])?;
        Ok(())
    }

    // ── V2: Retention Config ─────────────────────────────────────

    /// Get retention config for a tier.
    pub fn get_retention_config(&self, tier: &str) -> Result<Option<(u32, u64)>> {
        let conn = self.conn.lock();
        let result = conn.query_row(
            "SELECT min_events, time_window_secs FROM retention_config WHERE tier = ?1",
            params![tier],
            |row| Ok((row.get::<_, i64>(0)? as u32, row.get::<_, i64>(1)? as u64)),
        );
        match result {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Update retention config for a tier.
    pub fn set_retention_config(&self, tier: &str, min_events: u32, time_window_secs: u64) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO retention_config (tier, min_events, time_window_secs)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(tier) DO UPDATE SET min_events = ?2, time_window_secs = ?3",
            params![tier, min_events as i64, time_window_secs as i64],
        )?;
        Ok(())
    }

    // ── V2: Mute Tables ──────────────────────────────────────────

    /// Rebuild all mute tables from a kind:10000 event's tags.
    pub fn rebuild_mute_lists(&self, tags_json: &str) -> Result<()> {
        let conn = self.conn.lock();
        let now = chrono::Utc::now().timestamp();

        // Clear existing mute data
        conn.execute_batch(
            "DELETE FROM muted_users; DELETE FROM muted_events;
             DELETE FROM muted_words; DELETE FROM muted_hashtags;",
        )?;

        let tags: Vec<Vec<String>> = serde_json::from_str(tags_json).unwrap_or_default();

        for tag in &tags {
            if tag.len() < 2 {
                continue;
            }
            match tag[0].as_str() {
                "p" => {
                    conn.execute(
                        "INSERT OR IGNORE INTO muted_users (pubkey, muted_at) VALUES (?1, ?2)",
                        params![&tag[1], now],
                    )?;
                }
                "e" => {
                    conn.execute(
                        "INSERT OR IGNORE INTO muted_events (event_id, muted_at) VALUES (?1, ?2)",
                        params![&tag[1], now],
                    )?;
                }
                "word" => {
                    conn.execute(
                        "INSERT OR IGNORE INTO muted_words (word, muted_at) VALUES (?1, ?2)",
                        params![tag[1].to_lowercase(), now],
                    )?;
                }
                "t" => {
                    let hashtag = tag[1].trim_start_matches('#').to_lowercase();
                    conn.execute(
                        "INSERT OR IGNORE INTO muted_hashtags (hashtag, muted_at) VALUES (?1, ?2)",
                        params![hashtag, now],
                    )?;
                }
                _ => {}
            }
        }

        Ok(())
    }

    /// Mute a single pubkey.
    pub fn mute_pubkey(&self, pubkey: &str) -> Result<()> {
        let conn = self.conn.lock();
        let now = chrono::Utc::now().timestamp();
        conn.execute(
            "INSERT OR IGNORE INTO muted_users (pubkey, muted_at) VALUES (?1, ?2)",
            params![pubkey, now],
        )?;
        info!("[db] mute_pubkey: {}", &pubkey[..std::cmp::min(12, pubkey.len())]);
        Ok(())
    }

    /// Unmute a single pubkey.
    pub fn unmute_pubkey(&self, pubkey: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM muted_users WHERE pubkey = ?1", params![pubkey])?;
        info!("[db] unmute_pubkey: {}", &pubkey[..std::cmp::min(12, pubkey.len())]);
        Ok(())
    }

    /// Check if a pubkey is muted.
    pub fn is_pubkey_muted(&self, pubkey: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM muted_users WHERE pubkey = ?1",
            params![pubkey],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    /// Check if an event is muted.
    pub fn is_event_muted(&self, event_id: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM muted_events WHERE event_id = ?1",
            params![event_id],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    /// Get all muted words (for content filtering).
    pub fn get_muted_words(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT word FROM muted_words")?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// Get all muted pubkeys.
    pub fn get_muted_pubkeys(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT pubkey FROM muted_users")?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// Get all muted hashtags (for content filtering).
    pub fn get_muted_hashtags(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT hashtag FROM muted_hashtags")?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    // ── V2: Relay Info ───────────────────────────────────────────

    /// Store or update NIP-11 relay info.
    pub fn upsert_relay_info(
        &self,
        relay_url: &str,
        name: Option<&str>,
        description: Option<&str>,
        supported_nips: Option<&str>,
        software: Option<&str>,
        version: Option<&str>,
        payment_required: bool,
        auth_required: bool,
    ) -> Result<()> {
        let conn = self.conn.lock();
        let now = chrono::Utc::now().timestamp();
        conn.execute(
            "INSERT INTO relay_info (relay_url, name, description, supported_nips, software, version,
             limitation_payment_required, limitation_auth_required, fetched_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(relay_url) DO UPDATE SET
                name = ?2, description = ?3, supported_nips = ?4, software = ?5, version = ?6,
                limitation_payment_required = ?7, limitation_auth_required = ?8, fetched_at = ?9",
            params![
                relay_url, name, description, supported_nips, software, version,
                payment_required as i64, auth_required as i64, now
            ],
        )?;
        Ok(())
    }

    /// Check if a relay requires payment.
    pub fn relay_requires_payment(&self, relay_url: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let result = conn.query_row(
            "SELECT limitation_payment_required FROM relay_info WHERE relay_url = ?1",
            params![relay_url],
            |row| row.get::<_, i64>(0),
        );
        match result {
            Ok(v) => Ok(v != 0),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
            Err(e) => Err(e.into()),
        }
    }

    // ── V2: Thread Refs ───────────────────────────────────────────

    /// Insert thread references for an event (e-tag references).
    pub fn insert_thread_refs(&self, referencing_id: &str, referenced_ids: &[String]) -> Result<()> {
        if referenced_ids.is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "INSERT OR IGNORE INTO thread_refs (referenced_id, referencing_id) VALUES (?1, ?2)",
        )?;
        for ref_id in referenced_ids {
            stmt.execute(params![ref_id, referencing_id])?;
        }
        Ok(())
    }

    /// Delete thread_refs where this event is the referencing side (called when event is pruned).
    pub fn delete_thread_refs_by_referencing(&self, referencing_id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "DELETE FROM thread_refs WHERE referencing_id = ?1",
            params![referencing_id],
        )?;
        Ok(())
    }

    // ── V2: Tiered Pruning ───────────────────────────────────────

    /// Delete events for a specific pubkey older than cutoff, keeping at least min_events.
    /// Never deletes replaceable metadata (kinds 0, 3, 10000, 10002).
    pub fn prune_pubkey_events(
        &self,
        pubkey: &str,
        cutoff_ts: i64,
        min_events: u32,
    ) -> Result<u64> {
        let conn = self.conn.lock();

        // Count non-metadata events for this pubkey
        let total: i64 = conn.query_row(
            "SELECT COUNT(*) FROM nostr_events WHERE pubkey = ?1 AND kind NOT IN (0, 3, 10000, 10002)",
            params![pubkey],
            |row| row.get(0),
        )?;

        if total <= min_events as i64 {
            return Ok(0); // Already at or below minimum
        }

        // First collect IDs that will be deleted (for thread_refs cleanup)
        let ids_to_delete: Vec<String> = {
            let mut stmt = conn.prepare(
                "SELECT id FROM nostr_events WHERE pubkey = ?1
                 AND kind NOT IN (0, 3, 10000, 10002)
                 AND created_at < ?2
                 AND id NOT IN (
                    SELECT id FROM nostr_events
                    WHERE pubkey = ?1 AND kind NOT IN (0, 3, 10000, 10002)
                    ORDER BY created_at DESC LIMIT ?3
                 )
                 AND id NOT IN (SELECT referenced_id FROM thread_refs)",
            )?;
            let rows = stmt.query_map(params![pubkey, cutoff_ts, min_events as i64], |row| {
                row.get::<_, String>(0)
            })?
            .filter_map(|r| r.ok())
            .collect();
            rows
        };

        if ids_to_delete.is_empty() {
            return Ok(0);
        }

        // Delete events
        for chunk in ids_to_delete.chunks(500) {
            let placeholders: Vec<String> = (0..chunk.len()).map(|i| format!("?{}", i + 1)).collect();
            let sql = format!("DELETE FROM nostr_events WHERE id IN ({})", placeholders.join(","));
            let params_vec: Vec<&dyn rusqlite::ToSql> = chunk.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
            conn.execute(&sql, params_vec.as_slice())?;
        }

        // Clean up thread_refs for deleted events (as referencing side)
        for chunk in ids_to_delete.chunks(500) {
            let placeholders: Vec<String> = (0..chunk.len()).map(|i| format!("?{}", i + 1)).collect();
            let sql = format!("DELETE FROM thread_refs WHERE referencing_id IN ({})", placeholders.join(","));
            let params_vec: Vec<&dyn rusqlite::ToSql> = chunk.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
            conn.execute(&sql, params_vec.as_slice())?;
        }

        Ok(ids_to_delete.len() as u64)
    }

    // ── Bookmarked Media Methods ──────────────────────────────────

    pub fn bookmark_media(
        &self,
        event_id: &str,
        media_url: &str,
        event_json: &str,
        profile_json: &str,
    ) -> Result<bool> {
        let conn = self.conn.lock();
        let changed = conn.execute(
            "INSERT OR IGNORE INTO bookmarked_media (event_id, media_url, event_json, profile_json)
             VALUES (?1, ?2, ?3, ?4)",
            params![event_id, media_url, event_json, profile_json],
        )?;
        Ok(changed > 0)
    }

    pub fn unbookmark_media(&self, event_id: &str, media_url: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let changed = conn.execute(
            "DELETE FROM bookmarked_media WHERE event_id = ?1 AND media_url = ?2",
            params![event_id, media_url],
        )?;
        Ok(changed > 0)
    }

    pub fn is_media_bookmarked(&self, event_id: &str, media_url: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM bookmarked_media WHERE event_id = ?1 AND media_url = ?2",
            params![event_id, media_url],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    pub fn get_bookmarked_media(&self) -> Result<Vec<(String, String, String, String, i64)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT event_id, media_url, event_json, profile_json, bookmarked_at
             FROM bookmarked_media ORDER BY bookmarked_at DESC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// Find an event whose content contains the given media URL.
    pub fn find_event_by_media_url(&self, media_url: &str, pubkey: Option<&str>) -> Result<Option<(String, String, i64, i64, String, String, String)>> {
        let conn = self.conn.lock();
        let row = if let Some(pk) = pubkey {
            conn.query_row(
                "SELECT id, pubkey, created_at, kind, tags, content, sig FROM nostr_events
                 WHERE pubkey = ?1 AND content LIKE '%' || ?2 || '%' LIMIT 1",
                params![pk, media_url],
                |row| Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                )),
            )
        } else {
            conn.query_row(
                "SELECT id, pubkey, created_at, kind, tags, content, sig FROM nostr_events
                 WHERE content LIKE '%' || ?1 || '%' LIMIT 1",
                params![media_url],
                |row| Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                )),
            )
        };
        match row {
            Ok(r) => Ok(Some(r)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    // ── User Threads ────────────────────────────────────────────

    /// Upsert a user thread participation record.
    pub fn upsert_user_thread(&self, root_id: &str, participation: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO user_threads (root_event_id, participation, updated_at)
             VALUES (?1, ?2, strftime('%s','now'))
             ON CONFLICT(root_event_id) DO UPDATE SET
                participation = CASE
                    WHEN excluded.participation = 'author' THEN 'author'
                    WHEN user_threads.participation = 'author' THEN 'author'
                    ELSE excluded.participation
                END,
                updated_at = strftime('%s','now')",
            params![root_id, participation],
        )?;
        Ok(())
    }

    /// Get user thread roots ordered by updated_at, oldest first (for rotation).
    pub fn get_user_thread_roots(&self, limit: u32, max_age_secs: u64) -> Result<Vec<(String, String)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT root_event_id, participation FROM user_threads
             WHERE updated_at >= (strftime('%s','now') - ?2)
             ORDER BY updated_at ASC LIMIT ?1"
        )?;
        let rows = stmt.query_map(params![limit, max_age_secs], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?.filter_map(|r| r.ok()).collect();
        Ok(rows)
    }

    // ── Interaction Counts ──────────────────────────────────────

    /// Get interaction counts (replies, reposts, reactions, zaps) for a batch of event IDs.
    /// Uses json_each to scan tags for e-tag references.
    pub fn get_interaction_counts(&self, event_ids: &[String]) -> Result<HashMap<String, (u32, u32, u32, u32)>> {
        if event_ids.is_empty() {
            return Ok(HashMap::new());
        }

        let conn = self.conn.lock();

        // Build parameterized query
        let placeholders: Vec<String> = (1..=event_ids.len()).map(|i| format!("?{}", i)).collect();
        let sql = format!(
            "SELECT json_extract(j.value, '$[1]') as ref_id, e.kind, COUNT(*) as cnt
             FROM nostr_events e, json_each(e.tags) j
             WHERE json_extract(j.value, '$[0]') = 'e'
               AND json_extract(j.value, '$[1]') IN ({})
               AND e.kind IN (1, 6, 7, 9735)
             GROUP BY ref_id, e.kind",
            placeholders.join(",")
        );

        let mut stmt = conn.prepare(&sql)?;
        let params: Vec<&dyn rusqlite::ToSql> = event_ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();

        let mut result: HashMap<String, (u32, u32, u32, u32)> = HashMap::new();

        let rows = stmt.query_map(params.as_slice(), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, u32>(2)?,
            ))
        })?;

        for row in rows.flatten() {
            let (ref_id, kind, count) = row;
            let entry = result.entry(ref_id).or_insert((0, 0, 0, 0));
            match kind {
                1 => entry.0 += count,     // replies
                6 => entry.1 += count,     // reposts
                7 => entry.2 += count,     // reactions
                9735 => entry.3 += count,  // zaps
                _ => {}
            }
        }

        Ok(result)
    }

    /// Given a list of target event IDs and the user's pubkey, return those IDs
    /// that the user has already reacted to (kind 7 with an e-tag referencing the target).
    pub fn get_reacted_event_ids(&self, event_ids: &[String], user_pubkey: &str) -> Result<Vec<String>> {
        if event_ids.is_empty() {
            return Ok(Vec::new());
        }

        let conn = self.conn.lock();

        let placeholders: Vec<String> = (1..=event_ids.len()).map(|i| format!("?{}", i)).collect();
        let pk_idx = event_ids.len() + 1;
        let sql = format!(
            "SELECT DISTINCT json_extract(j.value, '$[1]') as ref_id
             FROM nostr_events e, json_each(e.tags) j
             WHERE e.kind = 7
               AND e.pubkey = ?{}
               AND json_extract(j.value, '$[0]') = 'e'
               AND json_extract(j.value, '$[1]') IN ({})",
            pk_idx,
            placeholders.join(",")
        );

        let mut stmt = conn.prepare(&sql)?;
        let mut params: Vec<&dyn rusqlite::ToSql> = event_ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
        let user_pk = user_pubkey.to_string();
        params.push(&user_pk);

        let rows = stmt.query_map(params.as_slice(), |row| {
            row.get::<_, String>(0)
        })?;

        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Find the user's kind 7 reaction event ID for a given target event.
    pub fn find_reaction_event_id(&self, target_event_id: &str, user_pubkey: &str) -> Result<Option<String>> {
        let conn = self.conn.lock();
        let result = conn.query_row(
            "SELECT e.id
             FROM nostr_events e, json_each(e.tags) j
             WHERE e.kind = 7
               AND e.pubkey = ?1
               AND json_extract(j.value, '$[0]') = 'e'
               AND json_extract(j.value, '$[1]') = ?2
             LIMIT 1",
            rusqlite::params![user_pubkey, target_event_id],
            |row| row.get::<_, String>(0),
        );
        match result {
            Ok(id) => Ok(Some(id)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Given a list of target event IDs and the user's pubkey, return those IDs
    /// that the user has already reposted (kind 6 with an e-tag referencing the target).
    pub fn get_reposted_event_ids(&self, event_ids: &[String], user_pubkey: &str) -> Result<Vec<String>> {
        if event_ids.is_empty() {
            return Ok(Vec::new());
        }

        let conn = self.conn.lock();

        let placeholders: Vec<String> = (1..=event_ids.len()).map(|i| format!("?{}", i)).collect();
        let pk_idx = event_ids.len() + 1;
        let sql = format!(
            "SELECT DISTINCT json_extract(j.value, '$[1]') as ref_id
             FROM nostr_events e, json_each(e.tags) j
             WHERE e.kind = 6
               AND e.pubkey = ?{}
               AND json_extract(j.value, '$[0]') = 'e'
               AND json_extract(j.value, '$[1]') IN ({})",
            pk_idx,
            placeholders.join(",")
        );

        let mut stmt = conn.prepare(&sql)?;
        let mut params: Vec<&dyn rusqlite::ToSql> = event_ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
        let user_pk = user_pubkey.to_string();
        params.push(&user_pk);

        let rows = stmt.query_map(params.as_slice(), |row| {
            row.get::<_, String>(0)
        })?;

        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    // ── Bookmarked Events (NIP-51 local cache) ─────────────────────

    /// Add an event to bookmarks. Returns true if newly inserted.
    pub fn add_bookmark(&self, event_id: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let rows = conn.execute(
            "INSERT OR IGNORE INTO bookmarked_events (event_id) VALUES (?1)",
            params![event_id],
        )?;
        Ok(rows > 0)
    }

    /// Remove an event from bookmarks. Returns true if it existed.
    pub fn remove_bookmark(&self, event_id: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let rows = conn.execute(
            "DELETE FROM bookmarked_events WHERE event_id = ?1",
            params![event_id],
        )?;
        Ok(rows > 0)
    }

    /// Batched check: given a list of event IDs, return those that are bookmarked.
    pub fn get_bookmarked_event_ids(&self, event_ids: &[String]) -> Result<Vec<String>> {
        if event_ids.is_empty() {
            return Ok(Vec::new());
        }

        let conn = self.conn.lock();
        let placeholders: Vec<String> = (1..=event_ids.len()).map(|i| format!("?{}", i)).collect();
        let sql = format!(
            "SELECT event_id FROM bookmarked_events WHERE event_id IN ({})",
            placeholders.join(",")
        );

        let mut stmt = conn.prepare(&sql)?;
        let params: Vec<&dyn rusqlite::ToSql> = event_ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(params.as_slice(), |row| row.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Get all bookmarked event IDs (for building the kind 10003 event).
    pub fn get_all_bookmark_ids(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT event_id FROM bookmarked_events ORDER BY bookmarked_at DESC"
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Clear all local bookmark data: legacy table + kind 10003/30001 events + migration flag.
    pub fn clear_all_bookmark_data(&self, own_pubkey: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM bookmarked_events", [])?;
        conn.execute(
            "DELETE FROM nostr_events WHERE pubkey = ?1 AND kind IN (10003, 30001)",
            params![own_pubkey],
        )?;
        conn.execute(
            "DELETE FROM app_config WHERE key = 'bookmark_nip44_migrated'",
            [],
        )?;
        Ok(())
    }

    /// Return bookmarked event IDs that do NOT exist in nostr_events (need fetching from relays).
    pub fn get_missing_bookmarked_event_ids(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT b.event_id FROM bookmarked_events b
             LEFT JOIN nostr_events e ON e.id = b.event_id
             WHERE e.id IS NULL"
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Get bookmarked events joined with nostr_events, for the bookmarks feed.
    pub fn get_bookmarked_events(&self, limit: u32, before: Option<i64>) -> Result<Vec<(String, String, i64, i64, String, String, String, i64)>> {
        type Row = (String, String, i64, i64, String, String, String, i64);
        let conn = self.conn.lock();

        let map_row = |row: &rusqlite::Row| -> rusqlite::Result<Row> {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, i64>(7)?,
            ))
        };

        if let Some(b) = before {
            let mut stmt = conn.prepare(
                "SELECT e.id, e.pubkey, e.created_at, e.kind, e.tags, e.content, e.sig, b.bookmarked_at
                 FROM bookmarked_events b
                 INNER JOIN nostr_events e ON e.id = b.event_id
                 WHERE b.bookmarked_at < ?1
                 ORDER BY b.bookmarked_at DESC
                 LIMIT ?2"
            )?;
            let results: Vec<Row> = stmt.query_map(params![b, limit], map_row)?.filter_map(|r| r.ok()).collect();
            Ok(results)
        } else {
            let mut stmt = conn.prepare(
                "SELECT e.id, e.pubkey, e.created_at, e.kind, e.tags, e.content, e.sig, b.bookmarked_at
                 FROM bookmarked_events b
                 INNER JOIN nostr_events e ON e.id = b.event_id
                 ORDER BY b.bookmarked_at DESC
                 LIMIT ?1"
            )?;
            let results: Vec<Row> = stmt.query_map(params![limit], map_row)?.filter_map(|r| r.ok()).collect();
            Ok(results)
        }
    }

    /// Sync bookmarks from a relay-fetched kind 10003 event (additive merge).
    pub fn sync_bookmarks(&self, event_ids: &[String]) -> Result<u32> {
        let conn = self.conn.lock();
        let mut count = 0u32;
        for event_id in event_ids {
            let rows = conn.execute(
                "INSERT OR IGNORE INTO bookmarked_events (event_id) VALUES (?1)",
                params![event_id],
            )?;
            if rows > 0 {
                count += 1;
            }
        }
        Ok(count)
    }

    /// Replace all bookmarks with the given set (full sync from relay).
    /// Clears existing bookmarks and inserts the relay's authoritative list.
    pub fn replace_all_bookmarks(&self, event_ids: &[String]) -> Result<u32> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM bookmarked_events", [])?;
        for event_id in event_ids {
            conn.execute(
                "INSERT OR IGNORE INTO bookmarked_events (event_id) VALUES (?1)",
                params![event_id],
            )?;
        }
        Ok(event_ids.len() as u32)
    }

    /// Get the latest stored kind 10003 event for a given pubkey.
    /// Returns (tags_json, content, created_at) or None.
    pub fn get_latest_bookmark_event(&self, pubkey: &str) -> Result<Option<(String, String, i64)>> {
        let conn = self.conn.lock();
        match conn.query_row(
            "SELECT tags, content, created_at FROM nostr_events WHERE pubkey = ?1 AND kind = 10003 ORDER BY created_at DESC LIMIT 1",
            params![pubkey],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?)),
        ) {
            Ok(row) => Ok(Some(row)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    // ── Bookmark Lists (NIP-51 kind 30003 sets) ─────────────────────

    /// Create a new bookmark list. Returns true if created.
    pub fn create_bookmark_list(&self, id: &str, name: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let rows = conn.execute(
            "INSERT OR IGNORE INTO bookmark_lists (id, name) VALUES (?1, ?2)",
            params![id, name],
        )?;
        Ok(rows > 0)
    }

    /// Delete a bookmark list and its items.
    pub fn delete_bookmark_list(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM bookmark_list_items WHERE list_id = ?1", params![id])?;
        let rows = conn.execute("DELETE FROM bookmark_lists WHERE id = ?1", params![id])?;
        Ok(rows > 0)
    }

    /// Rename a bookmark list.
    pub fn rename_bookmark_list(&self, id: &str, name: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let rows = conn.execute(
            "UPDATE bookmark_lists SET name = ?1 WHERE id = ?2",
            params![name, id],
        )?;
        Ok(rows > 0)
    }

    /// Get all bookmark lists.
    pub fn get_bookmark_lists(&self) -> Result<Vec<(String, String, i64)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, name, created_at FROM bookmark_lists ORDER BY created_at ASC"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?))
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Add an event to a bookmark list.
    pub fn add_to_bookmark_list(&self, list_id: &str, event_id: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let rows = conn.execute(
            "INSERT OR IGNORE INTO bookmark_list_items (list_id, event_id) VALUES (?1, ?2)",
            params![list_id, event_id],
        )?;
        Ok(rows > 0)
    }

    /// Remove an event from a bookmark list.
    pub fn remove_from_bookmark_list(&self, list_id: &str, event_id: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let rows = conn.execute(
            "DELETE FROM bookmark_list_items WHERE list_id = ?1 AND event_id = ?2",
            params![list_id, event_id],
        )?;
        Ok(rows > 0)
    }

    /// Get event IDs in a bookmark list.
    pub fn get_bookmark_list_items(&self, list_id: &str) -> Result<Vec<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT event_id FROM bookmark_list_items WHERE list_id = ?1 ORDER BY added_at DESC"
        )?;
        let rows = stmt.query_map(params![list_id], |row| row.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Get events in a bookmark list (joined with nostr_events).
    pub fn get_bookmark_list_events(&self, list_id: &str, limit: u32) -> Result<Vec<(String, String, i64, i64, String, String, String, i64)>> {
        type Row = (String, String, i64, i64, String, String, String, i64);
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT e.id, e.pubkey, e.created_at, e.kind, e.tags, e.content, e.sig, i.added_at
             FROM bookmark_list_items i
             INNER JOIN nostr_events e ON e.id = i.event_id
             WHERE i.list_id = ?1
             ORDER BY i.added_at DESC
             LIMIT ?2"
        )?;
        let results: Vec<Row> = stmt.query_map(params![list_id, limit], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, i64>(7)?,
            ))
        })?.filter_map(|r| r.ok()).collect();
        Ok(results)
    }

    /// Get all list IDs that contain a given event.
    pub fn get_lists_containing_event(&self, event_id: &str) -> Result<Vec<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT list_id FROM bookmark_list_items WHERE event_id = ?1"
        )?;
        let rows = stmt.query_map(params![event_id], |row| row.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Debug: query raw events by kind and/or pubkey.
    pub fn debug_query_events(&self, kind: Option<u32>, pubkey: &str, limit: u32)
        -> Result<Vec<(String, String, i64, i64, String, String, String)>>
    {
        let conn = self.conn.lock();
        let (sql, params_vec): (String, Vec<Box<dyn rusqlite::types::ToSql>>) = match kind {
            Some(k) => (
                "SELECT id, pubkey, created_at, kind, tags, content, sig FROM nostr_events WHERE pubkey = ?1 AND kind = ?2 ORDER BY created_at DESC LIMIT ?3".to_string(),
                vec![Box::new(pubkey.to_string()), Box::new(k as i64), Box::new(limit as i64)],
            ),
            None => (
                "SELECT id, pubkey, created_at, kind, tags, content, sig FROM nostr_events WHERE pubkey = ?1 ORDER BY created_at DESC LIMIT ?2".to_string(),
                vec![Box::new(pubkey.to_string()), Box::new(limit as i64)],
            ),
        };
        let params_refs: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_refs.as_slice(), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
            ))
        })?.collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Debug: get all app_config key/value pairs.
    pub fn debug_get_all_config(&self) -> Result<Vec<(String, String)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT key, value FROM app_config ORDER BY key")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?.collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Get all thread events for a given root ID (the root itself + all events referencing it).
    pub fn get_thread_events(&self, root_id: &str) -> Result<(
        Option<(String, String, i64, i64, String, String, String)>,
        Vec<(String, String, i64, i64, String, String, String)>,
        Vec<(String, String, i64, i64, String, String, String)>,
        Vec<(String, String, i64, i64, String, String, String)>,
    )> {
        let conn = self.conn.lock();

        // Get the root event
        let root = conn.query_row(
            "SELECT id, pubkey, created_at, kind, tags, content, sig FROM nostr_events WHERE id = ?1",
            params![root_id],
            |row| Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
            )),
        ).ok();

        // Get all events that reference this root via e-tag
        let mut stmt = conn.prepare(
            "SELECT e.id, e.pubkey, e.created_at, e.kind, e.tags, e.content, e.sig
             FROM nostr_events e, json_each(e.tags) j
             WHERE json_extract(j.value, '$[0]') = 'e'
               AND json_extract(j.value, '$[1]') = ?1
             ORDER BY e.created_at ASC"
        )?;

        let all_refs: Vec<(String, String, i64, i64, String, String, String)> = stmt
            .query_map(params![root_id], |row| Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
            )))?
            .filter_map(|r| r.ok())
            .collect();

        let mut replies = Vec::new();
        let mut reactions = Vec::new();
        let mut zaps = Vec::new();

        for row in all_refs {
            match row.3 {
                1 | 30023 => replies.push(row),
                7 => reactions.push(row),
                9735 => zaps.push(row),
                _ => replies.push(row),
            }
        }

        Ok((root, replies, reactions, zaps))
    }

    // ── Enrichment cache ─────────────────────────────────────────────

    /// Return event IDs that have no enrichment_cache entry or whose
    /// last_fetched_at is older than `now - max_age_secs`.
    pub fn get_stale_enrichment_ids(&self, event_ids: &[String], max_age_secs: i64) -> Result<Vec<String>> {
        if event_ids.is_empty() {
            return Ok(Vec::new());
        }

        let conn = self.conn.lock();
        let now = chrono::Utc::now().timestamp();
        let cutoff = now - max_age_secs;

        let placeholders: Vec<String> = (1..=event_ids.len()).map(|i| format!("?{}", i)).collect();
        let sql = format!(
            "SELECT eid FROM (
                SELECT value AS eid FROM json_each(json_array({}))
             ) AS requested
             WHERE eid NOT IN (
                SELECT event_id FROM enrichment_cache WHERE last_fetched_at > ?{}
             )",
            placeholders.join(","),
            event_ids.len() + 1,
        );

        let mut stmt = conn.prepare(&sql)?;
        let mut params: Vec<&dyn rusqlite::ToSql> = event_ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
        params.push(&cutoff);

        let rows = stmt.query_map(params.as_slice(), |row| {
            row.get::<_, String>(0)
        })?;

        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Batch upsert enrichment timestamps for event IDs.
    pub fn set_enrichment_timestamps(&self, event_ids: &[String]) -> Result<()> {
        if event_ids.is_empty() {
            return Ok(());
        }

        let conn = self.conn.lock();
        let now = chrono::Utc::now().timestamp();

        let mut stmt = conn.prepare(
            "INSERT INTO enrichment_cache (event_id, last_fetched_at) VALUES (?1, ?2)
             ON CONFLICT(event_id) DO UPDATE SET last_fetched_at = ?2"
        )?;

        for id in event_ids {
            stmt.execute(rusqlite::params![id, now])?;
        }

        Ok(())
    }

    /// Delete enrichment_cache entries older than `max_age_secs` to prevent unbounded growth.
    pub fn cleanup_old_enrichment(&self, max_age_secs: i64) -> Result<u64> {
        let conn = self.conn.lock();
        let cutoff = chrono::Utc::now().timestamp() - max_age_secs;
        let deleted = conn.execute(
            "DELETE FROM enrichment_cache WHERE last_fetched_at < ?1",
            rusqlite::params![cutoff],
        )?;
        Ok(deleted as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_prune_skips_referenced_events() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let db = Database::open(tmp.path()).unwrap();

        let pk_a = "a".repeat(64);
        let pk_b = "b".repeat(64);

        // Event B (old, from pk_b) — a root note
        db.store_event("ev_b", &pk_b, 1000, 1, "[]", "root note", "sig_b").unwrap();

        // Event A (newer, from pk_a) — replies to B via e-tag
        let tags_a = r#"[["e","ev_b"]]"#;
        db.store_event("ev_a", &pk_a, 2000, 1, tags_a, "reply to B", "sig_a").unwrap();

        // Insert thread ref: ev_a references ev_b
        db.insert_thread_refs("ev_a", &["ev_b".to_string()]).unwrap();

        // Try to prune pk_b's events with a cutoff that would normally delete ev_b
        let deleted = db.prune_pubkey_events(&pk_b, 1500, 0).unwrap();

        // ev_b should NOT be deleted because it's referenced by ev_a
        assert_eq!(deleted, 0);

        // Verify ev_b still exists
        let events = db.query_events(Some(&["ev_b".to_string()]), None, None, None, None, 1).unwrap();
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn test_prune_deletes_unreferenced_events() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let db = Database::open(tmp.path()).unwrap();

        let pk = "c".repeat(64);

        // Store two old events, no thread refs
        db.store_event("ev1", &pk, 1000, 1, "[]", "old note 1", "sig1").unwrap();
        db.store_event("ev2", &pk, 1100, 1, "[]", "old note 2", "sig2").unwrap();
        // One newer event
        db.store_event("ev3", &pk, 3000, 1, "[]", "new note", "sig3").unwrap();

        // Prune with cutoff at 2000, keep min 1
        let deleted = db.prune_pubkey_events(&pk, 2000, 1).unwrap();

        // Should delete ev1 (oldest, below cutoff, not in top 1)
        // ev2 is also below cutoff but the min-events=1 keeps the newest non-metadata event
        assert!(deleted >= 1);
    }

    #[test]
    fn test_thread_refs_insert_and_cleanup() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let db = Database::open(tmp.path()).unwrap();

        // Insert refs
        db.insert_thread_refs("reply1", &["root1".to_string(), "root2".to_string()]).unwrap();
        db.insert_thread_refs("reply2", &["root1".to_string()]).unwrap();

        // Delete refs for reply1
        db.delete_thread_refs_by_referencing("reply1").unwrap();

        // root1 should still be referenced by reply2
        // root2 should no longer be referenced
        // We can verify this works without error
        db.delete_thread_refs_by_referencing("reply2").unwrap();
    }
}
