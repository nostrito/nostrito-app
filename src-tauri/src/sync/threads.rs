use anyhow::Result;
use nostr_sdk::prelude::*;
use std::sync::Arc;
use tracing::{debug, info, warn};

use crate::storage::db::Database;
use crate::wot::WotGraph;

use super::pool::RelayPool;
use super::processing;
use super::types::{EventSource, THREAD_CONTEXT_LIMIT};

/// Phase 4: Thread Context — fetch missing root events for reply threads.
///
/// When content fetch (Phase 3) pulls in replies, those replies reference parent
/// events via `e` tags that may not have been fetched yet. This phase resolves
/// those gaps so threads render completely.
///
/// ## Algorithm
///
/// 1. Scans the 2000 most recent kind:1/6/30023 events for `e` tag references
///    to events not stored locally (`find_missing_roots`).
/// 2. Fetches up to `THREAD_CONTEXT_LIMIT` missing roots in a first pass:
///    - Events with a relay hint in the `e` tag are fetched from that relay.
///    - Events without a hint are fetched from all configured relays.
/// 3. If the first pass fetched any events, runs one recursive pass (up to 200
///    additional roots) to resolve parents-of-parents.
///
/// ## Termination
///
/// At most **2 fetch passes** run per sync cycle (initial + one recursive).
/// Deeper thread chains are resolved over successive sync cycles.
pub struct ThreadContext {
    db: Arc<Database>,
    graph: Arc<WotGraph>,
    pool: Arc<RelayPool>,
    own_pubkey: String,
    app_handle: tauri::AppHandle,
    thread_retention_days: u32,
}

impl ThreadContext {
    pub fn new(
        db: Arc<Database>,
        graph: Arc<WotGraph>,
        pool: Arc<RelayPool>,
        own_pubkey: String,
        app_handle: tauri::AppHandle,
        thread_retention_days: u32,
    ) -> Self {
        Self { db, graph, pool, own_pubkey, app_handle, thread_retention_days }
    }

    /// Run the thread context phase (2-pass maximum).
    ///
    /// Returns [`ThreadStats`] with the number of missing roots found and
    /// how many were successfully fetched across both passes.
    pub async fn run(&self, relay_urls: &[String]) -> Result<ThreadStats> {
        let mut stats = ThreadStats::default();

        // Find events with e-tag references to events we don't have
        let missing = self.find_missing_roots()?;

        if missing.is_empty() {
            return Ok(stats);
        }

        let to_fetch: Vec<&MissingRoot> = missing
            .iter()
            .take(THREAD_CONTEXT_LIMIT as usize)
            .collect();

        info!("Thread context: {} missing roots (fetching {})", missing.len(), to_fetch.len());

        // Group by relay hint if available, otherwise use all relays
        let mut by_relay: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
        let mut no_hint: Vec<String> = Vec::new();

        for root in &to_fetch {
            if let Some(ref hint) = root.relay_hint {
                by_relay
                    .entry(hint.clone())
                    .or_default()
                    .push(root.event_id.clone());
            } else {
                no_hint.push(root.event_id.clone());
            }
        }

        // Fetch from hinted relays
        for (relay_url, event_ids) in &by_relay {
            let fetched = self.fetch_events_by_id(relay_url, event_ids).await;
            stats.fetched += fetched;
        }

        // Fetch unhinted from all configured relays
        if !no_hint.is_empty() && !relay_urls.is_empty() {
            for relay_url in relay_urls {
                let fetched = self.fetch_events_by_id(relay_url, &no_hint).await;
                stats.fetched += fetched;
            }
        }

        stats.missing = missing.len() as u32;
        info!("Thread context: fetched {} of {} missing roots", stats.fetched, stats.missing);

        // Stage 2: Fetch thread context (replies, reactions, zaps) for user-participated threads
        let max_age_secs = self.thread_retention_days as u64 * 86400;
        let thread_roots = self.db.get_user_thread_roots(50, max_age_secs).unwrap_or_default();
        if !thread_roots.is_empty() {
            info!("Thread context: enriching {} user-participated threads", thread_roots.len());
            for (root_id, _participation) in &thread_roots {
                if let Ok(root_event_id) = EventId::from_hex(root_id) {
                    // Fetch replies to this thread
                    let replies_filter = Filter::new()
                        .event(root_event_id)
                        .kinds(vec![Kind::TextNote])
                        .limit(200);

                    // Fetch reactions + zaps for this thread
                    let interactions_filter = Filter::new()
                        .event(root_event_id)
                        .kinds(vec![Kind::Reaction, Kind::from(9735)])
                        .limit(500);

                    match self.pool.subscribe_and_collect(
                        relay_urls,
                        vec![replies_filter, interactions_filter],
                        15,
                    ).await {
                        Ok(events) => {
                            if !events.is_empty() {
                                let (stored, _) = processing::process_events(
                                    &events,
                                    &self.db,
                                    &self.graph,
                                    &self.own_pubkey,
                                    EventSource::ThreadContext,
                                    Some(&self.app_handle),
                                    "thread",
                                );
                                stats.fetched += stored;
                            }
                        }
                        Err(e) => {
                            warn!("Thread context: failed to enrich thread {}: {}", &root_id[..12.min(root_id.len())], e);
                        }
                    }
                }
            }
        }

        // Recursive: scan newly fetched events for their own e-tag references
        if stats.fetched > 0 {
            let missing_2 = self.find_missing_roots()?;
            if !missing_2.is_empty() {
                let to_fetch_2: Vec<&MissingRoot> = missing_2.iter().take(200).collect();
                info!("Thread context (recursive): {} additional missing roots", to_fetch_2.len());

                let mut by_relay_2: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
                let mut no_hint_2: Vec<String> = Vec::new();

                for root in &to_fetch_2 {
                    if let Some(ref hint) = root.relay_hint {
                        by_relay_2.entry(hint.clone()).or_default().push(root.event_id.clone());
                    } else {
                        no_hint_2.push(root.event_id.clone());
                    }
                }

                for (relay_url, event_ids) in &by_relay_2 {
                    stats.fetched += self.fetch_events_by_id(relay_url, event_ids).await;
                }
                if !no_hint_2.is_empty() && !relay_urls.is_empty() {
                    for relay_url in relay_urls {
                        stats.fetched += self.fetch_events_by_id(relay_url, &no_hint_2).await;
                    }
                }
            }
        }

        Ok(stats)
    }

