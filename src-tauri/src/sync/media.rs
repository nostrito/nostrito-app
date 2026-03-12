#![allow(dead_code)]
use anyhow::Result;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use tracing::{debug, info, warn};

use crate::storage::db::Database;

/// Phase 5: Media Download — process the media queue and enforce storage limits.
pub struct MediaDownloader {
    db: Arc<Database>,
    own_pubkey: String,
    tracked_limit_bytes: u64,
    wot_limit_bytes: u64,
    tracked_pubkeys: HashSet<String>,
}

impl MediaDownloader {
    pub fn new(db: Arc<Database>, own_pubkey: String, tracked_media_gb: f64, wot_media_gb: f64) -> Self {
        let tracked = db.get_tracked_pubkeys()
            .unwrap_or_default()
            .into_iter()
            .collect::<HashSet<String>>();
        Self {
            db,
            own_pubkey,
            tracked_limit_bytes: (tracked_media_gb * 1_073_741_824.0) as u64,
            wot_limit_bytes: (wot_media_gb * 1_073_741_824.0) as u64,
            tracked_pubkeys: tracked,
        }
    }

    /// Run the media download phase.
    pub async fn run(&self, batch_size: usize) -> Result<MediaStats> {
        let mut stats = MediaStats::default();

        // Dequeue URLs
        let urls = self.db.dequeue_media_urls(batch_size)?;
        if urls.is_empty() {
            return Ok(stats);
        }

        let http_client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()?;

        for (url, pubkey) in &urls {
            let hash = extract_sha256_from_url(url)
                .unwrap_or_else(|| sha256_of_string(url));

            if self.db.media_exists(&hash) {
                stats.skipped += 1;
                continue;
            }

            let bypass_limit = pubkey == &self.own_pubkey || self.tracked_pubkeys.contains(pubkey);
            match self.download_media(&http_client, url, &hash, pubkey, bypass_limit).await {
                Ok(true) => stats.downloaded += 1,
                Ok(false) => stats.skipped += 1,
                Err(e) => {
                    debug!("Media: failed to download {}: {}", url, e);
                    stats.failed += 1;
                }
            }
        }

        // Enforce storage limits per category
        self.enforce_tracked_media_limit().await;
        self.enforce_wot_media_limit().await;

        if stats.downloaded > 0 {
            info!(
                "Media: downloaded {}, skipped {}, failed {}",
                stats.downloaded, stats.skipped, stats.failed
            );
        }

        Ok(stats)
    }

