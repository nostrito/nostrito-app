#![allow(dead_code)]
use std::time::{Duration, Instant};
use tracing::{info, warn};

use super::types::{
    BACKOFF_SEQUENCE, GENERIC_NOTICE_PAUSE_SECS, RATE_LIMIT_PAUSE_SECS, RELAY_MIN_INTERVAL_SECS,
};

/// Polite relay access policy: rate limiting, backoff, and NOTICE handling.
/// One instance per relay URL.
pub struct RelayPolicy {
    last_request: Option<Instant>,
    min_interval: Duration,
    paused_until: Option<Instant>,
    consecutive_failures: u32,
    last_notice: Option<String>,
    is_rate_limited: bool,
}

impl RelayPolicy {
    pub fn new() -> Self {
        Self {
            last_request: None,
            min_interval: Duration::from_secs(RELAY_MIN_INTERVAL_SECS),
            paused_until: None,
            consecutive_failures: 0,
            last_notice: None,
            is_rate_limited: false,
        }
    }

    pub fn with_interval(min_interval_secs: u64) -> Self {
        Self {
            min_interval: Duration::from_secs(min_interval_secs),
            ..Self::new()
        }
    }

    /// Wait until we're allowed to send the next request, respecting rate limits.
    pub async fn wait_for_slot(&mut self) {
        // Check pause (from NOTICE or failure backoff)
        if let Some(paused_until) = self.paused_until {
            let now = Instant::now();
            if now < paused_until {
                let wait = paused_until - now;
                info!("RelayPolicy: paused, waiting {:.1}s", wait.as_secs_f32());
                tokio::time::sleep(wait).await;
            }
            self.paused_until = None;
        }

        // Enforce minimum interval between requests
        if let Some(last) = self.last_request {
            let elapsed = last.elapsed();
            if elapsed < self.min_interval {
                let wait = self.min_interval - elapsed;
                tokio::time::sleep(wait).await;
            }
        }

        self.last_request = Some(Instant::now());
    }

    /// Handle a NOTICE message from the relay.
    pub fn on_notice(&mut self, msg: &str) {
        let lower = msg.to_lowercase();
        self.last_notice = Some(msg.to_string());

        if lower.contains("rate")
            || lower.contains("limit")
            || lower.contains("too many")
            || lower.contains("slow down")
            || lower.contains("blocked")
        {
            warn!("Rate limit NOTICE from relay: {}", msg);
            self.paused_until =
                Some(Instant::now() + Duration::from_secs(RATE_LIMIT_PAUSE_SECS));
            self.min_interval = Duration::from_secs(5);
            self.is_rate_limited = true;
        } else {
            info!("Relay NOTICE: {}", msg);
            self.paused_until =
                Some(Instant::now() + Duration::from_secs(GENERIC_NOTICE_PAUSE_SECS));
        }
    }

    /// Handle a connection failure with exponential backoff.
    pub fn on_connection_failure(&mut self) {
        self.consecutive_failures += 1;
        let idx = (self.consecutive_failures as usize - 1).min(BACKOFF_SEQUENCE.len() - 1);
        let backoff = BACKOFF_SEQUENCE[idx];
        self.paused_until = Some(Instant::now() + Duration::from_secs(backoff));
        warn!(
            "Connection failure #{}, backing off {}s",
            self.consecutive_failures, backoff
        );
    }

    /// Handle a successful interaction — resets failure counter.
    pub fn on_success(&mut self) {
        self.consecutive_failures = 0;
        self.is_rate_limited = false;
    }

    /// Check if currently rate-limited.
    pub fn is_rate_limited(&self) -> bool {
        self.is_rate_limited
    }

    /// Check if currently paused (rate limit or backoff).
    pub fn is_paused(&self) -> bool {
        self.paused_until
            .map(|until| Instant::now() < until)
            .unwrap_or(false)
    }

    /// Get consecutive failure count.
    pub fn failure_count(&self) -> u32 {
        self.consecutive_failures
    }
}

impl Default for RelayPolicy {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rate_limiting_notice() {
        let mut policy = RelayPolicy::new();
        assert!(!policy.is_rate_limited());

        policy.on_notice("rate limited: too many requests");
        assert!(policy.is_rate_limited());
        assert!(policy.is_paused());
    }

    #[test]
    fn test_generic_notice() {
        let mut policy = RelayPolicy::new();
        policy.on_notice("some generic info");
        assert!(!policy.is_rate_limited());
        assert!(policy.is_paused()); // Brief pause for generic notices
    }

    #[test]
    fn test_backoff_escalation() {
        let mut policy = RelayPolicy::new();

        policy.on_connection_failure();
        assert_eq!(policy.failure_count(), 1);
        assert!(policy.is_paused());

        policy.on_connection_failure();
        assert_eq!(policy.failure_count(), 2);

        policy.on_connection_failure();
        policy.on_connection_failure();
        policy.on_connection_failure();
        assert_eq!(policy.failure_count(), 5);

        // 6th failure should still use max backoff, not panic
        policy.on_connection_failure();
        assert_eq!(policy.failure_count(), 6);
    }

    #[test]
    fn test_success_resets_failures() {
        let mut policy = RelayPolicy::new();
        policy.on_connection_failure();
        policy.on_connection_failure();
        assert_eq!(policy.failure_count(), 2);

        policy.on_success();
        assert_eq!(policy.failure_count(), 0);
        assert!(!policy.is_rate_limited());
    }
}
