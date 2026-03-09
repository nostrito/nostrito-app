use anyhow::Result;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use tracing::{debug, info};

use crate::wot::WotGraph;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileInfo {
    pub pubkey: String,
    pub name: Option<String>,
    pub display_name: Option<String>,
    pub picture: Option<String>,
    pub nip05: Option<String>,
}

pub struct Database {
    conn: Mutex<Connection>,
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
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")?;

        let db = Self {
            conn: Mutex::new(conn),
        };
        db.init_schema()?;
        Ok(db)
    }

    fn init_schema(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();

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

        info!("Database schema initialized");
        Ok(())
    }

    pub fn load_graph(&self, graph: &WotGraph) -> Result<()> {
        let conn = self.conn.lock().unwrap();

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

        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let now = chrono::Utc::now().timestamp();

        let success_count = {
            let mut upsert_node_stmt = tx.prepare_cached(
                r#"
                INSERT INTO nodes (pubkey, kind3_event_id, kind3_created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4)
                ON CONFLICT(pubkey) DO UPDATE SET
                    kind3_event_id = COALESCE(?2, kind3_event_id),
                    kind3_created_at = COALESCE(?3, kind3_created_at),
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
        let conn = self.conn.lock().unwrap();

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
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();

        let node_count: usize =
            conn.query_row("SELECT COUNT(*) FROM nodes", [], |row| row.get(0))?;

        let edge_count: usize =
            conn.query_row("SELECT COUNT(*) FROM edges", [], |row| row.get(0))?;

        Ok((node_count, edge_count))
    }

    /// Store app config key-value
    pub fn set_config(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO app_config (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
            params![key, value],
        )?;
        Ok(())
    }

    /// Get app config value
    pub fn get_config(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();

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

    /// Get event count
    pub fn event_count(&self) -> Result<u64> {
        let conn = self.conn.lock().unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM nostr_events", [], |row| row.get(0))?;
        debug!("[db] event_count: {}", count);
        Ok(count as u64)
    }

    /// Get database file size in bytes
    pub fn db_size_bytes(&self) -> Result<u64> {
        let conn = self.conn.lock().unwrap();
        let page_count: i64 = conn.query_row("PRAGMA page_count", [], |row| row.get(0))?;
        let page_size: i64 = conn.query_row("PRAGMA page_size", [], |row| row.get(0))?;
        let size = (page_count * page_size) as u64;
        debug!("[db] db_size: {} bytes", size);
        Ok(size)
    }

    /// Get oldest and newest event timestamps
    pub fn event_time_range(&self) -> Result<(u64, u64)> {
        let conn = self.conn.lock().unwrap();
        let oldest: i64 = conn
            .query_row("SELECT COALESCE(MIN(created_at), 0) FROM nostr_events", [], |row| row.get(0))?;
        let newest: i64 = conn
            .query_row("SELECT COALESCE(MAX(created_at), 0) FROM nostr_events", [], |row| row.get(0))?;
        Ok((oldest as u64, newest as u64))
    }

    /// Get hourly event counts for the last N hours (for activity chart).
    /// Returns a Vec of length `hours`, index 0 = oldest hour, last = most recent.
    pub fn get_hourly_counts(&self, hours: u32) -> Result<Vec<u64>> {
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
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
    pub fn get_profiles(&self, pubkeys: &[String]) -> Result<Vec<ProfileInfo>> {
        if pubkeys.is_empty() {
            return Ok(vec![]);
        }

        let conn = self.conn.lock().unwrap();
        let mut profiles = Vec::new();

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
                            nip05: parsed.get("nip05").and_then(|v| v.as_str()).map(String::from),
                        });
                    }
                }
            }
        }

        debug!("[db] get_profiles: requested={}, found={}", pubkeys.len(), profiles.len());
        Ok(profiles)
    }

    /// Get DM events (kind:4) involving a specific pubkey (as sender or recipient).
    /// Returns (id, pubkey, created_at, kind, tags_json, content, sig).
    pub fn get_dm_events(
        &self,
        own_pubkey: &str,
        limit: u32,
    ) -> Result<Vec<(String, String, i64, i64, String, String, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, pubkey, created_at, kind, tags, content, sig \
             FROM nostr_events \
             WHERE kind = 4 AND (pubkey = ?1 OR tags LIKE '%' || ?1 || '%') \
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
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            r#"
            DELETE FROM edges;
            DELETE FROM nodes;
            DELETE FROM nostr_events;
            DELETE FROM sync_state;
            DELETE FROM app_config;
            DELETE FROM media_cache;
        "#,
        )?;
        info!("Database cleared — all data deleted");
        Ok(())
    }

    // ── Media Cache Methods ────────────────────────────────────────

    /// Check if a media blob is already cached
    pub fn media_exists(&self, hash: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM media_cache WHERE hash = ?1",
                params![hash],
                |row| row.get(0),
            )
            .unwrap_or(0);
        count > 0
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
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp();
        conn.execute(
            "INSERT OR REPLACE INTO media_cache (hash, url, mime_type, size_bytes, pubkey, downloaded_at, last_accessed) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![hash, url, mime_type, size_bytes as i64, pubkey, now, now],
        )?;
        debug!("[db] store_media_record: hash={}… size={}", &hash[..std::cmp::min(12, hash.len())], size_bytes);
        Ok(())
    }

    /// Number of cached media files
    pub fn media_file_count(&self) -> Result<u64> {
        let conn = self.conn.lock().unwrap();
        let count: i64 =
            conn.query_row("SELECT COUNT(*) FROM media_cache", [], |row| row.get(0))?;
        Ok(count as u64)
    }

    /// Total bytes used by cached media
    pub fn media_total_bytes(&self) -> Result<u64> {
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT hash, size_bytes FROM media_cache WHERE pubkey != ?1 ORDER BY last_accessed ASC LIMIT ?2"
        )?;
        let rows = stmt
            .query_map(params![exclude_pubkey, limit as i64], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64))
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// Total bytes used by others' media (excluding own pubkey)
    pub fn media_others_bytes(&self, exclude_pubkey: &str) -> Result<u64> {
        let conn = self.conn.lock().unwrap();
        let total: i64 = conn.query_row(
            "SELECT COALESCE(SUM(size_bytes), 0) FROM media_cache WHERE pubkey != ?1",
            params![exclude_pubkey],
            |row| row.get(0),
        )?;
        Ok(total as u64)
    }

    /// Delete oldest events from others (NOT from own pubkey) — used for storage enforcement
    pub fn delete_oldest_others_events(&self, own_pubkey: &str, count: u32) -> Result<u64> {
        let conn = self.conn.lock().unwrap();
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

    /// Get the latest created_at timestamp from stored nostr events.
    pub fn get_latest_event_timestamp(&self) -> Result<Option<u64>> {
        let conn = self.conn.lock().unwrap();
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

    /// Delete media records by hash (caller must also delete the file)
    pub fn media_delete_records(&self, hashes: &[String]) -> Result<()> {
        if hashes.is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock().unwrap();
        for hash in hashes {
            conn.execute("DELETE FROM media_cache WHERE hash = ?1", params![hash])?;
        }
        debug!("[db] media_delete_records: deleted {} records", hashes.len());
        Ok(())
    }
}
