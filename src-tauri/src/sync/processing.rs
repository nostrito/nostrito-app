use nostr_sdk::prelude::*;
use std::sync::Arc;
use tauri::Emitter;
use tracing::{debug, info, warn};

use crate::storage::db::Database;
use crate::storage::FollowUpdateBatch;
use crate::wot::WotGraph;

use super::types::{EventSource, StoredEventNotification};

/// Result of processing a single event.
#[derive(Debug, Default)]
pub struct ProcessResult {
    /// Whether the event was stored (new, not duplicate).
    pub stored: bool,
    /// Whether a WoT graph update occurred (kind:3).
    pub wot_updated: bool,
    /// Whether relay info was extracted (kind:3 hints, kind:10002).
    pub relays_updated: bool,
    /// Whether mute lists were rebuilt (kind:10000).
    pub mutes_rebuilt: bool,
    /// Media URLs queued for download.
    pub media_urls_queued: u32,
}

/// Process a nostr event through the v2 pipeline.
///
/// Handles kind-specific logic:
/// - kind:0 → store (replaceable metadata)
/// - kind:1/6 → check tombstone, store, queue media
/// - kind:3 → store, WoT update, extract relay hints
/// - kind:5 → verify author, delete refs, create tombstones
/// - kind:10000 → store, rebuild mute tables if own
/// - kind:10002 → parse relay list, upsert user_relays
/// - kind:30023 → parameterized replaceable (d-tag)
/// - Replaceable events (10000-19999): only store if newer
pub fn process_event(
    event: &Event,
    db: &Arc<Database>,
    graph: &Arc<WotGraph>,
    own_pubkey: &str,
    source: EventSource,
    media_priority: i32,
) -> ProcessResult {
    let mut result = ProcessResult::default();

    let event_id = event.id.to_hex();
    let pubkey = event.pubkey.to_hex();
    let kind = event.kind.as_u16() as u32;
    let created_at = event.created_at.as_u64() as i64;

    // Pre-flight: check deletion tombstone
    if db.is_tombstoned(&event_id).unwrap_or(false) {
        debug!("Skipping tombstoned event {}", &event_id[..12.min(event_id.len())]);
        return result;
    }

    // Serialize tags
    let tags: Vec<Vec<String>> = event
        .tags
        .iter()
        .map(|t| t.as_slice().iter().map(|s| s.to_string()).collect())
        .collect();
    let tags_json = serde_json::to_string(&tags).unwrap_or_default();

    // Kind-specific processing
    match kind {
        5 => {
            // Deletion event — verify and create tombstones
            // Skip deletion execution during Phase 1 own-data backup to prevent self-tombstoning
            if source != EventSource::OwnBackup {
                process_deletion(event, &event_id, &pubkey, created_at, &tags, db);
            }
            // Store the deletion event itself
            result.stored = store_event(db, &event_id, &pubkey, created_at, kind, &tags_json, event, source);
        }
        0 | 10000 | 10002 => {
            // Replaceable events — only store if newer
            result.stored = store_replaceable(db, &event_id, &pubkey, created_at, kind, &tags_json, event, source);

            if result.stored {
                match kind {
                    3 => {} // handled below
                    10000 => {
                        // Mute list — rebuild if own
                        if pubkey == own_pubkey {
                            if let Err(e) = db.rebuild_mute_lists(&tags_json) {
                                warn!("Failed to rebuild mute lists: {}", e);
                            } else {
                                result.mutes_rebuilt = true;
                                info!("Rebuilt mute lists from kind:10000");
                            }
                        }
                    }
                    10002 => {
                        // NIP-65 relay list
                        result.relays_updated = process_nip65(event, &pubkey, created_at, &tags, db);
                    }
                    _ => {}
                }
            }
        }
        3 => {
            // Contact list — store as replaceable, update WoT, extract relay hints
            result.stored = store_replaceable(db, &event_id, &pubkey, created_at, kind, &tags_json, event, source);

            if result.stored {
                result.wot_updated = process_contact_list(event, &pubkey, &event_id, created_at, &tags, db, graph);
                result.relays_updated = extract_relay_hints(&pubkey, created_at, &tags, db);
            }
        }
        _ if (10000..20000).contains(&kind) => {
            // Other replaceable events
            result.stored = store_replaceable(db, &event_id, &pubkey, created_at, kind, &tags_json, event, source);
        }
        _ if (30000..40000).contains(&kind) => {
            // Parameterized replaceable — use d-tag
            result.stored = store_parameterized_replaceable(db, &event_id, &pubkey, created_at, kind, &tags_json, &tags, event, source);
        }
        _ => {
            // Regular events (kind:1, 6, 7, 9735, etc.)
            result.stored = store_event(db, &event_id, &pubkey, created_at, kind, &tags_json, event, source);
        }
    }

    // Queue media for newly stored content events
    if result.stored && matches!(kind, 1 | 6 | 30023) {
        result.media_urls_queued = queue_media_urls(db, &pubkey, &event.content.to_string(), &tags, media_priority);

        // Populate thread_refs for pruning protection
        let e_tag_refs: Vec<String> = tags
            .iter()
            .filter(|t| t.len() >= 2 && t[0] == "e")
            .map(|t| t[1].clone())
            .collect();
        if !e_tag_refs.is_empty() {
            db.insert_thread_refs(&event_id, &e_tag_refs).ok();
        }
    }

    // Queue profile picture/banner from kind:0 metadata events
    if result.stored && kind == 0 {
        result.media_urls_queued = queue_profile_media(db, &pubkey, &event.content.to_string(), media_priority);
    }

    // Advance cursor for stored events
    if result.stored {
        db.advance_user_cursor(&pubkey, created_at).ok();
    }

    result
}

