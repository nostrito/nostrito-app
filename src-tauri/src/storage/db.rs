use anyhow::Result;
use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Mutex;
use tracing::{debug, info};

use crate::wot::WotGraph;

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
                sig TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_events_pubkey ON nostr_events(pubkey);
            CREATE INDEX IF NOT EXISTS idx_events_kind ON nostr_events(kind);
            CREATE INDEX IF NOT EXISTS idx_events_created ON nostr_events(created_at);

            CREATE TABLE IF NOT EXISTS app_config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        "#,
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
}