    /// Download a single media file.
    async fn download_media(
        &self,
        client: &reqwest::Client,
        url: &str,
        hash: &str,
        pubkey: &str,
        bypass_limit: bool,
    ) -> Result<bool> {
        const MAX_FILE_SIZE: u64 = 50 * 1024 * 1024; // 50 MB

        // HEAD request for size/type hints
        let (content_length_hint, mime_hint) = match client.head(url).send().await {
            Ok(head) if head.status().is_success() => {
                let cl = head.headers().get("content-length")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok());
                let mime = head.headers().get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.split(';').next().unwrap_or(s).trim().to_lowercase());
                (cl, mime)
            }
            _ => (None, None),
        };

        // Pre-flight size check
        if let Some(cl) = content_length_hint {
            if cl > MAX_FILE_SIZE {
                return Ok(false);
            }
            if !bypass_limit {
                let used = self.db.media_others_bytes(&self.own_pubkey).unwrap_or(0);
                if used + cl > self.wot_limit_bytes {
                    return Ok(false);
                }
            } else if pubkey != &self.own_pubkey && self.tracked_pubkeys.contains(pubkey) {
                let used = self.db.media_tracked_bytes(&self.own_pubkey).unwrap_or(0);
                if used + cl > self.tracked_limit_bytes {
                    return Ok(false);
                }
            }
        }

        // GET
        let response = match client.get(url).send().await {
            Ok(r) if r.status().is_success() => r,
            _ => return Ok(false),
        };

        let response_mime = response.headers().get("content-type")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.split(';').next().unwrap_or(s).trim().to_lowercase());

        let mime = response_mime
            .or(mime_hint)
            .or_else(|| mime_type_from_url(url).map(|s| s.to_string()))
            .unwrap_or_else(|| {
                if is_nostr_media_cdn(url) { "image/jpeg".to_string() }
                else { "application/octet-stream".to_string() }
            });

        if !mime.starts_with("image/") && !mime.starts_with("video/") && !mime.starts_with("audio/") {
            return Ok(false);
        }

        let bytes = response.bytes().await?;
        let size_bytes = bytes.len() as u64;

        if size_bytes == 0 || size_bytes > MAX_FILE_SIZE {
            return Ok(false);
        }

        if !bypass_limit {
            let used = self.db.media_others_bytes(&self.own_pubkey).unwrap_or(0);
            if used + size_bytes > self.wot_limit_bytes {
                return Ok(false);
            }
        } else if pubkey != &self.own_pubkey && self.tracked_pubkeys.contains(pubkey) {
            let used = self.db.media_tracked_bytes(&self.own_pubkey).unwrap_or(0);
            if used + size_bytes > self.tracked_limit_bytes {
                return Ok(false);
            }
        }

        // Write to disk
        let file_path = media_file_path(hash);
        if let Some(parent) = file_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&file_path, &bytes).await?;

        self.db.store_media_record(hash, url, &mime, size_bytes, pubkey)?;

        debug!("Media: downloaded {} ({} bytes, {})", &hash[..12.min(hash.len())], size_bytes, mime);
        Ok(true)
    }

    /// Enforce tracked media storage limit — evict LRU tracked items if over 95%.
    async fn enforce_tracked_media_limit(&self) {
        let used = match self.db.media_tracked_bytes(&self.own_pubkey) {
            Ok(b) => b,
            Err(_) => return,
        };

        if used < (self.tracked_limit_bytes as f64 * 0.95) as u64 {
            return;
        }

        let target = (self.tracked_limit_bytes as f64 * 0.80) as u64;
        info!("Media(tracked): over 95% ({}/{}), evicting to 80%", used, self.tracked_limit_bytes);

        let candidates = self.db.media_list_lru_tracked(500, &self.own_pubkey).unwrap_or_default();
        let mut evicted: Vec<String> = Vec::new();
        let mut current = used;

        for (hash, size) in candidates {
            if current <= target { break; }
            let path = media_file_path(&hash);
            if let Err(e) = tokio::fs::remove_file(&path).await {
                warn!("Media: evict failed {:?}: {}", path, e);
            }
            evicted.push(hash);
            current = current.saturating_sub(size);
        }

        if !evicted.is_empty() {
            let freed = used - current;
            self.db.media_delete_records(&evicted).ok();
            info!("Media(tracked): evicted {} items, freed {} bytes", evicted.len(), freed);
        }
    }

    /// Enforce WoT media storage limit — evict LRU WoT items if over 95%.
    async fn enforce_wot_media_limit(&self) {
        let used = match self.db.media_others_bytes(&self.own_pubkey) {
            Ok(b) => b,
            Err(_) => return,
        };

        if used < (self.wot_limit_bytes as f64 * 0.95) as u64 {
            return;
        }

        let target = (self.wot_limit_bytes as f64 * 0.80) as u64;
        info!("Media(wot): over 95% ({}/{}), evicting to 80%", used, self.wot_limit_bytes);

        let candidates = self.db.media_list_lru_excluding_pubkey(500, &self.own_pubkey).unwrap_or_default();
        let mut evicted: Vec<String> = Vec::new();
        let mut current = used;

        for (hash, size) in candidates {
            if current <= target { break; }
            let path = media_file_path(&hash);
            if let Err(e) = tokio::fs::remove_file(&path).await {
                warn!("Media: evict failed {:?}: {}", path, e);
            }
            evicted.push(hash);
            current = current.saturating_sub(size);
        }

        if !evicted.is_empty() {
            let freed = used - current;
            self.db.media_delete_records(&evicted).ok();
            info!("Media(wot): evicted {} items, freed {} bytes", evicted.len(), freed);
        }
    }
}