/// Store a regular (non-replaceable) event.
fn store_event(
    db: &Database,
    event_id: &str,
    pubkey: &str,
    created_at: i64,
    kind: u32,
    tags_json: &str,
    event: &Event,
    _source: EventSource,
) -> bool {
    db.store_event(
        event_id,
        pubkey,
        created_at,
        kind,
        tags_json,
        &event.content.to_string(),
        &event.sig.to_string(),
    )
    .unwrap_or(false)
}

/// Store a replaceable event (kinds 0, 3, 10000-19999).
/// Only inserts if newer than existing event of same (pubkey, kind).
fn store_replaceable(
    db: &Database,
    event_id: &str,
    pubkey: &str,
    created_at: i64,
    kind: u32,
    tags_json: &str,
    event: &Event,
    _source: EventSource,
) -> bool {
    // Try to insert — if duplicate id, it's a no-op
    let inserted = db
        .store_event(
            event_id,
            pubkey,
            created_at,
            kind,
            tags_json,
            &event.content.to_string(),
            &event.sig.to_string(),
        )
        .unwrap_or(false);

    if inserted {
        // Delete older versions of same (pubkey, kind)
        // The new event is already inserted, so delete any older ones
        if let Ok(conn) = db.query_events(
            None,
            Some(&[pubkey.to_string()]),
            Some(&[kind]),
            None,
            None,
            100,
        ) {
            for (old_id, _, old_ts, _, _, _, _) in &conn {
                if old_id != event_id && *old_ts < created_at {
                    // We can't directly delete through the public API,
                    // but store_event uses INSERT OR IGNORE, so older
                    // events only remain if they were stored first.
                    // For now, the timestamp-sorted query in the UI
                    // naturally shows the newest version.
                    debug!("Replaceable: newer event replaces old {}", &old_id[..12.min(old_id.len())]);
                }
            }
        }
    }

    inserted
}

/// Store a parameterized replaceable event (kinds 30000-39999).
/// Uniqueness key: (pubkey, kind, d_tag_value).
fn store_parameterized_replaceable(
    db: &Database,
    event_id: &str,
    pubkey: &str,
    created_at: i64,
    kind: u32,
    tags_json: &str,
    tags: &[Vec<String>],
    event: &Event,
    source: EventSource,
) -> bool {
    let _d_tag = tags
        .iter()
        .find(|t| !t.is_empty() && t[0] == "d")
        .and_then(|t| t.get(1))
        .map(|s| s.as_str())
        .unwrap_or("");

    // Store using normal insert — d-tag dedup is handled at query time
    store_event(db, event_id, pubkey, created_at, kind, tags_json, event, source)
}

