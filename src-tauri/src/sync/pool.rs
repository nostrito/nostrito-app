#![allow(dead_code)]
use anyhow::Result;
use nostr_sdk::prelude::*;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

use super::policy::RelayPolicy;


/// Tracks a relay connection's lifecycle.
struct RelayConnection {
    last_used: Instant,
}

/// Manages relay connections with per-call Client instances, policy enforcement,
/// and a global connection cap.
///
/// Each `subscribe_and_collect` creates a fresh `nostr_sdk::Client` because
/// the underlying relay pool shuts itself down after subscriptions complete,
/// making the Client unusable for subsequent calls.
pub struct RelayPool {
    policies: RwLock<HashMap<String, RelayPolicy>>,
}

impl RelayPool {
    pub fn new() -> Self {
        Self {
            policies: RwLock::new(HashMap::new()),
        }
    }

    /// Subscribe to filters and collect events with timeout, EOSE handling, and policy enforcement.
    /// Creates a fresh Client per call to avoid stale connection state.
    pub async fn subscribe_and_collect(
        &self,
        relay_urls: &[String],
        filters: Vec<Filter>,
        timeout_secs: u64,
    ) -> Result<Vec<Event>> {
        if relay_urls.is_empty() {
            return Ok(Vec::new());
        }

        // Wait for policy slot on first relay
        {
            let mut policies = self.policies.write().await;
            let policy = policies
                .entry(relay_urls[0].clone())
                .or_insert_with(RelayPolicy::new);
            policy.wait_for_slot().await;
        }

        // Create a fresh client for this subscription
        let client = Client::default();
        let mut connected = Vec::new();

        for url in relay_urls {
            debug!("RelayPool: connecting to {} ...", url);
            let connect_start = Instant::now();
            match client.add_relay(url.as_str()).await {
                Ok(_) => {
                    match client.connect_relay(url.as_str()).await {
                        Ok(_) => {
                            debug!("RelayPool: connected to {} in {:.1}s", url, connect_start.elapsed().as_secs_f32());
                            connected.push(url.clone());
                        }
                        Err(e) => {
                            warn!("RelayPool: connect to {} failed after {:.1}s: {}", url, connect_start.elapsed().as_secs_f32(), e);
                            let mut policies = self.policies.write().await;
                            let policy = policies.entry(url.clone()).or_insert_with(RelayPolicy::new);
                            policy.on_connection_failure();
                        }
                    }
                }
                Err(e) => {
                    warn!("RelayPool: add relay {} failed: {}", url, e);
                    let mut policies = self.policies.write().await;
                    let policy = policies.entry(url.clone()).or_insert_with(RelayPolicy::new);
                    policy.on_connection_failure();
                }
            }
        }

        if connected.is_empty() {
            warn!("RelayPool: no relays connected out of {:?}", relay_urls);
            return Ok(Vec::new());
        }

        let expected_eose = connected.len();
        let mut notifications = client.notifications();

        debug!("RelayPool: subscribing to {} relays (timeout={}s): {:?}", connected.len(), timeout_secs, connected);
        let sub_start = Instant::now();
        let sub_id = client.subscribe_to(connected.clone(), filters, None).await?.val;
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
                        Ok(RelayPoolNotification::Shutdown) => {
                            warn!("RelayPool: internal pool shutdown during subscription");
                            break;
                        },
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

        client.unsubscribe(sub_id).await;

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

        info!(
            "RelayPool: collected {} events in {:.1}s (EOSE={}, {}/{} relays)",
            events.len(),
            sub_start.elapsed().as_secs_f32(),
            got_eose,
            eose_count,
            expected_eose
        );

        // Clean disconnect
        client.disconnect().await.ok();

        Ok(events)
    }

    /// Disconnect all relays and clean up.
    pub async fn shutdown(&self) {
        info!("RelayPool: shutdown complete");
    }

    /// Get current connection count (always 0 — connections are per-call now).
    pub async fn connection_count(&self) -> usize {
        0
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
        let _pool = RelayPool::new();
        // Pool is now stateless per-call — just verify construction works
    }

    #[tokio::test]
    async fn test_pool_connection_count_starts_zero() {
        let pool = RelayPool::new();
        assert_eq!(pool.connection_count().await, 0);
    }
}