// ── Media Helpers (extracted from engine.rs) ─────────────────────

/// FNV-1a hash as 64-char hex string for stable cache keys.
pub fn sha256_of_string(s: &str) -> String {
    const FNV_PRIME: u64 = 1099511628211;
    const FNV_BASIS: u64 = 14695981039346656037;
    let mut h1: u64 = FNV_BASIS;
    for b in s.bytes() {
        h1 ^= b as u64;
        h1 = h1.wrapping_mul(FNV_PRIME);
    }
    let mut h2: u64 = 0xcbf29ce484222325u64;
    for b in s.bytes().rev() {
        h2 ^= b as u64;
        h2 = h2.wrapping_mul(FNV_PRIME);
    }
    format!("{:016x}{:016x}{:032x}", h1, h2, 0u128)
}

/// Check if URL is from a known Nostr media CDN.
pub fn is_nostr_media_cdn(url: &str) -> bool {
    let lower = url.to_lowercase();
    lower.contains("void.cat/d/")
        || lower.contains("nostr.build/")
        || lower.contains("image.nostr.build/")
        || lower.contains("i.nostr.build/")
        || lower.contains("cdn.nostr.build/")
        || lower.contains("media.nostr.band/")
        || lower.contains("nostrimg.com/")
        || lower.contains("nostpic.com/")
        || lower.contains("blossom.band/")
        || lower.contains("blossom.primal.net/")
        || lower.contains("files.v0l.io/")
        || lower.contains("nostr.mtrr.me/")
        || lower.contains("cdn.satellite.earth/")
        || lower.contains("primal.b-cdn.net/")
        || lower.contains("m.primal.net/")
        || lower.contains("media.tenor.com/")
        || lower.contains("i.imgur.com/")
        || lower.contains("pbs.twimg.com/")
        || lower.contains("video.twimg.com/")
        || lower.contains("cdn.zaprite.com/")
}

/// Extract SHA256 hash from Blossom-style URLs (64-char hex in path).
pub fn extract_sha256_from_url(url: &str) -> Option<String> {
    let path = url.split('?').next()?;
    for segment in path.split('/') {
        let stem = segment.split('.').next().unwrap_or(segment);
        if stem.len() == 64 && stem.chars().all(|c| c.is_ascii_hexdigit()) {
            return Some(stem.to_lowercase());
        }
    }
    None
}

/// Detect MIME type from URL file extension.
pub fn mime_type_from_url(url: &str) -> Option<&'static str> {
    let path = url.split('?').next().unwrap_or(url).to_lowercase();
    if path.ends_with(".jpg") || path.ends_with(".jpeg") { return Some("image/jpeg"); }
    if path.ends_with(".png") { return Some("image/png"); }
    if path.ends_with(".gif") { return Some("image/gif"); }
    if path.ends_with(".webp") { return Some("image/webp"); }
    if path.ends_with(".mp4") { return Some("video/mp4"); }
    if path.ends_with(".webm") { return Some("video/webm"); }
    if path.ends_with(".mov") { return Some("video/quicktime"); }
    if path.ends_with(".mp3") { return Some("audio/mpeg"); }
    if path.ends_with(".ogg") { return Some("audio/ogg"); }
    if path.ends_with(".wav") { return Some("audio/wav"); }
    None
}

/// Extract media URLs from event tags (JSON).
pub fn extract_urls_from_tags(tags_json: &str) -> Vec<String> {
    let tags: Vec<Vec<String>> = serde_json::from_str(tags_json).unwrap_or_default();
    let mut urls = Vec::new();

    for tag in &tags {
        if tag.is_empty() { continue; }
        match tag[0].as_str() {
            "imeta" => {
                for element in &tag[1..] {
                    if let Some(url_val) = element.trim().strip_prefix("url ") {
                        let url = url_val.trim();
                        if url.starts_with("http://") || url.starts_with("https://") {
                            urls.push(url.to_string());
                        }
                    }
                }
            }
            "url" | "r" | "image" | "thumb" | "media" => {
                if tag.len() >= 2 {
                    let val = tag[1].trim();
                    if val.starts_with("http://") || val.starts_with("https://") {
                        urls.push(val.to_string());
                    }
                }
            }
            _ => {}
        }
    }

    urls
}

