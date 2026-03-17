//! NIP-01 + NIP-11 compliant WebSocket relay server.
//!
//! Personal relay that:
//! - Serves events from SQLite via WebSocket (NIP-01)
//! - Accepts EVENT, REQ, CLOSE messages
//! - Sends EVENT, EOSE, NOTICE, OK responses
//! - Serves relay information document over HTTP (NIP-11)
//! - Restricts writes to the owner npub **and** tracked profiles
//! - Broadcasts newly-stored events to all configured outbound relays
//! - Sends native macOS notifications on new events via tauri-plugin-notification

use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, mpsc, RwLock};

/// Channel for forwarding newly-stored events to outbound relays.
pub type OutboundEventSender = mpsc::UnboundedSender<String>;
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, error, info, warn};

use crate::storage::Database;

/// Inline SVG path data for the Nostrito chili logo (simplified from logo.svg).
const NOSTRITO_LOGO_PATH: &str = "m 220.8,428.3 c -6.8,-2.2 -8.2,-3.3 -9.4,-7.7 -0.6,-2.3 -2.0,-5.4 -3.2,-6.9 -2.0,-2.7 -2.0,-3.2 -0.8,-17.6 1.4,-16.5 0.4,-36.1 -2.6,-48.8 -1.9,-8.4 -1.5,-11.4 2.9,-18.0 3.6,-5.4 6.4,-12.1 5.4,-13.0 -0.3,-0.3 -2.4,0.3 -4.6,1.4 -2.2,1.1 -4.3,1.7 -4.6,1.4 -0.3,-0.3 -1.3,0.2 -2.1,1.3 -0.8,1.1 -1.5,1.4 -1.5,0.7 -0.1,-2.3 -2.0,-1.3 -3.6,2 -2.2,4.3 -2.1,4.2 -4.0,2.7 -1.4,-1.2 -1.8,-1.1 -3.1,0.6 -1.2,1.7 -1.6,1.7 -2.4,0.5 -0.5,-0.8 -1.0,-2.2 -1.0,-3.0 -0.1,-2.8 -2.0,1.2 -2.0,4.2 -0.0,3.3 -1.6,3.6 -2.6,0.6 -0.6,-2.0 -0.8,-2.0 -1.9,-0.5 -1.8,2.4 -2.5,2.1 -2.6,-1.1 -0.0,-1.5 -0.4,-3.6 -0.8,-4.7 -0.7,-1.8 -0.8,-1.8 -1.4,0.5 -0.6,2.3 -0.7,2.3 -2.0,0.6 -1.3,-1.7 -1.4,-1.6 -2.7,1.0 l -1.4,2.8 -1.0,-3.8 c -1.0,-3.7 -2.6,-5.1 -2.6,-2.2 0,0.8 -0.5,1.5 -1,1.5 -0.6,0 -1,-2.1 -1,-4.7 0,-4.6 -0.0,-4.6 -2,-2.8 -1.9,1.8 -2,1.7 -2,-0.3 0,-1.3 -0.5,-1.9 -1.3,-1.6 -0.8,0.3 -1.8,-0.6 -2.5,-2.2 -0.7,-1.5 -1.5,-2.4 -1.8,-2.1 -1.3,1.3 -3.9,-2.9 -3.5,-5.5 0.2,-1.6 -0.1,-2.8 -0.7,-2.8 -0.6,0 -1.1,-0.7 -1.1,-1.6 0,-0.9 -0.5,-1.3 -1.2,-0.8 -0.8,0.5 -1.0,-0.3 -0.6,-2.9 0.5,-3.4 0.4,-3.6 -1.3,-2.6 -2.4,1.3 -2.4,0.7 -0.2,-2.8 1.9,-2.9 2.3,-2.9 -3.4,-0.6 -1.4,0.6 -1.4,0.3 0.3,-2.2 3.5,-5.0 3.5,-5.3 1.1,-4.7 l -2.3,0.6 2.4,-2.6 2.4,-2.6 h -2.3 -2.3 l 2.4,-2.6 2.4,-2.6 -2.8,0.7 c -3.3,0.8 -3.6,-0.6 -0.5,-2.7 2.1,-1.5 2.1,-1.6 0.3,-1.6 -1.9,-0.1 -1.9,-0.1 0,-1.5 1.8,-1.4 1.7,-1.5 -1.6,-1.6 l -3.5,-0.1 4.2,-2.1 c 4.6,-2.3 5.2,-3.3 2.5,-4.1 -1.5,-0.4 -1.4,-0.6 0.5,-1.2 1.2,-0.4 2.2,-1.3 2.2,-2.1 0,-0.8 0.7,-1.4 1.5,-1.4 2.3,0 1.8,-1.7 -0.8,-2.4 l -2.2,-0.7 2.5,-1.0 c 3.3,-1.4 3.5,-1.6 2.1,-3.4 -1.1,-1.3 -0.9,-1.5 1.0,-1.5 1.6,0 2.1,-0.4 1.7,-1.5 -0.4,-0.9 -0.0,-1.5 0.9,-1.5 1.8,0 1.9,-1.6 0.2,-2.3 -0.7,-0.3 -0.0,-0.5 1.5,-0.6 1.8,-0.1 2.6,-0.5 2.2,-1.4 -0.3,-0.8 0.9,-2.1 3.0,-3.2 1.9,-1.0 3.5,-2.3 3.5,-2.7 0,-0.4 0.8,-0.8 1.9,-0.8 1.0,0 2.1,-0.9 2.4,-2 0.4,-1.4 1.4,-2 3.2,-2 1.7,0 2.5,-0.5 2.3,-1.2 -0.5,-1.4 1.0,-3.1 3.5,-4.0 1.0,-0.4 1.8,-1.1 1.8,-1.7 0,-0.6 0.9,-1.0 2,-1.0 1.1,0 2,-0.5 2,-1 0,-0.6 -0.5,-1 -1,-1 -0.6,0 -1,-0.5 -1,-1 0,-0.6 1.8,-1 4.1,-1 3.4,0 4.0,-0.3 3.5,-1.6 -0.3,-0.9 -0.1,-2.2 0.5,-3 0.6,-0.8 0.7,-1.4 0.3,-1.4 -0.5,-0.0 0.3,-0.6 1.8,-1.4 1.5,-0.8 3.9,-1.1 5.4,-0.9 2.5,0.5 2.7,0.3 2.0,-1.8 -0.7,-2.1 -0.5,-2.2 2.4,-1.7 1.7,0.3 3.1,0.3 3.1,-0.1 0.0,-1.5 5.2,-3.2 7.1,-2.2 2.6,1.4 2.9,1.2 2.9,-1.1 0,-2.1 0.0,-2.1 4.8,-0.2 1.0,0.4 1.1,-0.2 0.6,-2.3 -0.7,-2.7 -0.6,-2.8 1.0,-1.4 1.6,1.3 1.9,1.3 2.7,-0.3 0.7,-1.3 1.4,-1.5 2.9,-0.7 1.4,0.7 1.9,0.7 1.9,-0.1 0,-0.7 0.8,-0.8 2.2,-0.4 1.7,0.5 2.0,0.4 1.5,-0.9 -0.8,-2.0 1.1,-2.1 3.8,-0.1 1.5,1.1 2.1,1.2 2.7,0.3 0.6,-0.9 1.2,-0.8 2.6,0.5 2.3,2.1 3.4,2.2 2.6,0.2 -0.7,-1.9 0.1,-1.9 3.2,0.1 1.5,1.0 2.5,1.2 2.5,0.5 0,-1.7 1.4,-1.3 4.1,1.0 l 2.4,2.1 0.3,-2.6 c 0.4,-3.1 1.7,-3.3 3.2,-0.6 1.4,2.6 8.1,5.5 9.1,3.9 0.5,-0.8 1.4,-0.5 2.8,1.0 1.2,1.2 2.6,2.1 3.2,2.1 0.6,0 3.4,2.2 6.2,4.8 4.9,4.5 13.8,11.2 15.1,11.2 1.3,0 0.2,-2.9 -6.5,-17.3 -5.4,-11.6 -8.2,-16.5 -12.1,-20.7 -2.8,-3.0 -6.3,-7.1 -7.7,-9 -1.4,-1.9 -3.6,-4.5 -4.9,-5.7 -1.2,-1.2 -2.3,-3.2 -2.3,-4.3 0,-1.2 -0.4,-1.8 -1.1,-1.4 -0.7,0.4 -0.8,-0.5 -0.4,-3.0 0.6,-3.1 0.4,-3.5 -1.0,-3.0 -1.4,0.5 -1.5,0.2 -0.6,-2.1 1.3,-3.5 1.3,-3.6 -0.5,-2.9 -1.8,0.7 -2.0,-0.7 -0.2,-2.6 1.0,-1.1 1.0,-1.4 -0.0,-1.8 -1.0,-0.4 -1.0,-0.8 -0.1,-1.9 0.7,-0.8 0.9,-1.7 0.6,-2.1 -0.3,-0.3 -0.1,-1.3 0.5,-2.1 0.9,-1.1 0.9,-1.6 -0.2,-2.3 -1.1,-0.7 -0.9,-1.5 1.5,-3.9 1.7,-1.8 2.4,-3.0 1.6,-3.0 -0.9,0 -0.6,-0.8 0.8,-2.3 1.2,-1.3 1.9,-2.6 1.6,-2.9 -0.3,-0.3 0.3,-1.1 1.5,-1.7 1.1,-0.6 1.8,-1.7 1.5,-2.5 -0.4,-0.9 0.5,-1.6 2.6,-2.1 2.1,-0.5 3.0,-1.1 2.6,-2.1 -0.4,-1.0 0.2,-1.4 1.9,-1.4 1.4,0 2.5,-0.5 2.5,-1.1 0,-0.6 0.9,-0.8 2.0,-0.4 1.3,0.4 2.2,0.1 2.6,-0.8 0.3,-0.8 1.9,-1.5 3.7,-1.5 1.8,-0.0 5.2,-0.1 7.6,-0.2 2.4,-0.1 4.8,0.3 5.4,0.9 0.6,0.6 1.9,0.6 3.4,0.1 1.5,-0.6 2.4,-0.5 2.4,0.1 0,0.5 1.2,1.0 2.6,1.0 1.9,0 2.5,0.4 2.0,1.6 -0.4,1.1 0.3,1.9 2.2,2.5 2.6,0.9 10.9,10.7 14.3,16.9 1.0,1.8 1.3,5.8 1.2,13.5 l -0.2,11.0 5.8,6.1 c 6.1,6.4 8.5,11.9 5.9,13.7 -0.8,0.5 -6.9,0.6 -13.9,0.3 -12.9,-0.7 -14.9,-0.3 -19.1,3.3 -2.3,2.0 -1.4,3.6 7.6,13.7 11.4,12.8 14.7,17.3 16.1,22.0 0.7,2.4 2.0,5.8 3.0,7.5 0.9,1.8 1.4,3.8 1.2,4.5 -0.3,0.7 0.0,1.8 0.6,2.4 0.8,0.8 0.8,1.1 -0.1,1.1 -0.8,0 -1.0,0.7 -0.6,2 0.4,1.2 0.2,2 -0.6,2 -0.8,0 -0.9,0.4 -0.2,1.2 0.5,0.7 0.8,2.8 0.5,4.8 -0.3,1.9 -0.6,6.1 -0.6,9.2 -0.1,3.2 -0.5,5.8 -1.0,5.8 -0.5,0 -0.6,0.9 -0.3,2 0.3,1.2 0.0,2 -0.7,2 -0.8,0 -1.1,1.1 -0.8,3 0.3,1.8 -0.0,3 -0.7,3 -0.6,0 -1.1,0.7 -1.1,1.5 0,0.9 -0.6,1.2 -1.5,0.9 -1.0,-0.4 -2.1,0.6 -3.2,2.7 -2.3,4.3 -6.3,8.1 -7.9,7.5 -0.7,-0.3 -1.5,0.2 -1.8,1.1 -0.3,0.9 -0.9,1.3 -1.2,1.0 -0.3,-0.3 -2.3,0.0 -4.4,0.8 -3.3,1.1 -4.1,1.1 -5.9,-0.1 -1.2,-0.9 -2.1,-1.0 -2.1,-0.4 0,2.1 -1.9,1.0 -2.7,-1.6 -0.9,-2.6 -0.9,-2.6 -4.1,3 -1.8,3.1 -3.7,5.7 -4.3,5.7 -0.6,0 -0.8,0.4 -0.5,0.9 0.6,0.9 -7.7,9.1 -9.2,9.1 -0.5,0 -1.4,1.7 -2.0,3.8 -0.6,2.1 -3.5,7.8 -6.3,12.8 -2.8,5.0 -5.8,11.0 -6.7,13.4 -1.5,4.4 -1.5,5.5 1.4,24.9 0.6,4.3 15.4,33.7 19.8,39.5 1.9,2.5 4.4,6.4 5.5,8.6 2.8,5.5 5.8,7.2 14.1,8.1 3.9,0.4 7.8,1.4 8.7,2.3 0.9,0.8 3.4,2.0 5.4,2.7 4.8,1.5 8.8,4.7 8.8,7.0 0,1.3 -0.6,1.7 -2.2,1.4 -1.2,-0.2 -3.3,-0.0 -4.5,0.4 -1.3,0.5 -5.0,0.6 -8.4,0.3 -4.5,-0.4 -6.2,-0.2 -6.6,0.7 -0.3,0.7 -1.0,1.0 -1.6,0.6 -0.6,-0.4 -4.3,-0.7 -8.1,-0.8 -8.2,-0.1 -11.2,-1.4 -13.1,-6.0 -0.8,-1.8 -2.9,-4.4 -4.7,-5.6 -4.2,-2.9 -4.5,-3.4 -5.8,-9.3 -2.7,-12.7 -15.1,-38.0 -24.4,-49.9 -5.9,-7.5 -6.5,-10.9 -3.8,-21.3 1.2,-4.5 2.1,-11.2 2.1,-14.9 v -6.7 l -2.8,0.7 c -3.9,0.9 -11.5,8.8 -14.6,14.9 -1.8,3.5 -2.7,7.2 -3.0,11.7 -0.2,4.1 -1.4,9.2 -3.2,13.5 -2.7,6.6 -2.8,7.7 -2.8,23.9 -0.0,15.4 0.2,17.6 2.4,24.0 2.9,8.5 5.2,10.0 17.1,12.1 6.9,1.2 8.8,2.0 11.6,4.7 2.8,2.7 6.2,7.6 6.2,9.0 0,1.0 -16.2,-0.2 -20.9,-1.7 -3.0,-0.9 -6.6,-1.6 -8.0,-1.6 -2.4,0 -2.6,0.3 -2.2,3.5 0.5,3.9 0.4,3.9 -5.4,2.0 z";

