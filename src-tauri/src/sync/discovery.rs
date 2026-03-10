use anyhow::Result;
use nostr_sdk::prelude::*;
use std::sync::Arc;
use tracing::{debug, info, warn};

use crate::storage::db::Database;
use super::pool::RelayPool;
use super::processing;
use super::types::{EventSource, DISCOVERY_RELAY};
use crate::wot::WotGraph;

/// Phase 2: Discovery — find relay information for follows.
pub struct Discovery {
    db: Arc<Database>,
    graph: Arc<WotGraph>,
    pool: Arc<RelayPool>,
    own_pubkey: String,
}

impl Discovery {
    pub fn new(
        db: Arc<Database>,
        graph: Arc<WotGraph>,
        pool: Arc<RelayPool>,
        own_pubkey: String,
    ) -> Self {
        Self { db, graph, pool, own_pubkey }
    }

    /// Run the full discovery phase.
    pub async fn run(&self) -> Result<DiscoveryStats> {
        let mut stats = DiscoveryStats::default();

        // Step 2a: Local kind:3 relay hint scan
        stats.local_hints = self.scan_local_relay_hints()?;

        // Step 2b: Bootstrap from purplepag.es if first run
        if self.is_first_run()? {
            stats.bootstrap_relays = self.bootstrap_from_discovery_relay().await?;
        }

        // Step 2c & 2d: Identify pubkeys needing relay list refresh
        // (these get piggybacked onto Phase 3 content fetch)
        stats.needing_refresh = self.identify_needing_refresh()?;

        Ok(stats)
    }

    /// Step 2a: Scan local kind:3 events for relay hints not yet in user_relays.
    fn scan_local_relay_hints(&self) -> Result<u32> {
        // This is already done by the migration bootstrap.
        // On subsequent runs, relay hints are extracted during event processing (Batch 4).
        // This method is a no-op after initial migration.
        Ok(0)
    }

    /// Check if this is the first run (no user_relays exist).
    fn is_first_run(&self) -> Result<bool> {
        // Check if any follows have NIP-65 relay data
        let follows = self.graph.get_follows(&self.own_pubkey).unwrap_or_default();
        if follows.is_empty() {
            return Ok(false); // No follows yet, nothing to discover
        }

        // Check first follow for relay data
        for follow in follows.iter().take(5) {
            let relays = self.db.get_write_relays(follow)?;
            if !relays.is_empty() {
                return Ok(false); // Already have some relay data
            }
        }

        Ok(true)
    }

    /// Step 2b: Bootstrap relay info from purplepag.es for all follows.
    async fn bootstrap_from_discovery_relay(&self) -> Result<u32> {
        let follows = self.graph.get_follows(&self.own_pubkey).unwrap_or_default();
        if follows.is_empty() {
            return Ok(0);
        }

        info!("Discovery: bootstrapping relay info for {} follows from {}", follows.len(), DISCOVERY_RELAY);

        let relay_url = DISCOVERY_RELAY.to_string();
        if self.pool.ensure_connected(&relay_url).await.is_err() {
            warn!("Discovery: failed to connect to {}", DISCOVERY_RELAY);
            return Ok(0);
        }

        let mut total_processed = 0u32;

        // Batch queries of 100 pubkeys
        for chunk in follows.chunks(100) {
            let authors: Vec<PublicKey> = chunk
                .iter()
                .filter_map(|pk| PublicKey::from_hex(pk).ok())
                .collect();

            if authors.is_empty() {
                continue;
            }

            let filter = Filter::new()
                .authors(authors)
                .kind(Kind::RelayList)
                .limit(200);

            match self.pool.subscribe_and_collect(
                &[relay_url.clone()],
                vec![filter],
                15,
            ).await {
                Ok(events) => {
                    let (stored, _) = processing::process_events(
                        &events,
                        &self.db,
                        &self.graph,
                        &self.own_pubkey,
                        EventSource::Sync,
                    );
                    total_processed += stored;
                }
                Err(e) => {
                    warn!("Discovery: bootstrap query failed: {}", e);
                }
            }
        }

        info!("Discovery: bootstrapped {} relay list events", total_processed);
        Ok(total_processed)
    }

    /// Step 2c/2d: Identify pubkeys that need relay list refresh.
    /// Returns pubkeys that should have kind:10002 piggybacked onto Phase 3.
    pub fn identify_needing_refresh(&self) -> Result<u32> {
        let follows = self.graph.get_follows(&self.own_pubkey).unwrap_or_default();
        let tracked = self.db.get_tracked_pubkeys()?;

        let mut count = 0u32;

        for pubkey in follows.iter().chain(tracked.iter()) {
            let relays = self.db.get_write_relays(pubkey)?;
            let has_nip65 = relays.iter().any(|(_, source)| source == "nip65");
            if !has_nip65 {
                count += 1;
            }
        }

        if count > 0 {
            debug!("Discovery: {} pubkeys need relay list refresh", count);
        }
        Ok(count)
    }

    /// Get pubkeys that need kind:10002 piggybacked onto content fetch.
    pub fn pubkeys_needing_relay_refresh(&self) -> Result<Vec<String>> {
        let follows = self.graph.get_follows(&self.own_pubkey).unwrap_or_default();
        let tracked = self.db.get_tracked_pubkeys()?;
        let mut result = Vec::new();

        for pubkey in follows.iter().chain(tracked.iter()) {
            let relays = self.db.get_write_relays(pubkey)?;
            let has_nip65 = relays.iter().any(|(_, source)| source == "nip65");
            if !has_nip65 {
                result.push(pubkey.clone());
            }
        }

        Ok(result)
    }
}

#[derive(Debug, Default)]
pub struct DiscoveryStats {
    pub local_hints: u32,
    pub bootstrap_relays: u32,
    pub needing_refresh: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_discovery_stats_default() {
        let stats = DiscoveryStats::default();
        assert_eq!(stats.local_hints, 0);
        assert_eq!(stats.bootstrap_relays, 0);
        assert_eq!(stats.needing_refresh, 0);
    }
}
