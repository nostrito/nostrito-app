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
pub struct ThreadContext {
    db: Arc<Database>,
    graph: Arc<WotGraph>,
    pool: Arc<RelayPool>,
    own_pubkey: String,
}

impl ThreadContext {
    pub fn new(
        db: Arc<Database>,
        graph: Arc<WotGraph>,
        pool: Arc<RelayPool>,
        own_pubkey: String,
    ) -> Self {
        Self { db, graph, pool, own_pubkey }
    }

    /// Run the thread context phase.
    /// Scans stored events for missing `e` tag references and fetches them.
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

    /// Find events referenced by e-tags that we don't have stored locally.
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

    /// Fetch specific events by ID from a relay.
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
                    super::types::MEDIA_PRIORITY_OTHERS,
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

#[derive(Debug)]
struct MissingRoot {
    event_id: String,
    relay_hint: Option<String>,
}

#[derive(Debug, Default)]
pub struct ThreadStats {
    pub missing: u32,
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