fn format_bytes_display(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{} B", bytes)
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else if bytes < 1024 * 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else {
        format!("{:.1} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    }
}

fn format_count_display(n: u64) -> String {
    if n < 1_000 {
        n.to_string()
    } else if n < 1_000_000 {
        format!("{:.1}k", n as f64 / 1_000.0)
    } else {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    }
}

/// Subscription state for a single client connection
struct Subscription {
    filters: Vec<RelayFilter>,
}

/// NIP-01 filter
#[derive(Debug, Clone)]
struct RelayFilter {
    ids: Option<Vec<String>>,
    authors: Option<Vec<String>>,
    kinds: Option<Vec<u32>>,
    since: Option<u64>,
    until: Option<u64>,
    limit: Option<u32>,
    tag_filters: HashMap<String, Vec<String>>,
}

impl RelayFilter {
    fn from_json(val: &Value) -> Option<Self> {
        let obj = val.as_object()?;
        Some(Self {
            ids: obj.get("ids").and_then(|v| {
                v.as_array()
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            }),
            authors: obj.get("authors").and_then(|v| {
                v.as_array()
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            }),
            kinds: obj.get("kinds").and_then(|v| {
                v.as_array()
                    .map(|a| a.iter().filter_map(|x| x.as_u64().map(|n| n as u32)).collect())
            }),
            since: obj.get("since").and_then(|v| v.as_u64()),
            until: obj.get("until").and_then(|v| v.as_u64()),
            limit: obj.get("limit").and_then(|v| v.as_u64().map(|n| n as u32)),
            tag_filters: {
                let mut tf = HashMap::new();
                for (k, v) in obj {
                    if k.starts_with('#') && k.len() == 2 {
                        if let Some(arr) = v.as_array() {
                            let vals: Vec<String> =
                                arr.iter().filter_map(|x| x.as_str().map(String::from)).collect();
                            if !vals.is_empty() {
                                tf.insert(k[1..].to_string(), vals);
                            }
                        }
                    }
                }
                tf
            },
        })
    }

    fn matches_event(&self, event: &StoredEvent) -> bool {
        if let Some(ref ids) = self.ids {
            if !ids.iter().any(|id| event.id.starts_with(id)) {
                return false;
            }
        }
        if let Some(ref authors) = self.authors {
            if !authors.iter().any(|a| event.pubkey.starts_with(a)) {
                return false;
            }
        }
        if let Some(ref kinds) = self.kinds {
            if !kinds.contains(&event.kind) {
                return false;
            }
        }
        if let Some(since) = self.since {
            if event.created_at < since {
                return false;
            }
        }
        if let Some(until) = self.until {
            if event.created_at > until {
                return false;
            }
        }
        // Tag filters
        for (tag_name, tag_values) in &self.tag_filters {
            let has_match = event.tags.iter().any(|tag| {
                tag.len() >= 2 && tag[0] == *tag_name && tag_values.contains(&tag[1])
            });
            if !has_match {
                return false;
            }
        }
        true
    }
}

/// Event as stored/transmitted
#[derive(Debug, Clone)]
struct StoredEvent {
    id: String,
    pubkey: String,
    created_at: u64,
    kind: u32,
    tags: Vec<Vec<String>>,
    content: String,
    sig: String,
}

impl StoredEvent {
    fn to_json(&self) -> Value {
        serde_json::json!({
            "id": self.id,
            "pubkey": self.pubkey,
            "created_at": self.created_at,
            "kind": self.kind,
            "tags": self.tags,
            "content": self.content,
            "sig": self.sig,
        })
    }
}

/// Broadcast channel for new events
type EventBroadcast = broadcast::Sender<StoredEvent>;

/// A stream that prepends already-read bytes before delegating to the inner stream.
/// Used when we consume bytes from a TLS stream to detect HTTP vs WebSocket,
/// then need to replay those bytes for the WebSocket handshake.
struct PrefixedIo<S> {
    prefix: Option<std::io::Cursor<Vec<u8>>>,
    inner: S,
}

impl<S> PrefixedIo<S> {
    fn new(prefix: Vec<u8>, inner: S) -> Self {
        Self {
            prefix: if prefix.is_empty() {
                None
            } else {
                Some(std::io::Cursor::new(prefix))
            },
            inner,
        }
    }
}

impl<S: tokio::io::AsyncRead + Unpin> tokio::io::AsyncRead for PrefixedIo<S> {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let this = self.get_mut();
        if let Some(ref mut cursor) = this.prefix {
            let pos = cursor.position() as usize;
            let data = cursor.get_ref();
            if pos < data.len() {
                let remaining = &data[pos..];
                let to_copy = std::cmp::min(remaining.len(), buf.remaining());
                buf.put_slice(&remaining[..to_copy]);
                cursor.set_position((pos + to_copy) as u64);
                return std::task::Poll::Ready(Ok(()));
            }
            this.prefix = None;
        }
        std::pin::Pin::new(&mut this.inner).poll_read(cx, buf)
    }
}

impl<S: tokio::io::AsyncWrite + Unpin> tokio::io::AsyncWrite for PrefixedIo<S> {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.get_mut().inner).poll_write(cx, buf)
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

/// Run the relay server
pub async fn run_relay(
    port: u16,
    db: Arc<Database>,
    allowed_pubkey: Option<String>,
    cancel: tokio_util::sync::CancellationToken,
    outbound_tx: Option<OutboundEventSender>,
) -> Result<()> {
    let addr = format!("127.0.0.1:{}", port);
    let listener = TcpListener::bind(&addr).await?;
    info!("Relay listening on ws://{}", addr);

    let (broadcast_tx, _) = broadcast::channel::<StoredEvent>(1024);

    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                info!("Relay server shutting down");
                break;
            }
            result = listener.accept() => {
                match result {
                    Ok((stream, addr)) => {
                        let db = db.clone();
                        let allowed = allowed_pubkey.clone();
                        let tx = broadcast_tx.clone();
                        let rx = broadcast_tx.subscribe();
                        let cancel = cancel.clone();
                        let outbound = outbound_tx.clone();
                        tokio::spawn(async move {
                            // Peek at raw bytes to detect WebSocket upgrade vs plain HTTP
                            let mut header_buf = vec![0u8; 2048];
                            match stream.peek(&mut header_buf).await {
                                Ok(n) => {
                                    let header_str = String::from_utf8_lossy(&header_buf[..n]);
                                    let is_ws = header_str.contains("Upgrade: websocket")
                                        || header_str.contains("upgrade: websocket")
                                        || header_str.contains("Upgrade: WebSocket");
                                    if is_ws {
                                        if let Err(e) = handle_connection(stream, addr, db, allowed, tx, rx, cancel, outbound).await {
                                            debug!("Connection {} closed: {}", addr, e);
                                        }
                                    } else {
                                        // NIP-11: serve HTTP info page
                                        let accept_nostr = header_str.contains("application/nostr+json");
                                        let hex_pubkey = allowed.unwrap_or_default();
                                        if let Err(e) = serve_http(stream, port, &hex_pubkey, accept_nostr, &db).await {
                                            debug!("HTTP response to {} failed: {}", addr, e);
                                        }
                                    }
                                }
                                Err(e) => {
                                    debug!("Peek error from {}: {}", addr, e);
                                }
                            }
                        });
                    }
                    Err(e) => {
                        error!("Accept error: {}", e);
                    }
                }
            }
        }
    }

    Ok(())
}