/// Extract URLs from text content.
pub fn extract_urls_from_text(text: &str) -> Vec<String> {
    let mut urls = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        let remaining = &text[i..];
        let start = if remaining.starts_with("https://") || remaining.starts_with("http://") {
            Some(i)
        } else {
            None
        };

        if let Some(start) = start {
            let mut end = start;
            for &b in &bytes[start..] {
                if matches!(b, b' ' | b'\n' | b'\r' | b'\t' | b'"' | b'\'' | b'<' | b'>' | b']' | b')') {
                    break;
                }
                end += 1;
            }
            if end > start + 10 {
                urls.push(text[start..end].to_string());
            }
            i = end;
        } else {
            i += 1;
        }
    }

    urls
}

/// Media file path: ~/.nostrito/media/<hash[0..2]>/<hash>
pub fn media_file_path(hash: &str) -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".nostrito/media")
        .join(&hash[..2.min(hash.len())])
        .join(hash)
}

#[derive(Debug, Default)]
pub struct MediaStats {
    pub downloaded: u32,
    pub skipped: u32,
    pub failed: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sha256_of_string() {
        let hash = sha256_of_string("https://example.com/image.jpg");
        assert_eq!(hash.len(), 64);
        // Deterministic
        assert_eq!(hash, sha256_of_string("https://example.com/image.jpg"));
    }

    #[test]
    fn test_extract_sha256_from_url() {
        let hash = "a".repeat(64);
        let url = format!("https://blossom.band/{}.jpg", hash);
        assert_eq!(extract_sha256_from_url(&url), Some(hash));

        assert_eq!(extract_sha256_from_url("https://example.com/short.jpg"), None);
    }

    #[test]
    fn test_mime_type_from_url() {
        assert_eq!(mime_type_from_url("https://x.com/pic.jpg"), Some("image/jpeg"));
        assert_eq!(mime_type_from_url("https://x.com/pic.png?w=100"), Some("image/png"));
        assert_eq!(mime_type_from_url("https://x.com/vid.mp4"), Some("video/mp4"));
        assert_eq!(mime_type_from_url("https://x.com/page.html"), None);
    }

    #[test]
    fn test_is_nostr_media_cdn() {
        assert!(is_nostr_media_cdn("https://nostr.build/abc.jpg"));
        assert!(is_nostr_media_cdn("https://void.cat/d/abc123"));
        assert!(is_nostr_media_cdn("https://m.primal.net/abc.jpg"));
        assert!(!is_nostr_media_cdn("https://example.com/pic.jpg"));
    }

    #[test]
    fn test_extract_urls_from_text() {
        let text = "Check this https://nostr.build/image.jpg and this http://example.com/pic.png ok?";
        let urls = extract_urls_from_text(text);
        assert_eq!(urls.len(), 2);
        assert_eq!(urls[0], "https://nostr.build/image.jpg");
        assert_eq!(urls[1], "http://example.com/pic.png");
    }

    #[test]
    fn test_extract_urls_from_tags() {
        let tags = r#"[["imeta","url https://nostr.build/x.jpg","m image/jpeg"],["image","https://example.com/y.png"]]"#;
        let urls = extract_urls_from_tags(tags);
        assert_eq!(urls.len(), 2);
        assert!(urls.contains(&"https://nostr.build/x.jpg".to_string()));
        assert!(urls.contains(&"https://example.com/y.png".to_string()));
    }

    #[test]
    fn test_media_file_path() {
        let path = media_file_path("abcdef1234567890");
        assert!(path.to_string_lossy().contains(".nostrito/media/ab/abcdef1234567890"));
    }
}