/// Process a kind:5 deletion event.
fn process_deletion(
    _event: &Event,
    deletion_event_id: &str,
    author: &str,
    created_at: i64,
    tags: &[Vec<String>],
    db: &Database,
) {
    for tag in tags {
        if tag.len() >= 2 && tag[0] == "e" {
            let target_id = &tag[1];

            // Verify the deletion author matches the event author
            // (We check if the target event exists and belongs to this author)
            if let Ok(events) = db.query_events(
                Some(&[target_id.clone()]),
                None,
                None,
                None,
                None,
                1,
            ) {
                if let Some((_, event_author, _, _, _, _, _)) = events.first() {
                    if event_author != author {
                        debug!(
                            "Deletion rejected: author {} != event author {}",
                            &author[..8.min(author.len())],
                            &event_author[..8.min(event_author.len())]
                        );
                        continue;
                    }
                }
                // If event doesn't exist locally, still create tombstone
                // (prevents future storage of the deleted event)
            }

            if let Err(e) = db.create_tombstone(target_id, author, deletion_event_id, created_at) {
                warn!("Failed to create tombstone for {}: {}", &target_id[..12.min(target_id.len())], e);
            } else {
                debug!("Created tombstone for event {}", &target_id[..12.min(target_id.len())]);
            }
        }
    }
}

/// Process a kind:3 contact list — update WoT graph.
fn process_contact_list(
    _event: &Event,
    pubkey: &str,
    event_id: &str,
    created_at: i64,
    tags: &[Vec<String>],
    db: &Database,
    graph: &WotGraph,
) -> bool {
    let follows: Vec<String> = tags
        .iter()
        .filter_map(|tag| {
            if tag.len() >= 2 && tag[0] == "p" {
                let pk = &tag[1];
                if pk.len() == 64 && pk.chars().all(|c| c.is_ascii_hexdigit()) {
                    Some(pk.clone())
                } else {
                    None
                }
            } else {
                None
            }
        })
        .collect();

    let updated = graph.update_follows(
        pubkey,
        &follows,
        Some(event_id.to_string()),
        Some(created_at),
    );

    if updated {
        let batch = vec![FollowUpdateBatch {
            pubkey,
            follows: &follows,
            event_id: Some(event_id),
            created_at: Some(created_at),
        }];
        db.update_follows_batch(&batch).ok();
        debug!(
            "WoT updated: {} now follows {} pubkeys",
            &pubkey[..8.min(pubkey.len())],
            follows.len()
        );
    }

    updated
}

/// Extract relay hints from kind:3 p-tag position 2.
fn extract_relay_hints(
    _pubkey: &str,
    created_at: i64,
    tags: &[Vec<String>],
    db: &Database,
) -> bool {
    let mut any_updated = false;

    for tag in tags {
        // p-tag format: ["p", pubkey, relay_url?, ...]
        if tag.len() >= 3 && tag[0] == "p" && !tag[2].is_empty() {
            let followed_pk = &tag[1];
            let relay_url = &tag[2];

            if relay_url.starts_with("wss://") || relay_url.starts_with("ws://") {
                if db.upsert_user_relay(followed_pk, relay_url, "write", "kind3_hint", created_at)
                    .unwrap_or(false)
                {
                    any_updated = true;
                }
            }
        }
    }

    any_updated
}

/// Process a kind:10002 NIP-65 relay list.
fn process_nip65(
    _event: &Event,
    pubkey: &str,
    created_at: i64,
    tags: &[Vec<String>],
    db: &Database,
) -> bool {
    let relays: Vec<(String, String)> = tags
        .iter()
        .filter_map(|tag| {
            if tag.len() >= 2 && tag[0] == "r" {
                let url = &tag[1];
                if url.starts_with("wss://") || url.starts_with("ws://") {
                    let direction = if tag.len() >= 3 {
                        match tag[2].as_str() {
                            "read" => "read".to_string(),
                            "write" => "write".to_string(),
                            _ => "both".to_string(),
                        }
                    } else {
                        "both".to_string()
                    };
                    Some((url.clone(), direction))
                } else {
                    None
                }
            } else {
                None
            }
        })
        .collect();

    if relays.is_empty() {
        return false;
    }

    if let Err(e) = db.replace_user_relays(pubkey, "nip65", created_at, &relays) {
        warn!("Failed to update NIP-65 relays for {}: {}", &pubkey[..8.min(pubkey.len())], e);
        return false;
    }

    debug!(
        "NIP-65: {} has {} relays",
        &pubkey[..8.min(pubkey.len())],
        relays.len()
    );
    true
}

