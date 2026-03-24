#![allow(dead_code)]
use anyhow::Result;
use std::path::PathBuf;
use tracing::info;

/// Download a single media URL and write it to disk.
/// Used by Tauri commands for user-triggered "Save locally" action.
/// Returns the hash of the downloaded file on success, or None if skipped/invalid.
pub async fn download_single_media(
    url: &str,
) -> Result<Option<String>> {
    let hash = extract_sha256_from_url(url)
        .unwrap_or_else(|| sha256_of_string(url));

    const MAX_FILE_SIZE: u64 = 50 * 1024 * 1024;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()?;

    let response = match client.get(url).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return Ok(None),
    };

    let response_mime = response.headers().get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(';').next().unwrap_or(s).trim().to_lowercase());

    let mime = response_mime
        .or_else(|| mime_type_from_url(url).map(|s| s.to_string()))
        .unwrap_or_else(|| {
            if is_nostr_media_cdn(url) { "image/jpeg".to_string() }
            else { "application/octet-stream".to_string() }
        });

    if !mime.starts_with("image/") && !mime.starts_with("video/") && !mime.starts_with("audio/") {
        return Ok(None);
    }

    let bytes = response.bytes().await?;
    let size_bytes = bytes.len() as u64;

    if size_bytes == 0 || size_bytes > MAX_FILE_SIZE {
        return Ok(None);
    }

    let file_path = media_file_path(&hash);
    if let Some(parent) = file_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(&file_path, &bytes).await?;

    info!("Media: saved {} ({} bytes, {})", &hash[..12.min(hash.len())], size_bytes, mime);
    Ok(Some(hash))
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

    // Split on whitespace and common delimiters to find URL tokens
    for token in text.split(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == '<' || c == '>' || c == ')' || c == ']') {
        let trimmed = token.trim();
        if (trimmed.starts_with("https://") || trimmed.starts_with("http://")) && trimmed.len() > 10 {
            urls.push(trimmed.to_string());
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
