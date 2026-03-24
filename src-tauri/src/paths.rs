//! Centralized path resolution for Nostrito.
//!
//! All storage lives under a single **data root** directory.  On first launch
//! this defaults to the OS data directory (`dirs::data_dir()/nostrito`), but
//! users can override it via a small bootstrap JSON file stored at a fixed
//! config location (`dirs::config_dir()/nostrito/paths.json`).
//!
//! Layout under `{data_root}/`:
//! ```text
//! nostrito.db             # lobby database
//! npub1abc1234.db         # per-user database
//! media/ab/abcdef...      # downloaded media files
//! certs/localhost.pem     # TLS certificate
//! certs/localhost-key.pem # TLS private key
//! nostrito.log            # rotating log file
//! ```

use std::path::{Path, PathBuf};

/// The fixed bootstrap config filename.
const BOOTSTRAP_FILE: &str = "paths.json";

// ── Default root ─────────────────────────────────────────────────────

/// Platform default data root (used when no bootstrap override exists).
pub fn default_data_root() -> PathBuf {
    dirs::data_dir()
        .or_else(|| dirs::home_dir())
        .or_else(|| std::env::var("HOME").ok().map(PathBuf::from))
        .or_else(|| {
            // Android fallback: app-private internal storage
            let p = PathBuf::from("/data/data/lat.nostrito/files");
            if p.exists() || std::fs::create_dir_all(&p).is_ok() {
                Some(p)
            } else {
                None
            }
        })
        .unwrap_or_else(|| PathBuf::from("."))
        .join("nostrito")
}

// ── Bootstrap config ─────────────────────────────────────────────────

/// Path to the bootstrap JSON config file.
///
/// This lives in a **fixed** OS config location so it can be read before any
/// database or logging is initialised:
/// - macOS: `~/Library/Application Support/nostrito/paths.json`
/// - Linux: `~/.config/nostrito/paths.json`
/// - Windows: `%APPDATA%/nostrito/paths.json`
fn bootstrap_config_path() -> Option<PathBuf> {
    // On Android config_dir() is unreliable — skip the bootstrap file entirely.
    #[cfg(target_os = "android")]
    {
        return None;
    }

    #[cfg(not(target_os = "android"))]
    {
        dirs::config_dir().map(|d| d.join("nostrito").join(BOOTSTRAP_FILE))
    }
}

/// Resolve the data root: reads the bootstrap config if present, otherwise
/// returns [`default_data_root()`].
pub fn read_data_root() -> PathBuf {
    if let Some(bp) = bootstrap_config_path() {
        if let Ok(contents) = std::fs::read_to_string(&bp) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&contents) {
                if let Some(root) = parsed.get("data_root").and_then(|v| v.as_str()) {
                    let p = PathBuf::from(root);
                    if !p.as_os_str().is_empty() {
                        return p;
                    }
                }
            }
        }
    }
    default_data_root()
}

/// Persist a custom data root to the bootstrap config file.
pub fn write_data_root(path: &Path) -> Result<(), String> {
    let bp = bootstrap_config_path()
        .ok_or_else(|| "Bootstrap config not supported on this platform".to_string())?;

    if let Some(parent) = bp.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config dir: {}", e))?;
    }

    let json = serde_json::json!({ "data_root": path.to_string_lossy() });
    std::fs::write(&bp, serde_json::to_string_pretty(&json).unwrap())
        .map_err(|e| format!("Failed to write bootstrap config: {}", e))
}

/// Remove custom data root override (revert to default).
#[allow(dead_code)]
pub fn clear_data_root() -> Result<(), String> {
    if let Some(bp) = bootstrap_config_path() {
        if bp.exists() {
            std::fs::remove_file(&bp)
                .map_err(|e| format!("Failed to remove bootstrap config: {}", e))?;
        }
    }
    Ok(())
}

// ── Directory helpers ────────────────────────────────────────────────

/// Media directory: `{root}/media/`
pub fn media_dir(root: &Path) -> PathBuf {
    root.join("media")
}

/// Certificates directory: `{root}/certs/`
pub fn certs_dir(root: &Path) -> PathBuf {
    root.join("certs")
}

/// TLS certificate path: `{root}/certs/localhost.pem`
pub fn cert_path(root: &Path) -> PathBuf {
    certs_dir(root).join("localhost.pem")
}

/// TLS private key path: `{root}/certs/localhost-key.pem`
pub fn key_path(root: &Path) -> PathBuf {
    certs_dir(root).join("localhost-key.pem")
}

/// Individual media file path: `{root}/media/<hash[0..2]>/<hash>`
pub fn media_file_path(root: &Path, hash: &str) -> PathBuf {
    media_dir(root)
        .join(&hash[..2.min(hash.len())])
        .join(hash)
}

// ── First-run migration from old layout ──────────────────────────────

/// If data is split across the old layout (`~/.nostrito/` for media/certs/logs
/// and `dirs::data_dir()/nostrito/` for databases), consolidate everything
/// under `data_root`.  This is a one-time operation on first launch after the
/// update.
pub fn migrate_old_layout_if_needed(data_root: &Path) {
    let old_home_dir = match dirs::home_dir() {
        Some(h) => h.join(".nostrito"),
        None => return,
    };

    // Only run if the old layout exists and data_root is NOT the old location
    if !old_home_dir.exists() || old_home_dir == *data_root {
        return;
    }

    // Check if there's a bootstrap config already — if so, user has already
    // configured things and we shouldn't auto-migrate
    if let Some(bp) = bootstrap_config_path() {
        if bp.exists() {
            return;
        }
    }

    tracing::info!(
        "[paths] Migrating old layout from {} → {}",
        old_home_dir.display(),
        data_root.display()
    );

    // Move media/
    let old_media = old_home_dir.join("media");
    let new_media = media_dir(data_root);
    if old_media.exists() && !new_media.exists() {
        if let Err(e) = move_dir(&old_media, &new_media) {
            tracing::warn!("[paths] Failed to move media: {} — will try copy", e);
            copy_dir_recursive(&old_media, &new_media).ok();
        }
    }

    // Move certs/
    let old_certs = old_home_dir.join("certs");
    let new_certs = certs_dir(data_root);
    if old_certs.exists() && !new_certs.exists() {
        if let Err(e) = move_dir(&old_certs, &new_certs) {
            tracing::warn!("[paths] Failed to move certs: {} — will try copy", e);
            copy_dir_recursive(&old_certs, &new_certs).ok();
        }
    }

    // Move log files
    for entry in std::fs::read_dir(&old_home_dir).into_iter().flatten() {
        if let Ok(entry) = entry {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with("nostrito.log") {
                let dest = data_root.join(&*name_str);
                if !dest.exists() {
                    std::fs::rename(entry.path(), &dest).ok();
                }
            }
        }
    }

    tracing::info!("[paths] Old layout migration complete");
}

/// Try `rename` first (fast, same-filesystem), fall back to copy+delete.
fn move_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match std::fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(_) => {
            copy_dir_recursive(src, dst)?;
            std::fs::remove_dir_all(src).ok();
            Ok(())
        }
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let dest_path = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &dest_path)?;
        } else {
            std::fs::copy(entry.path(), &dest_path)?;
        }
    }
    Ok(())
}

// ── Platform detection ───────────────────────────────────────────────

pub fn platform() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}