/// Load TLS configuration from PEM certificate and key files.
fn load_tls_config(
    cert: &Path,
    key: &Path,
) -> Result<Arc<tokio_rustls::rustls::ServerConfig>> {
    use rustls_pemfile::{certs, pkcs8_private_keys};
    use tokio_rustls::rustls;

    let cert_file = std::fs::read(cert)?;
    let key_file = std::fs::read(key)?;

    let certs: Vec<_> = certs(&mut cert_file.as_slice())
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let key = pkcs8_private_keys(&mut key_file.as_slice())
        .next()
        .ok_or_else(|| anyhow::anyhow!("no private key found in key file"))??;

    let config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, rustls::pki_types::PrivateKeyDer::Pkcs8(key))?;

    Ok(Arc::new(config))
}

/// Run the relay server with TLS (wss://)
pub async fn run_relay_tls(
    port: u16,
    cert_pem: std::path::PathBuf,
    key_pem: std::path::PathBuf,
    db: Arc<Database>,
    allowed_pubkey: Option<String>,
    cancel: tokio_util::sync::CancellationToken,
    outbound_tx: Option<OutboundEventSender>,
) -> Result<()> {
    let tls_config = load_tls_config(&cert_pem, &key_pem)?;
    let tls_acceptor = TlsAcceptor::from(tls_config);

    let addr = format!("127.0.0.1:{}", port);
    let listener = TcpListener::bind(&addr).await?;
    info!("Relay listening on wss://{}", addr);

    let (broadcast_tx, _) = broadcast::channel::<StoredEvent>(1024);

    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                info!("TLS relay server shutting down");
                break;
            }
            result = listener.accept() => {
                match result {
                    Ok((stream, addr)) => {
                        let db = db.clone();
                        let allowed = allowed_pubkey.clone();
                        let tx = broadcast_tx.clone();
                        let rx = broadcast_tx.subscribe();
                        let cancel = cancel.clone();
                        let acceptor = tls_acceptor.clone();
                        let outbound = outbound_tx.clone();
                        tokio::spawn(async move {
                            match acceptor.accept(stream).await {
                                Ok(mut tls_stream) => {
                                    // Read first bytes to detect HTTP vs WebSocket upgrade.
                                    // TLS streams don't support peek, so we read and replay
                                    // via PrefixedIo for the WebSocket path.
                                    let mut header_buf = vec![0u8; 2048];
                                    match tls_stream.read(&mut header_buf).await {
                                        Ok(n) if n > 0 => {
                                            let header_str =
                                                String::from_utf8_lossy(&header_buf[..n]);
                                            let is_ws =
                                                header_str.contains("Upgrade: websocket")
                                                    || header_str
                                                        .contains("upgrade: websocket")
                                                    || header_str
                                                        .contains("Upgrade: WebSocket");

                                            if is_ws {
                                                // Replay consumed bytes for tungstenite handshake
                                                let prefixed = PrefixedIo::new(
                                                    header_buf[..n].to_vec(),
                                                    tls_stream,
                                                );
                                                match tokio_tungstenite::accept_async(prefixed)
                                                    .await
                                                {
                                                    Ok(ws_stream) => {
                                                        if let Err(e) =
                                                            handle_tls_connection(
                                                                ws_stream, addr, db,
                                                                allowed, tx, rx, cancel,
                                                                outbound,
                                                            )
                                                            .await
                                                        {
                                                            debug!(
                                                                "TLS connection {} closed: {}",
                                                                addr, e
                                                            );
                                                        }
                                                    }
                                                    Err(e) => {
                                                        debug!(
                                                            "TLS WebSocket upgrade failed from {}: {}",
                                                            addr, e
                                                        );
                                                    }
                                                }
                                            } else {
                                                // NIP-11: serve HTTP info page over TLS
                                                let accept_nostr = header_str
                                                    .contains("application/nostr+json");
                                                let hex_pubkey =
                                                    allowed.unwrap_or_default();
                                                if let Err(e) = write_nip11_response(
                                                    &mut tls_stream,
                                                    port,
                                                    &hex_pubkey,
                                                    accept_nostr,
                                                    true,
                                                    &db,
                                                )
                                                .await
                                                {
                                                    debug!(
                                                        "HTTPS response to {} failed: {}",
                                                        addr, e
                                                    );
                                                }
                                            }
                                        }
                                        Ok(_) => {
                                            debug!("Empty TLS read from {}", addr);
                                        }
                                        Err(e) => {
                                            debug!("TLS read error from {}: {}", addr, e);
                                        }
                                    }
                                }
                                Err(e) => {
                                    debug!("TLS handshake failed from {}: {}", addr, e);
                                }
                            }
                        });
                    }
                    Err(e) => {
                        error!("Accept error: {}", e);
                    }
                }
            }
        }
    }

    Ok(())
}

