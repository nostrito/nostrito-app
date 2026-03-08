use anyhow::Result;
use lru::LruCache;
use nostr_sdk::prelude::*;
use std::num::NonZeroUsize;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};

use crate::storage::{Database, FollowUpdateBatch};
use crate::wot::WotGraph;

const SEEN_CACHE_CAPACITY: usize = 100_000;

#[derive(Debug, Clone)]
struct SeenEvent {
    created_at: u64,
    #[allow(dead_code)]
    event_id: EventId,
}

#[derive(Debug)]
struct FollowUpdate {
    pubkey: String,
    follows: Vec<String>,
    event_id: String,
    created_at: i64,
}

pub struct SyncEngine {
    graph: Arc<WotGraph>,
    db: Arc<Database>,
    relays: Vec<String>,
    cancel: CancellationToken,
}

impl SyncEngine {
    pub fn new(graph: Arc<WotGraph>, db: Arc<Database>, relays: Vec<String>) -> Self {
        Self {
            graph,
            db,
            relays,
            cancel: CancellationToken::new(),
        }
    }

    /// Start sync as a background task. Returns a cancellation token to stop it.
    pub fn start(self: Arc<Self>) -> CancellationToken {
        let cancel = self.cancel.clone();

        tokio::spawn(async move {
            if let Err(e) = self.run().await {
                error!("Sync engine error: {}", e);
            }
        });

        cancel
    }

    /// Stop the sync engine
    #[allow(dead_code)]
    pub fn stop(&self) {
        self.cancel.cancel();
    }

    async fn run(&self) -> Result<()> {
        info!("Starting sync from {} relays", self.relays.len());

        let (persist_tx, persist_rx) = mpsc::channel::<FollowUpdate>(10000);

        let db = self.db.clone();
        let cancel = self.cancel.clone();
        tokio::spawn(async move {
            persistence_worker(db, persist_rx, cancel).await;
        });

        let client = Client::default();

        for relay_url in &self.relays {
            match client.add_relay(relay_url).await {
                Ok(_) => info!("Added relay: {}", relay_url),
                Err(e) => warn!("Failed to add relay {}: {}", relay_url, e),
            }
        }

        client.connect().await;

        let filter = Filter::new().kind(Kind::ContactList);
        info!("Subscribing to kind:3 events...");

        client.subscribe(vec![filter], None).await?;

        let seen_events: Arc<tokio::sync::RwLock<LruCache<[u8; 32], SeenEvent>>> =
            Arc::new(tokio::sync::RwLock::new(LruCache::new(
                NonZeroUsize::new(SEEN_CACHE_CAPACITY).unwrap(),
            )));

        let mut notifications = client.notifications();
        let mut event_count: u64 = 0;
        let mut dedup_skip_count: u64 = 0;
        let mut last_log_time = std::time::Instant::now();

        loop {
            tokio::select! {
                _ = self.cancel.cancelled() => {
                    info!("Sync engine shutting down");
                    client.disconnect().await?;
                    break;
                }
                Ok(notification) = notifications.recv() => {
                    if let RelayPoolNotification::Event { event, .. } = notification {
                        let pubkey_bytes = event.pubkey.to_bytes();
                        let event_created_at = event.created_at.as_u64();

                        let dominated = {
                            let seen = seen_events.read().await;
                            if let Some(existing) = seen.peek(&pubkey_bytes) {
                                event_created_at <= existing.created_at
                            } else {
                                false
                            }
                        };
                        if dominated {
                            dedup_skip_count += 1;
                            continue;
                        }

                        if let Some(update) = process_event(&event) {
                            let updated = self.graph.update_follows(
                                &update.pubkey,
                                &update.follows,
                                Some(update.event_id.clone()),
                                Some(update.created_at),
                            );

                            if updated {
                                event_count += 1;

                                {
                                    let mut seen = seen_events.write().await;
                                    seen.put(pubkey_bytes, SeenEvent {
                                        created_at: event_created_at,
                                        event_id: event.id,
                                    });
                                }

                                if let Err(e) = persist_tx.try_send(update) {
                                    warn!("Persistence queue full: {}", e);
                                }
                            }
                        }

                        if last_log_time.elapsed() > Duration::from_secs(10) {
                            let stats = self.graph.stats();
                            let seen_size = seen_events.read().await.len();
                            info!(
                                "Sync progress: {} events, {} dedup skips, {} nodes, {} edges, seen_cache={}",
                                event_count, dedup_skip_count, stats.node_count, stats.edge_count, seen_size
                            );
                            last_log_time = std::time::Instant::now();
                        }
                    }
                }
                _ = tokio::time::sleep(Duration::from_secs(60)) => {
                    let stats = self.graph.stats();
                    info!(
                        "Sync status: {} events, {} nodes, {} edges",
                        event_count, stats.node_count, stats.edge_count
                    );
                }
            }
        }

        Ok(())
    }
}

fn process_event(event: &Event) -> Option<FollowUpdate> {
    if event.kind != Kind::ContactList {
        return None;
    }

    let pubkey = event.pubkey.to_hex();
    let event_id = event.id.to_hex();
    let created_at = event.created_at.as_u64() as i64;

    let follows: Vec<String> = event
        .tags
        .iter()
        .filter_map(|tag| {
            let tag_vec = tag.as_slice();
            if tag_vec.len() >= 2 && tag_vec[0] == "p" {
                let pk = &tag_vec[1];
                if pk.len() == 64 && pk.chars().all(|c| c.is_ascii_hexdigit()) {
                    Some(pk.to_string())
                } else {
                    None
                }
            } else {
                None
            }
        })
        .collect();

    debug!(
        "Processed event from {} with {} follows",
        &pubkey[..8],
        follows.len()
    );

    Some(FollowUpdate {
        pubkey,
        follows,
        event_id,
        created_at,
    })
}

async fn persistence_worker(
    db: Arc<Database>,
    mut rx: mpsc::Receiver<FollowUpdate>,
    cancel: CancellationToken,
) {
    info!("Persistence worker started");

    let mut batch: Vec<FollowUpdate> = Vec::with_capacity(100);
    let mut last_flush = std::time::Instant::now();

    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                if !batch.is_empty() {
                    flush_batch(&db, &mut batch).await;
                }
                info!("Persistence worker shutting down");
                break;
            }
            Some(update) = rx.recv() => {
                batch.push(update);
                if batch.len() >= 100 || last_flush.elapsed() > Duration::from_secs(5) {
                    flush_batch(&db, &mut batch).await;
                    last_flush = std::time::Instant::now();
                }
            }
            _ = tokio::time::sleep(Duration::from_secs(5)) => {
                if !batch.is_empty() {
                    flush_batch(&db, &mut batch).await;
                    last_flush = std::time::Instant::now();
                }
            }
        }
    }
}

async fn flush_batch(db: &Database, batch: &mut Vec<FollowUpdate>) {
    if batch.is_empty() {
        return;
    }

    debug!("Flushing {} updates to database", batch.len());

    let updates: Vec<FollowUpdateBatch<'_>> = batch
        .iter()
        .map(|u| FollowUpdateBatch {
            pubkey: &u.pubkey,
            follows: &u.follows,
            event_id: Some(&u.event_id),
            created_at: Some(u.created_at),
        })
        .collect();

    match db.update_follows_batch(&updates) {
        Ok(count) => debug!("Persisted {} updates in single transaction", count),
        Err(e) => error!("Failed to persist follow batch: {}", e),
    }

    batch.clear();
}