    /// Scan the 2000 most recent kind:1/6/30023 events for `e` tag references
    /// pointing to event IDs not present in the local database. Deduplicates
    /// by event ID and extracts the optional relay hint from tag position 2.
    fn find_missing_roots(&self) -> Result<Vec<MissingRoot>> {
        // Query recent kind:1/6/30023 events that have reply tags
        let events = self.db.query_events(
            None,
            None,
            Some(&[1, 6, 30023]), // Text notes, reposts, long-form articles
            None,
            None,
            2000,
        )?;

        let mut missing = Vec::new();
        let mut seen = std::collections::HashSet::new();

        for (_id, _pubkey, _created_at, _kind, tags_json, _content, _sig) in &events {
            let tags: Vec<Vec<String>> = serde_json::from_str(tags_json).unwrap_or_default();

            for tag in &tags {
                if tag.len() >= 2 && tag[0] == "e" {
                    let ref_id = &tag[1];

                    // Skip if we've already checked this ID
                    if !seen.insert(ref_id.clone()) {
                        continue;
                    }

                    // Check if we have this event
                    let exists = self.db.query_events(
                        Some(&[ref_id.clone()]),
                        None,
                        None,
                        None,
                        None,
                        1,
                    )
                    .map(|r| !r.is_empty())
                    .unwrap_or(false);

                    if !exists {
                        let relay_hint = tag.get(2).cloned().filter(|s| {
                            !s.is_empty() && (s.starts_with("wss://") || s.starts_with("ws://"))
                        });

                        missing.push(MissingRoot {
                            event_id: ref_id.clone(),
                            relay_hint,
                        });
                    }
                }
            }
        }

        Ok(missing)
    }

    /// Fetch specific events by ID from a single relay (10s timeout).
    /// Stores fetched events via `process_events` and returns the count stored.
    async fn fetch_events_by_id(&self, relay_url: &str, event_ids: &[String]) -> u32 {
        if event_ids.is_empty() {
            return 0;
        }

        let ids: Vec<EventId> = event_ids
            .iter()
            .filter_map(|id| EventId::from_hex(id).ok())
            .collect();

        if ids.is_empty() {
            return 0;
        }

        let filter = Filter::new().ids(ids).limit(event_ids.len() as usize);

        match self.pool.subscribe_and_collect(
            &[relay_url.to_string()],
            vec![filter],
            10,
        ).await {
            Ok(events) => {
                let (stored, _) = processing::process_events(
                    &events,
                    &self.db,
                    &self.graph,
                    &self.own_pubkey,
                    EventSource::ThreadContext,
                    Some(&self.app_handle),
                    "thread",
                );
                if stored > 0 {
                    debug!("Thread: fetched {} events from {}", stored, relay_url);
                }
                stored
            }
            Err(e) => {
                warn!("Thread: fetch from {} failed: {}", relay_url, e);
                0
            }
        }
    }
}

/// An event referenced by an `e` tag that is not yet stored locally.
#[derive(Debug)]
struct MissingRoot {
    /// Hex-encoded event ID from the `e` tag.
    event_id: String,
    /// Optional `wss://` or `ws://` relay URL from tag position 2.
    relay_hint: Option<String>,
}

/// Summary of a single thread-context run.
#[derive(Debug, Default)]
pub struct ThreadStats {
    /// Total missing roots found in the initial scan.
    pub missing: u32,
    /// Events successfully fetched across both passes.
    pub fetched: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_thread_stats_default() {
        let stats = ThreadStats::default();
        assert_eq!(stats.missing, 0);
        assert_eq!(stats.fetched, 0);
    }
}