/// Handle a TLS WebSocket connection (same logic as plain, different stream type)
async fn handle_tls_connection<S>(
    ws_stream: tokio_tungstenite::WebSocketStream<S>,
    addr: SocketAddr,
    db: Arc<Database>,
    allowed_pubkey: Option<String>,
    broadcast_tx: EventBroadcast,
    mut broadcast_rx: broadcast::Receiver<StoredEvent>,
    cancel: tokio_util::sync::CancellationToken,
    outbound_tx: Option<OutboundEventSender>,
) -> Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
{
    info!("[relay-tls] New connection from {}", addr);

    let (mut ws_tx, mut ws_rx) = ws_stream.split();
    let subscriptions: Arc<RwLock<HashMap<String, Subscription>>> =
        Arc::new(RwLock::new(HashMap::new()));

    let subs_clone = subscriptions.clone();

    let forward_task = tokio::spawn(async move {
        loop {
            match broadcast_rx.recv().await {
                Ok(event) => {
                    let subs = subs_clone.read().await;
                    for (sub_id, sub) in subs.iter() {
                        if sub.filters.iter().any(|f| f.matches_event(&event)) {
                            let _ = serde_json::json!(["EVENT", sub_id, event.to_json()]);
                        }
                    }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    warn!("Broadcast lagged by {} messages", n);
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            msg = ws_rx.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        let responses = handle_message(
                            &text,
                            &db,
                            &subscriptions,
                            &allowed_pubkey,
                            &broadcast_tx,
                            &outbound_tx,
                        ).await;
                        for resp in responses {
                            if ws_tx.send(Message::Text(resp.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Some(Ok(Message::Ping(data))) => {
                        ws_tx.send(Message::Pong(data)).await.ok();
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(e)) => {
                        debug!("TLS WebSocket error from {}: {}", addr, e);
                        break;
                    }
                    _ => {}
                }
            }
        }
    }

    forward_task.abort();
    info!("[relay-tls] Connection from {} closed", addr);
    Ok(())
}

/// NIP-11: Serve relay information document (JSON) or HTML info page over plain HTTP.
async fn serve_http(
    mut stream: TcpStream,
    port: u16,
    hex_pubkey: &str,
    accept_nostr_json: bool,
    db: &Arc<Database>,
) -> Result<()> {
    // Drain the request from the socket (we already peeked, now consume it)
    let mut drain = vec![0u8; 4096];
    let _ = tokio::time::timeout(
        std::time::Duration::from_millis(100),
        tokio::io::AsyncReadExt::read(&mut stream, &mut drain),
    )
    .await;

    write_nip11_response(&mut stream, port, hex_pubkey, accept_nostr_json, false, db).await
}

/// Write a NIP-11 HTTP response (JSON or HTML) to any async stream.
/// Shared by both plain HTTP (`serve_http`) and HTTPS/TLS code paths.
async fn write_nip11_response(
    stream: &mut (impl AsyncWriteExt + Unpin),
    port: u16,
    hex_pubkey: &str,
    accept_nostr_json: bool,
    use_tls: bool,
    db: &Arc<Database>,
) -> Result<()> {
    let ws_scheme = if use_tls { "wss" } else { "ws" };

    if accept_nostr_json {
        // NIP-11 JSON relay information document
        let body = serde_json::json!({
            "name": "nostrito relay",
            "description": "Your personal Nostr relay. Running locally.",
            "pubkey": hex_pubkey,
            "contact": "",
            "supported_nips": [1, 2, 9, 11, 16, 20, 33, 40, 45],
            "software": "nostrito",
            "version": "0.1.0"
        })
        .to_string();

        let response = format!(
            "HTTP/1.1 200 OK\r\n\
             Content-Type: application/nostr+json\r\n\
             Access-Control-Allow-Origin: *\r\n\
             Content-Length: {}\r\n\
             Connection: close\r\n\
             \r\n\
             {}",
            body.len(),
            body
        );
        stream.write_all(response.as_bytes()).await?;
    } else {
        // HTML info page
        let pubkey_display = if hex_pubkey.is_empty() {
            "not configured".to_string()
        } else {
            hex_pubkey.to_string()
        };

        // Query relay stats from the database
        let event_count = db.event_count().unwrap_or(0);
        let db_size = db.db_size_bytes().unwrap_or(0);
        let recent_events = db.events_last_24h().unwrap_or(0);

        let event_count_display = format_count_display(event_count);
        let db_size_display = format_bytes_display(db_size);
        let recent_display = format_count_display(recent_events);

        let body = format!(
            r#"<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>nostrito relay</title>
  <style>
    *{{box-sizing:border-box;margin:0;padding:0}}
    body{{background:#0a0a0a;color:#e8e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}}
    .container{{max-width:520px;width:100%}}
    .header{{text-align:center;margin-bottom:32px}}
    .logo-icon{{width:80px;height:auto;margin:0 auto 16px}}
    .logo-icon svg{{width:100%;height:100%}}
    .logo-icon path{{fill:#7c3aed}}
    .logo-text{{font-size:32px;font-weight:800;color:#fff}}
    .logo-text span{{color:#7c3aed}}
    .subtitle{{color:#888;font-size:14px;margin-top:4px}}
    .status{{display:inline-flex;align-items:center;gap:8px;padding:8px 16px;background:rgba(52,211,153,.1);border:1px solid rgba(52,211,153,.2);border-radius:24px;font-size:13px;color:#34d399;margin-top:16px}}
    .dot{{width:8px;height:8px;border-radius:50%;background:#34d399;display:inline-block;animation:pulse 2s infinite}}
    @keyframes pulse{{0%,100%{{opacity:1}}50%{{opacity:.5}}}}
    .stats{{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px}}
    .stat{{background:#111113;border:1px solid #1e1e24;border-radius:12px;padding:16px;text-align:center}}
    .stat-val{{font-size:24px;font-weight:700;color:#fff}}
    .stat-lbl{{font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-top:4px}}
    .card{{background:#111113;border:1px solid #1e1e24;border-radius:12px;padding:24px;margin-bottom:16px}}
    .card-title{{font-size:12px;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-bottom:16px}}
    .row{{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #1e1e24;font-size:13px}}
    .row:last-child{{border-bottom:none}}
    .label{{color:#888}}
    .value{{color:#e8e8f0;font-weight:500;max-width:60%;text-align:right;word-break:break-all}}
    .nips{{display:flex;flex-wrap:wrap;gap:6px}}
    .nip{{padding:4px 12px;background:rgba(124,58,237,.12);color:#a78bfa;border-radius:20px;font-size:12px;font-weight:600}}
    .connect{{background:#111113;border:1px solid #1e1e24;border-radius:12px;padding:20px;text-align:center;font-size:13px;color:#888}}
    .connect code{{display:block;background:rgba(124,58,237,.1);border:1px solid rgba(124,58,237,.2);border-radius:8px;padding:10px;margin:12px 0;font-family:'JetBrains Mono',monospace;font-size:13px;color:#a78bfa;word-break:break-all}}
    .connect a{{color:#7c3aed;text-decoration:none}}
    .connect a:hover{{text-decoration:underline}}
    .mono{{font-family:'JetBrains Mono',monospace;font-size:11px}}
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo-icon">
        <svg viewBox="0 0 201.4 318.7" xmlns="http://www.w3.org/2000/svg">
          <g transform="translate(-137.9,-110.75)"><path d="{logo_path}"/></g>
        </svg>
      </div>
      <div class="logo-text">nos<span>trito</span></div>
      <div class="subtitle">Your Personal Nostr Relay</div>
      <div class="status"><span class="dot"></span> Live &mdash; {ws_scheme}://localhost:{port}</div>
    </div>

    <div class="stats">
      <div class="stat"><div class="stat-val">{event_count}</div><div class="stat-lbl">Events</div></div>
      <div class="stat"><div class="stat-val">{db_size}</div><div class="stat-lbl">Storage</div></div>
      <div class="stat"><div class="stat-val">{recent_events}</div><div class="stat-lbl">Last 24h</div></div>
    </div>

    <div class="card">
      <div class="card-title">Relay Info</div>
      <div class="row"><span class="label">Name</span><span class="value">nostrito relay</span></div>
      <div class="row"><span class="label">Description</span><span class="value">Your personal Nostr relay, running locally.</span></div>
      <div class="row"><span class="label">Pubkey</span><span class="value mono">{pubkey_display}</span></div>
      <div class="row"><span class="label">Port</span><span class="value">{port}</span></div>
    </div>

    <div class="card">
      <div class="card-title">Supported NIPs</div>
      <div class="nips">
        <span class="nip">NIP-01</span>
        <span class="nip">NIP-02</span>
        <span class="nip">NIP-09</span>
        <span class="nip">NIP-11</span>
        <span class="nip">NIP-16</span>
        <span class="nip">NIP-20</span>
        <span class="nip">NIP-33</span>
        <span class="nip">NIP-40</span>
        <span class="nip">NIP-45</span>
      </div>
    </div>

    <div class="connect">
      Connect with any Nostr client
      <code>{ws_scheme}://localhost:{port}</code>
      Works with Damus, Amethyst, Primal, and more.
      <br><br>
      <a href="https://nostrito.com">nostrito.com &rarr;</a>
    </div>
  </div>
</body>
</html>"#,
            logo_path = NOSTRITO_LOGO_PATH,
            ws_scheme = ws_scheme,
            port = port,
            pubkey_display = pubkey_display,
            event_count = event_count_display,
            db_size = db_size_display,
            recent_events = recent_display,
        );

        let response = format!(
            "HTTP/1.1 200 OK\r\n\
             Content-Type: text/html; charset=utf-8\r\n\
             Access-Control-Allow-Origin: *\r\n\
             Content-Length: {}\r\n\
             Connection: close\r\n\
             \r\n\
             {}",
            body.len(),
            body
        );
        stream.write_all(response.as_bytes()).await?;
    }

    stream.shutdown().await?;
    info!("[relay] Served NIP-11 info page");
    Ok(())
}

async fn handle_connection(
    stream: TcpStream,
    addr: SocketAddr,
    db: Arc<Database>,
    allowed_pubkey: Option<String>,
    broadcast_tx: EventBroadcast,
    mut broadcast_rx: broadcast::Receiver<StoredEvent>,
    cancel: tokio_util::sync::CancellationToken,
    outbound_tx: Option<OutboundEventSender>,
) -> Result<()> {
    let ws_stream = tokio_tungstenite::accept_async(stream).await?;
    info!("[relay] New connection from {}", addr);

    let (mut ws_tx, mut ws_rx) = ws_stream.split();
    let subscriptions: Arc<RwLock<HashMap<String, Subscription>>> =
        Arc::new(RwLock::new(HashMap::new()));

    let subs_clone = subscriptions.clone();

    // Channel to forward broadcast events back to the WebSocket sender
    let (fwd_tx, mut fwd_rx) = mpsc::channel::<String>(256);

    // Task to forward broadcast events to matching subscriptions
    let forward_task = tokio::spawn(async move {
        loop {
            match broadcast_rx.recv().await {
                Ok(event) => {
                    let subs = subs_clone.read().await;
                    for (sub_id, sub) in subs.iter() {
                        if sub.filters.iter().any(|f| f.matches_event(&event)) {
                            let msg = serde_json::json!(["EVENT", sub_id, event.to_json()]);
                            if fwd_tx.send(msg.to_string()).await.is_err() {
                                return;
                            }
                        }
                    }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    warn!("Broadcast lagged by {} messages", n);
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    // Main message loop
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            Some(fwd_msg) = fwd_rx.recv() => {
                if ws_tx.send(Message::Text(fwd_msg.into())).await.is_err() {
                    break;
                }
            }
            msg = ws_rx.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        let responses = handle_message(
                            &text,
                            &db,
                            &subscriptions,
                            &allowed_pubkey,
                            &broadcast_tx,
                            &outbound_tx,
                        ).await;
                        for resp in responses {
                            if ws_tx.send(Message::Text(resp.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Some(Ok(Message::Ping(data))) => {
                        ws_tx.send(Message::Pong(data)).await.ok();
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(e)) => {
                        debug!("WebSocket error from {}: {}", addr, e);
                        break;
                    }
                    _ => {}
                }
            }
        }
    }

    forward_task.abort();
    info!("[relay] Connection from {} closed", addr);
    Ok(())
}

async fn handle_message(
    text: &str,
    db: &Database,
    subscriptions: &RwLock<HashMap<String, Subscription>>,
    allowed_pubkey: &Option<String>,
    broadcast_tx: &EventBroadcast,
    outbound_tx: &Option<OutboundEventSender>,
) -> Vec<String> {
    let parsed: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => {
            return vec![serde_json::json!(["NOTICE", "invalid JSON"]).to_string()];
        }
    };

    let arr = match parsed.as_array() {
        Some(a) if !a.is_empty() => a,
        _ => {
            return vec![serde_json::json!(["NOTICE", "expected JSON array"]).to_string()];
        }
    };

    let msg_type = match arr[0].as_str() {
        Some(s) => s,
        None => {
            return vec![serde_json::json!(["NOTICE", "first element must be a string"]).to_string()];
        }
    };

    debug!("[relay] Message type={}", msg_type);
    match msg_type {
        "EVENT" => handle_event(arr, db, allowed_pubkey, broadcast_tx, outbound_tx).await,
        "REQ" => handle_req(arr, db, subscriptions).await,
        "CLOSE" => handle_close(arr, subscriptions).await,
        "COUNT" => handle_count(arr, db).await,
        _ => {
            warn!("[relay] Unknown message type: {}", msg_type);
            vec![serde_json::json!(["NOTICE", format!("unknown message type: {}", msg_type)]).to_string()]
        }
    }
}

/// Check if a kind is replaceable (NIP-16): 0, 3, or 10000-19999
fn is_replaceable_kind(kind: u32) -> bool {
    kind == 0 || kind == 3 || (10000..20000).contains(&kind)
}

/// Check if a kind is parameterized replaceable (NIP-33): 30000-39999
fn is_parameterized_replaceable_kind(kind: u32) -> bool {
    (30000..40000).contains(&kind)
}

/// Extract the "d" tag value from event tags (for NIP-33)
fn get_d_tag(tags: &[Vec<String>]) -> String {
    tags.iter()
        .find(|t| t.len() >= 2 && t[0] == "d")
        .map(|t| t[1].clone())
        .unwrap_or_default()
}

async fn handle_event(
    arr: &[Value],
    db: &Database,
    allowed_pubkey: &Option<String>,
    broadcast_tx: &EventBroadcast,
    outbound_tx: &Option<OutboundEventSender>,
) -> Vec<String> {
    if arr.len() < 2 {
        return vec![serde_json::json!(["NOTICE", "EVENT requires an event object"]).to_string()];
    }

    let event_json = &arr[1];
    let event = match parse_event(event_json) {
        Some(e) => e,
        None => {
            return vec![serde_json::json!(["OK", "", false, "invalid: could not parse event"]).to_string()];
        }
    };

    info!("[relay] EVENT received: id={}… kind={} pubkey={}…", &event.id[..std::cmp::min(12, event.id.len())], event.kind, &event.pubkey[..std::cmp::min(8, event.pubkey.len())]);

    // Check write permission: allow owner pubkey + tracked profiles
    if let Some(ref allowed) = allowed_pubkey {
        if event.pubkey != *allowed {
            let is_tracked = db.is_tracked(&event.pubkey).unwrap_or(false);
            if !is_tracked {
                warn!("[relay] EVENT rejected: pubkey not allowed (not owner or tracked)");
                return vec![serde_json::json!(["OK", event.id, false, "restricted: write not allowed"]).to_string()];
            }
            info!("[relay] EVENT accepted from tracked profile: pubkey={}…", &event.pubkey[..std::cmp::min(8, event.pubkey.len())]);
        }
    }

    // NIP-40: Reject events that are already expired
    if let Some(exp_tag) = event.tags.iter().find(|t| t.len() >= 2 && t[0] == "expiration") {
        if let Ok(exp_ts) = exp_tag[1].parse::<i64>() {
            let now = chrono::Utc::now().timestamp();
            if exp_ts <= now {
                info!("[relay] EVENT rejected: already expired");
                return vec![serde_json::json!(["OK", event.id, false, "invalid: event has expired"]).to_string()];
            }
        }
    }

    // NIP-09: Handle deletion events (kind 5)
    if event.kind == 5 {
        let event_id = event.id.clone();
        let ids_to_delete: Vec<&str> = event.tags.iter()
            .filter(|t| t.len() >= 2 && t[0] == "e")
            .map(|t| t[1].as_str())
            .collect();

        if !ids_to_delete.is_empty() {
            match db.delete_events_by_ids_and_pubkey(&ids_to_delete, &event.pubkey) {
                Ok(n) => info!("[relay] NIP-09: deleted {} events", n),
                Err(e) => error!("[relay] NIP-09 delete error: {}", e),
            }
        }

        // Store the deletion event itself
        match store_event(db, &event) {
            Ok(_) => {
                let outbound_json = event.to_json().to_string();
                broadcast_tx.send(event).ok();
                if let Some(ref tx) = outbound_tx {
                    tx.send(outbound_json).ok();
                }
                vec![serde_json::json!(["OK", event_id, true, ""]).to_string()]
            }
            Err(e) => {
                vec![serde_json::json!(["OK", event_id, false, format!("error: {}", e)]).to_string()]
            }
        }
    } else if is_replaceable_kind(event.kind) {
        // NIP-16: Replaceable events — keep only the latest per pubkey+kind
        let event_id = event.id.clone();
        let tags_json = serde_json::to_string(&event.tags).unwrap_or_default();
        match db.store_replaceable_event(
            &event.id, &event.pubkey, event.created_at as i64,
            event.kind, &tags_json, &event.content, &event.sig,
        ) {
            Ok(true) => {
                info!("[relay] EVENT stored (replaceable): id={}…", &event_id[..std::cmp::min(12, event_id.len())]);
                let outbound_json = event.to_json().to_string();
                broadcast_tx.send(event).ok();
                if let Some(ref tx) = outbound_tx {
                    tx.send(outbound_json).ok();
                }
                vec![serde_json::json!(["OK", event_id, true, ""]).to_string()]
            }
            Ok(false) => {
                debug!("[relay] EVENT replaced/duplicate: id={}…", &event_id[..std::cmp::min(12, event_id.len())]);
                vec![serde_json::json!(["OK", event_id, true, "duplicate: have newer event"]).to_string()]
            }
            Err(e) => {
                error!("[relay] EVENT store error: {}", e);
                vec![serde_json::json!(["OK", event_id, false, format!("error: {}", e)]).to_string()]
            }
        }
    } else if is_parameterized_replaceable_kind(event.kind) {
        // NIP-33: Parameterized replaceable events — keep only the latest per pubkey+kind+d-tag
        let event_id = event.id.clone();
        let d_tag = get_d_tag(&event.tags);
        let tags_json = serde_json::to_string(&event.tags).unwrap_or_default();
        match db.store_parameterized_replaceable_event(
            &event.id, &event.pubkey, event.created_at as i64,
            event.kind, &tags_json, &event.content, &event.sig, &d_tag,
        ) {
            Ok(true) => {
                info!("[relay] EVENT stored (param-replaceable d={}): id={}…", d_tag, &event_id[..std::cmp::min(12, event_id.len())]);
                let outbound_json = event.to_json().to_string();
                broadcast_tx.send(event).ok();
                if let Some(ref tx) = outbound_tx {
                    tx.send(outbound_json).ok();
                }
                vec![serde_json::json!(["OK", event_id, true, ""]).to_string()]
            }
            Ok(false) => {
                debug!("[relay] EVENT replaced/duplicate: id={}…", &event_id[..std::cmp::min(12, event_id.len())]);
                vec![serde_json::json!(["OK", event_id, true, "duplicate: have newer event"]).to_string()]
            }
            Err(e) => {
                error!("[relay] EVENT store error: {}", e);
                vec![serde_json::json!(["OK", event_id, false, format!("error: {}", e)]).to_string()]
            }
        }
    } else {
        // Regular event storage
        let event_id = event.id.clone();
        match store_event(db, &event) {
            Ok(true) => {
                info!("[relay] EVENT stored: id={}…", &event_id[..std::cmp::min(12, event_id.len())]);
                let outbound_json = event.to_json().to_string();
                broadcast_tx.send(event).ok();
                if let Some(ref tx) = outbound_tx {
                    tx.send(outbound_json).ok();
                }
                vec![serde_json::json!(["OK", event_id, true, ""]).to_string()]
            }
            Ok(false) => {
                debug!("[relay] EVENT duplicate: id={}…", &event_id[..std::cmp::min(12, event_id.len())]);
                vec![serde_json::json!(["OK", event_id, true, "duplicate: already have this event"]).to_string()]
            }
            Err(e) => {
                error!("[relay] EVENT store error: {}", e);
                vec![serde_json::json!(["OK", event_id, false, format!("error: {}", e)]).to_string()]
            }
        }
    }
}

async fn handle_req(
    arr: &[Value],
    db: &Database,
    subscriptions: &RwLock<HashMap<String, Subscription>>,
) -> Vec<String> {
    if arr.len() < 3 {
        return vec![serde_json::json!(["NOTICE", "REQ requires subscription_id and at least one filter"]).to_string()];
    }

    let sub_id = match arr[1].as_str() {
        Some(s) => s.to_string(),
        None => {
            return vec![serde_json::json!(["NOTICE", "subscription_id must be a string"]).to_string()];
        }
    };

    let mut filters = Vec::new();
    for filter_val in &arr[2..] {
        if let Some(f) = RelayFilter::from_json(filter_val) {
            filters.push(f);
        }
    }

    if filters.is_empty() {
        return vec![serde_json::json!(["NOTICE", "no valid filters"]).to_string()];
    }

    info!("[relay] REQ: sub_id={}, {} filters", sub_id, filters.len());
    for (i, f) in filters.iter().enumerate() {
        debug!("[relay] REQ filter[{}]: authors={:?}, kinds={:?}, since={:?}, until={:?}, limit={:?}", i, f.authors.as_ref().map(|a| a.len()), f.kinds, f.since, f.until, f.limit);
    }

    // Query events from DB
    let mut responses = Vec::new();
    let events = query_events(db, &filters);

    info!("[relay] Sending {} events for subscription {}", events.len(), sub_id);

    for event in events {
        let msg = serde_json::json!(["EVENT", sub_id, event.to_json()]);
        responses.push(msg.to_string());
    }

    // Send EOSE
    responses.push(serde_json::json!(["EOSE", sub_id]).to_string());

    // Store subscription for future events
    let sub = Subscription { filters };
    subscriptions.write().await.insert(sub_id, sub);

    responses
}

async fn handle_close(
    arr: &[Value],
    subscriptions: &RwLock<HashMap<String, Subscription>>,
) -> Vec<String> {
    if arr.len() < 2 {
        return vec![serde_json::json!(["NOTICE", "CLOSE requires subscription_id"]).to_string()];
    }

    if let Some(sub_id) = arr[1].as_str() {
        subscriptions.write().await.remove(sub_id);
        info!("[relay] CLOSE: sub_id={}", sub_id);
    }

    vec![]
}

/// NIP-45: Handle COUNT message
async fn handle_count(
    arr: &[Value],
    db: &Database,
) -> Vec<String> {
    if arr.len() < 3 {
        return vec![serde_json::json!(["NOTICE", "COUNT requires subscription_id and at least one filter"]).to_string()];
    }

    let sub_id = match arr[1].as_str() {
        Some(s) => s.to_string(),
        None => {
            return vec![serde_json::json!(["NOTICE", "subscription_id must be a string"]).to_string()];
        }
    };

    let mut total: u64 = 0;
    for filter_val in &arr[2..] {
        if let Some(f) = RelayFilter::from_json(filter_val) {
            match db.count_events(
                f.ids.as_deref(),
                f.authors.as_deref(),
                f.kinds.as_deref(),
                f.since,
                f.until,
            ) {
                Ok(count) => total += count,
                Err(e) => {
                    error!("[relay] COUNT query error: {}", e);
                }
            }
        }
    }

    info!("[relay] COUNT: sub_id={}, count={}", sub_id, total);
    vec![serde_json::json!(["COUNT", sub_id, {"count": total}]).to_string()]
}

fn parse_event(val: &Value) -> Option<StoredEvent> {
    let obj = val.as_object()?;
    Some(StoredEvent {
        id: obj.get("id")?.as_str()?.to_string(),
        pubkey: obj.get("pubkey")?.as_str()?.to_string(),
        created_at: obj.get("created_at")?.as_u64()?,
        kind: obj.get("kind")?.as_u64()? as u32,
        tags: obj.get("tags")?.as_array()?.iter().map(|t| {
            t.as_array()
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default()
        }).collect(),
        content: obj.get("content")?.as_str()?.to_string(),
        sig: obj.get("sig")?.as_str()?.to_string(),
    })
}

fn store_event(db: &Database, event: &StoredEvent) -> Result<bool> {
    let tags_json = serde_json::to_string(&event.tags)?;
    db.store_event(
        &event.id,
        &event.pubkey,
        event.created_at as i64,
        event.kind,
        &tags_json,
        &event.content,
        &event.sig,
    )
}

fn query_events(db: &Database, filters: &[RelayFilter]) -> Vec<StoredEvent> {
    let mut all_events = Vec::new();

    for filter in filters {
        match db.query_events(
            filter.ids.as_deref(),
            filter.authors.as_deref(),
            filter.kinds.as_deref(),
            filter.since,
            filter.until,
            filter.limit.unwrap_or(500),
        ) {
            Ok(events) => {
                for (id, pubkey, created_at, kind, tags_json, content, sig) in events {
                    let tags: Vec<Vec<String>> =
                        serde_json::from_str(&tags_json).unwrap_or_default();
                    let event = StoredEvent {
                        id,
                        pubkey,
                        created_at: created_at as u64,
                        kind: kind as u32,
                        tags,
                        content,
                        sig,
                    };
                    // Apply tag filters in-memory
                    if filter.tag_filters.is_empty() || filter.matches_event(&event) {
                        all_events.push(event);
                    }
                }
            }
            Err(e) => {
                error!("Failed to query events: {}", e);
            }
        }
    }

    all_events
}
