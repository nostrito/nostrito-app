//! WebSocket relay server — NIP-01 compliant stub.
//!
//! Will handle:
//! - EVENT: receive and store events
//! - REQ: subscribe to events matching filters
//! - CLOSE: close subscriptions
//! - AUTH: NIP-42 authentication (optional)

use anyhow::Result;

/// Start the local relay on the given port.
pub async fn start_relay(_port: u16) -> Result<()> {
    tracing::info!("Relay server stub — not yet implemented");
    // TODO: Bind WebSocket listener, handle NIP-01 messages,
    //       validate events, store in DB, broadcast to subscribers.
    Ok(())
}

/// Stop the running relay.
pub async fn stop_relay() -> Result<()> {
    tracing::info!("Stopping relay stub");
    Ok(())
}