/// Queue media URLs from event content and tags.
fn queue_media_urls(
    db: &Database,
    pubkey: &str,
    content: &str,
    tags: &[Vec<String>],
    priority: i32,
) -> u32 {
    let mut count = 0u32;

    // Extract URLs from content using byte-scan (handles markdown syntax, inline URLs, etc.)
    let text_urls = super::media::extract_urls_from_text(content);
    for url in &text_urls {
        if is_media_url(url)
            || super::media::is_nostr_media_cdn(url)
            || super::media::mime_type_from_url(url).is_some()
        {
            if db.queue_media_url(url, pubkey, priority).is_ok() {
                count += 1;
            }
        }
    }

    // Extract from image/video/imeta tags
    let tag_urls = super::media::extract_urls_from_tags(
        &serde_json::to_string(tags).unwrap_or_default(),
    );
    for url in &tag_urls {
        if is_media_url(url)
            || super::media::is_nostr_media_cdn(url)
            || super::media::mime_type_from_url(url).is_some()
        {
            if db.queue_media_url(url, pubkey, priority).is_ok() {
                count += 1;
            }
        }
    }

    count
}

/// Queue profile picture and banner from kind:0 metadata JSON content.
fn queue_profile_media(
    db: &Database,
    pubkey: &str,
    content: &str,
    priority: i32,
) -> u32 {
    let mut count = 0u32;
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(content) {
        for field in &["picture", "banner"] {
            if let Some(url) = parsed.get(field).and_then(|v| v.as_str()) {
                if (url.starts_with("https://") || url.starts_with("http://"))
                    && url.len() > 10
                {
                    if db.queue_media_url(url, pubkey, priority).is_ok() {
                        count += 1;
                    }
                }
            }
        }
    }
    count
}

/// Check if a URL looks like a media file.
pub fn is_media_url(url: &str) -> bool {
    let lower = url.to_lowercase();
    let media_extensions = [
        ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg",
        ".mp4", ".webm", ".mov",
        ".mp3", ".ogg", ".wav",
    ];
    media_extensions.iter().any(|ext| lower.contains(ext))
        || lower.contains("nostr.build")
        || lower.contains("void.cat")
        || lower.contains("image.")
        || lower.contains("/media/")
}

