#![allow(dead_code)]
use anyhow::Result;
use nostr_sdk::prelude::*;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

use super::policy::RelayPolicy;
use super::types::MAX_CONNECTIONS;

/// Tracks a relay connection's lifecycle.
struct RelayConnection {
    last_used: Instant,
}

/// Manages a pool of relay connections with on-demand connect, idle disconnect,
/// and a global connection cap.
pub struct RelayPool {
    client: Client,
    connections: RwLock<HashMap<String, RelayConnection>>,
    policies: RwLock<HashMap<String, RelayPolicy>>,
    max_connections: usize,
    idle_timeout: Duration,
}

impl RelayPool {
    pub fn new() -> Self {
        Self {
            client: Client::default(),
            connections: RwLock::new(HashMap::new()),
            policies: RwLock::new(HashMap::new()),
            max_connections: MAX_CONNECTIONS,
            idle_timeout: Duration::from_secs(300), // 5 min
        }
    }

    /// Ensure a relay is connected. Connects on-demand if not already connected.
    /// Evicts idle relays if at the connection cap.
    pub async fn ensure_connected(&self, relay_url: &str) -> Result<()> {
        {
            let mut conns = self.connections.write().await;
            if let Some(conn) = conns.get_mut(relay_url) {
                conn.last_used = Instant::now();
                return Ok(());
            }

            // Evict idle connections if at cap
            if conns.len() >= self.max_connections {
                self.evict_idle(&mut conns).await;
            }

            if conns.len() >= self.max_connections {
                // Still at cap after eviction — remove least recently used
                if let Some(lru_url) = conns
                    .iter()
                    .min_by_key(|(_, c)| c.last_used)
                    .map(|(url, _)| url.clone())
                {
                    debug!("RelayPool: evicting LRU relay {}", lru_url);
                    conns.remove(&lru_url);
                    self.client.remove_relay(&lru_url).await?;
                }
            }
        }

        // Connect to new relay
        match self.client.add_relay(relay_url).await {
            Ok(_) => {
                self.client.connect_relay(relay_url).await?;
                tokio::time::sleep(Duration::from_millis(500)).await;
                let mut conns = self.connections.write().await;
                conns.insert(
                    relay_url.to_string(),
                    RelayConnection {
                        last_used: Instant::now(),
                    },
                );
                debug!("RelayPool: connected to {}", relay_url);
                Ok(())
            }
            Err(e) => {
                let mut policies = self.policies.write().await;
                let policy = policies
                    .entry(relay_url.to_string())
                    .or_insert_with(RelayPolicy::new);
                policy.on_connection_failure();
                Err(e.into())
            }
        }
    }

    /// Ensure multiple relays are connected.
    pub async fn ensure_connected_many(&self, relay_urls: &[String]) -> Vec<String> {
        let mut connected = Vec::new();
        for url in relay_urls {
            if self.ensure_connected(url).await.is_ok() {
                connected.push(url.clone());
            }
        }
        connected
    }

    /// Subscribe to filters and collect events with timeout, EOSE handling, and policy enforcement.
    pub async fn subscribe_and_collect(
        &self,
        relay_urls: &[String],
        filters: Vec<Filter>,
        timeout_secs: u64,
    ) -> Result<Vec<Event>> {
        if relay_urls.is_empty() {
            return Ok(Vec::new());
        }

        // Ensure relays are connected
        let connected = self.ensure_connected_many(relay_urls).await;
        if connected.is_empty() {
            return Ok(Vec::new());
        }

        // Wait for policy slot on first relay
        {
            let mut policies = self.policies.write().await;
            let policy = policies
                .entry(connected[0].clone())
                .or_insert_with(RelayPolicy::new);
            policy.wait_for_slot().await;
        }

        let expected_eose = connected.len();
        let mut notifications = self.client.notifications();

        let sub_id = self.client.subscribe(filters, None).await?.val;
        let mut events: Vec<Event> = Vec::new();

        let deadline = tokio::time::sleep(Duration::from_secs(timeout_secs));
        tokio::pin!(deadline);

        let mut eose_count = 0usize;
        let mut got_eose = false;

        loop {
            tokio::select! {
                notification = notifications.recv() => {
                    match notification {
                        Ok(RelayPoolNotification::Event { subscription_id, event, .. }) => {
                            if subscription_id == sub_id {
                                events.push((*event).clone());
                            }
                        }
                        Ok(RelayPoolNotification::Message { message, relay_url }) => {
                            match message {
                                RelayMessage::EndOfStoredEvents(sid) if sid == sub_id => {
                                    eose_count += 1;
                                    if eose_count >= expected_eose {
                                        got_eose = true;
                                        break;
                                    }
                                    // Shorten deadline on first EOSE
                                    if eose_count == 1 && expected_eose > 1 {
                                        deadline.as_mut().reset(tokio::time::Instant::now() + Duration::from_secs(3));
                                    }
                                }
                                RelayMessage::Notice { message: ref msg } => {
                                    let mut policies = self.policies.write().await;
                                    let url_str = relay_url.to_string();
                                    let policy = policies
                                        .entry(url_str)
                                        .or_insert_with(RelayPolicy::new);
                                    policy.on_notice(msg);
                                }
                                _ => {}
                            }
                        }
                        Ok(RelayPoolNotification::Shutdown) => break,
                        Err(_) => break,
                        _ => {}
                    }
                }
                _ = &mut deadline => {
                    debug!("RelayPool: subscription timeout after {}s", timeout_secs);
                    break;
                }
            }
        }

        self.client.unsubscribe(sub_id).await;

        // Update policies on success
        if got_eose || !events.is_empty() {
            let mut policies = self.policies.write().await;
            for url in &connected {
                let policy = policies
                    .entry(url.clone())
                    .or_insert_with(RelayPolicy::new);
                policy.on_success();
            }
        }

        // Touch connection timestamps
        {
            let mut conns = self.connections.write().await;
            for url in &connected {
                if let Some(conn) = conns.get_mut(url) {
                    conn.last_used = Instant::now();
                }
            }
        }

        debug!(
            "RelayPool: collected {} events (EOSE={}, {}/{} relays)",
            events.len(),
            got_eose,
            eose_count,
            expected_eose
        );

        Ok(events)
    }

    /// Disconnect idle relays that haven't been used within the idle timeout.
    async fn evict_idle(&self, conns: &mut HashMap<String, RelayConnection>) {
        let now = Instant::now();
        let to_evict: Vec<String> = conns
            .iter()
            .filter(|(_, c)| now.duration_since(c.last_used) > self.idle_timeout)
            .map(|(url, _)| url.clone())
            .collect();

        for url in &to_evict {
            conns.remove(url);
            if let Err(e) = self.client.remove_relay(url.as_str()).await {
                warn!("RelayPool: failed to remove idle relay {}: {}", url, e);
            } else {
                debug!("RelayPool: evicted idle relay {}", url);
            }
        }
    }

    /// Disconnect all relays and clean up.
    pub async fn shutdown(&self) {
        self.client.disconnect().await.ok();
        self.connections.write().await.clear();
        info!("RelayPool: shutdown complete");
    }

    /// Get current connection count.
    pub async fn connection_count(&self) -> usize {
        self.connections.read().await.len()
    }
}

impl Default for RelayPool {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pool_construction() {
        let pool = RelayPool::new();
        assert_eq!(pool.max_connections, MAX_CONNECTIONS);
    }

    #[tokio::test]
    async fn test_pool_connection_count_starts_zero() {
        let pool = RelayPool::new();
        assert_eq!(pool.connection_count().await, 0);
    }
}