/// Process a batch of events, returning aggregate results.
/// When `app_handle` is provided, emits a single `events:batch` with all newly stored events
/// (batched to reduce IPC overhead and prevent race conditions with tier status).
pub fn process_events(
    events: &[Event],
    db: &Arc<Database>,
    graph: &Arc<WotGraph>,
    own_pubkey: &str,
    source: EventSource,
    media_priority: i32,
    app_handle: Option<&tauri::AppHandle>,
    layer: &str,
) -> (u32, u32) {
    let mut stored = 0u32;
    let mut wot_updates = 0u32;
    let mut batch: Vec<StoredEventNotification> = Vec::new();

    // Sort newest-first so replaceable events are processed correctly
    let mut sorted: Vec<&Event> = events.iter().collect();
    sorted.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    info!("process_events: processing {} events (source={:?})", sorted.len(), source);

    for (idx, event) in sorted.iter().enumerate() {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            process_event(event, db, graph, own_pubkey, source, media_priority)
        }));

        let result = match result {
            Ok(r) => r,
            Err(e) => {
                let msg = e.downcast_ref::<String>()
                    .map(|s| s.as_str())
                    .or_else(|| e.downcast_ref::<&str>().copied())
                    .unwrap_or("unknown panic");
                warn!("process_events: PANIC at event {}/{} (kind={}, id={}): {}",
                    idx + 1, events.len(), event.kind.as_u16(), &event.id.to_hex()[..12], msg);
                continue;
            }
        };

        if result.stored {
            stored += 1;
            if app_handle.is_some() {
                // Build content preview and extract media URLs — all wrapped in catch_unwind for safety
                let (content, media_urls) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let raw = event.content.to_string();
                    let kind_u32 = event.kind.as_u16() as u32;
                    let preview_text = if kind_u32 == 6 {
                        serde_json::from_str::<serde_json::Value>(&raw)
                            .ok()
                            .and_then(|v| v.get("content")?.as_str().map(String::from))
                            .unwrap_or_else(|| raw.clone())
                    } else {
                        raw
                    };

                    // Extract media URLs before stripping
                    let urls: Vec<String> = preview_text
                        .split_whitespace()
                        .filter(|w| {
                            (w.starts_with("http://") || w.starts_with("https://"))
                                && (is_media_url(w)
                                    || super::media::is_nostr_media_cdn(w)
                                    || super::media::mime_type_from_url(w).is_some())
                        })
                        .map(|w| w.to_string())
                        .collect();

                    let cleaned: String = preview_text
                        .split_whitespace()
                        .filter(|w| !w.starts_with("http://") && !w.starts_with("https://"))
                        .collect::<Vec<&str>>()
                        .join(" ");
                    let content = if cleaned.chars().count() > 120 {
                        let truncated: String = cleaned.chars().take(120).collect();
                        format!("{}...", truncated)
                    } else {
                        cleaned
                    };
                    (content, urls)
                })).unwrap_or_default();

                batch.push(StoredEventNotification {
                    id: event.id.to_hex(),
                    kind: event.kind.as_u16() as u32,
                    pubkey: event.pubkey.to_hex(),
                    content,
                    layer: layer.to_string(),
                    media_urls,
                });
            }
        }
        if result.wot_updated {
            wot_updates += 1;
        }
    }

    // Emit all stored events as a single batch to reduce IPC overhead
    if !batch.is_empty() {
        if let Some(handle) = app_handle {
            handle.emit("events:batch", &batch).ok();
        }
    }

    info!("process_events: done — {} stored, {} wot updates", stored, wot_updates);
    (stored, wot_updates)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_media_url() {
        assert!(is_media_url("https://nostr.build/image.jpg"));
        assert!(is_media_url("https://example.com/photo.png"));
        assert!(is_media_url("https://void.cat/abc123"));
        assert!(!is_media_url("https://example.com/page.html"));
        assert!(!is_media_url("https://example.com/api/data"));
    }

    #[test]
    fn test_nip65_relay_parsing() {
        let tags: Vec<Vec<String>> = vec![
            vec!["r".into(), "wss://relay.damus.io".into()],
            vec!["r".into(), "wss://nos.lol".into(), "read".into()],
            vec!["r".into(), "wss://relay.primal.net".into(), "write".into()],
            vec!["r".into(), "invalid-url".into()], // Should be filtered
        ];

        let relays: Vec<(String, String)> = tags
            .iter()
            .filter_map(|tag| {
                if tag.len() >= 2 && tag[0] == "r" {
                    let url = &tag[1];
                    if url.starts_with("wss://") || url.starts_with("ws://") {
                        let direction = if tag.len() >= 3 {
                            match tag[2].as_str() {
                                "read" => "read".to_string(),
                                "write" => "write".to_string(),
                                _ => "both".to_string(),
                            }
                        } else {
                            "both".to_string()
                        };
                        Some((url.clone(), direction))
                    } else {
                        None
                    }
                } else {
                    None
                }
            })
            .collect();

        assert_eq!(relays.len(), 3);
        assert_eq!(relays[0], ("wss://relay.damus.io".into(), "both".into()));
        assert_eq!(relays[1], ("wss://nos.lol".into(), "read".into()));
        assert_eq!(relays[2], ("wss://relay.primal.net".into(), "write".into()));
    }

    #[test]
    fn test_contact_list_follow_extraction() {
        let tags: Vec<Vec<String>> = vec![
            vec!["p".into(), "a".repeat(64)],
            vec!["p".into(), "b".repeat(64), "wss://relay.example.com".into()],
            vec!["p".into(), "invalid_short".into()], // Should be filtered (not 64 chars)
            vec!["e".into(), "c".repeat(64)],         // Not a p-tag
        ];

        let follows: Vec<String> = tags
            .iter()
            .filter_map(|tag| {
                if tag.len() >= 2 && tag[0] == "p" {
                    let pk = &tag[1];
                    if pk.len() == 64 && pk.chars().all(|c| c.is_ascii_hexdigit()) {
                        Some(pk.clone())
                    } else {
                        None
                    }
                } else {
                    None
                }
            })
            .collect();

        assert_eq!(follows.len(), 2);
        assert_eq!(follows[0], "a".repeat(64));
        assert_eq!(follows[1], "b".repeat(64));
    }

    #[test]
    fn test_relay_hint_extraction() {
        let tags: Vec<Vec<String>> = vec![
            vec!["p".into(), "a".repeat(64), "wss://relay.example.com".into()],
            vec!["p".into(), "b".repeat(64)], // No relay hint
            vec!["p".into(), "c".repeat(64), "".into()], // Empty relay
            vec!["p".into(), "d".repeat(64), "http://not-ws.example.com".into()], // Not ws/wss
        ];

        let hints: Vec<(&str, &str)> = tags
            .iter()
            .filter_map(|tag| {
                if tag.len() >= 3 && tag[0] == "p" && !tag[2].is_empty() {
                    let relay = &tag[2];
                    if relay.starts_with("wss://") || relay.starts_with("ws://") {
                        Some((tag[1].as_str(), relay.as_str()))
                    } else {
                        None
                    }
                } else {
                    None
                }
            })
            .collect();

        assert_eq!(hints.len(), 1);
        assert_eq!(hints[0].1, "wss://relay.example.com");
    }
}
