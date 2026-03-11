# Profile Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the profile page with a banner hero layout, extended kind 0 fields, a follows sidebar with search, and automatic 12-hour profile caching.

**Architecture:** Backend-first approach. Extend `ProfileInfo` struct, add `profile_cache` table via migration, add `get_profile_with_refresh` command. Then rewrite the frontend `ProfileView.tsx` with the new layout and caching flow.

**Tech Stack:** Rust (Tauri, rusqlite, nostr-sdk, tokio), React + TypeScript, CSS

**Spec:** `docs/superpowers/specs/2026-03-11-profile-redesign-design.md`

---

## Chunk 1: Backend — Extend ProfileInfo + Migration

### Task 1: Extend Rust ProfileInfo struct with new fields

**Files:**
- Modify: `src-tauri/src/storage/db.rs:12-19` (ProfileInfo struct)
- Modify: `src-tauri/src/storage/db.rs:736-743` (get_profiles JSON extraction)

- [ ] **Step 1: Add fields to ProfileInfo struct**

In `src-tauri/src/storage/db.rs`, update the struct:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileInfo {
    pub pubkey: String,
    pub name: Option<String>,
    pub display_name: Option<String>,
    pub picture: Option<String>,
    pub nip05: Option<String>,
    pub about: Option<String>,
    pub banner: Option<String>,
    pub website: Option<String>,
    pub lud16: Option<String>,
}
```

- [ ] **Step 2: Update get_profiles JSON extraction**

In `src-tauri/src/storage/db.rs`, update the `get_profiles` method where it builds `ProfileInfo` (around line 737-743):

```rust
profiles.push(ProfileInfo {
    pubkey,
    name: parsed.get("name").and_then(|v| v.as_str()).map(String::from),
    display_name: parsed.get("display_name").and_then(|v| v.as_str()).map(String::from),
    picture: parsed.get("picture").and_then(|v| v.as_str()).map(String::from),
    nip05: parsed.get("nip05").and_then(|v| v.as_str()).map(String::from),
    about: parsed.get("about").and_then(|v| v.as_str()).map(String::from),
    banner: parsed.get("banner").and_then(|v| v.as_str()).map(String::from),
    website: parsed.get("website").and_then(|v| v.as_str()).map(String::from),
    lud16: parsed.get("lud16").and_then(|v| v.as_str()).map(String::from),
});
```

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`
Expected: Should compile (all new fields are Option, no consumers break).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/storage/db.rs
git commit -m "feat(profile): extend ProfileInfo with about, banner, website, lud16"
```

### Task 2: Add profile_cache table migration

**Files:**
- Modify: `src-tauri/src/storage/migrations.rs:6` (bump SCHEMA_VERSION)
- Modify: `src-tauri/src/storage/migrations.rs:39-41` (add v2_to_v3 call)
- Modify: `src-tauri/src/storage/migrations.rs` (add migrate_v2_to_v3 function)

- [ ] **Step 1: Add v2→v3 migration**

In `src-tauri/src/storage/migrations.rs`:

1. Change `SCHEMA_VERSION` from `2` to `3`.
2. In `run_migrations`, add after the `if current < 2` block:
```rust
if current < 3 {
    migrate_v2_to_v3(conn)?;
}
```
3. Add the migration function:
```rust
fn migrate_v2_to_v3(conn: &Connection) -> Result<()> {
    info!("Running migration v2 → v3...");
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS profile_cache (
            pubkey TEXT PRIMARY KEY,
            fetched_at INTEGER NOT NULL
        );",
    )?;
    info!("Migration v2 → v3 complete");
    Ok(())
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`
Expected: Compiles cleanly.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/storage/migrations.rs
git commit -m "feat(db): add profile_cache table migration (v2→v3)"
```

### Task 3: Add DB methods for profile cache

**Files:**
- Modify: `src-tauri/src/storage/db.rs` (add methods after get_profiles)

- [ ] **Step 1: Add get/set methods for profile_cache**

Add to `impl Database` in `src-tauri/src/storage/db.rs`:

```rust
/// Get the last time a profile was fetched from relays.
pub fn get_profile_fetched_at(&self, pubkey: &str) -> Result<Option<i64>> {
    let conn = self.conn.lock().unwrap();
    let result = conn.query_row(
        "SELECT fetched_at FROM profile_cache WHERE pubkey = ?1",
        [pubkey],
        |row| row.get(0),
    );
    match result {
        Ok(ts) => Ok(Some(ts)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Record that a profile was fetched from relays now.
pub fn set_profile_fetched_at(&self, pubkey: &str, fetched_at: i64) -> Result<()> {
    let conn = self.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO profile_cache (pubkey, fetched_at) VALUES (?1, ?2)
         ON CONFLICT(pubkey) DO UPDATE SET fetched_at = ?2",
        rusqlite::params![pubkey, fetched_at],
    )?;
    Ok(())
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`
Expected: Compiles cleanly.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/storage/db.rs
git commit -m "feat(db): add profile cache get/set methods"
```

### Task 4: Add get_profile_with_refresh Tauri command

**Files:**
- Modify: `src-tauri/src/lib.rs` (add new command, update invoke_handler)

- [ ] **Step 1: Add the command**

Add this command function in `src-tauri/src/lib.rs` (near the existing `fetch_profile` command, around line 1534):

```rust
#[tauri::command]
async fn get_profile_with_refresh(
    pubkey: String,
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<ProfileInfo>, String> {
    // 1. Return cached profile immediately
    let profiles = state.db.get_profiles(&[pubkey.clone()]).map_err(|e| e.to_string())?;
    let cached = profiles.into_iter().find(|p| p.pubkey == pubkey);

    // 2. Check if we need a background refresh
    let fetched_at = state.db.get_profile_fetched_at(&pubkey).map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().timestamp();
    let twelve_hours = 12 * 60 * 60;
    let needs_refresh = match fetched_at {
        Some(ts) => (now - ts) > twelve_hours,
        None => true,
    };

    if needs_refresh {
        // 3. Spawn background fetch — don't block the response
        let pk = pubkey.clone();
        let db = state.db.clone();
        let wot = state.wot_graph.clone();
        let config = state.config.clone();
        let handle = app_handle.clone();

        tokio::spawn(async move {
            tracing::info!("[profile_refresh] Background fetch for {}...", &pk[..pk.len().min(12)]);

            // Get old profile for comparison (serialize to JSON string for full comparison)
            let old_profile_json = db.get_profiles(&[pk.clone()])
                .ok()
                .and_then(|ps| ps.into_iter().find(|p| p.pubkey == pk))
                .and_then(|p| serde_json::to_string(&p).ok());

            // Reuse existing fetch_profile logic inline
            match do_fetch_profile(&pk, &db, &wot, &config).await {
                Ok(_) => {
                    let now = chrono::Utc::now().timestamp();
                    db.set_profile_fetched_at(&pk, now).ok();

                    // Check if any profile field changed
                    let new_profile_json = db.get_profiles(&[pk.clone()])
                        .ok()
                        .and_then(|ps| ps.into_iter().find(|p| p.pubkey == pk))
                        .and_then(|p| serde_json::to_string(&p).ok());

                    if old_profile_json != new_profile_json {
                        handle.emit("profile-updated", &pk).ok();
                    }
                }
                Err(e) => {
                    tracing::warn!("[profile_refresh] Failed for {}: {}", &pk[..pk.len().min(12)], e);
                }
            }
        });
    }

    Ok(cached)
}
```

- [ ] **Step 2: Extract fetch logic into do_fetch_profile helper**

The existing `fetch_profile` command (starting at the `#[tauri::command]` annotation around line 1513) has relay connection logic that needs to be reusable. Perform these transformations:

1. **Copy** the entire body of `fn fetch_profile` (everything after `async fn fetch_profile(pubkey: String, state: State<'_, AppState>) -> ...`) into a new standalone function.

2. **Change the signature** — instead of receiving `State<'_, AppState>`, receive the individual Arc-wrapped fields:

```rust
async fn do_fetch_profile(
    pubkey: &str,
    db: &std::sync::Arc<Database>,
    wot: &std::sync::Arc<crate::wot::WotGraph>,
    config: &std::sync::Arc<tokio::sync::RwLock<AppConfig>>,
) -> Result<ProfileFetchResult, String> {
```

3. **Find-and-replace** inside the copied body:
   - `state.config.read().await` → `config.read().await`
   - `state.db.store_event(` → `db.store_event(`
   - `state.wot_graph.update_follows(` → `wot.update_follows(`
   - `state.db.update_follows_batch(` → `db.update_follows_batch(`
   - All `&pubkey` references should work since the parameter is `pubkey: &str`; replace any owned `pubkey.clone()` usages that build nostr-sdk keys with `pubkey.to_string()` if needed

4. **Replace the original `fetch_profile` command** with a thin wrapper:

```rust
#[tauri::command]
async fn fetch_profile(pubkey: String, state: State<'_, AppState>) -> Result<ProfileFetchResult, String> {
    do_fetch_profile(&pubkey, &state.db, &state.wot_graph, &state.config).await
}
```

The `do_fetch_profile` function does NOT get `#[tauri::command]` — it's an internal helper.

- [ ] **Step 3: Make Database and WotGraph cloneable for the spawn**

Check if `Database` and `WotGraph` are wrapped in `Arc` in `AppState`. If `AppState` stores them as `Arc<Database>` etc., use `state.db.clone()`. If not, they need to be wrapped. Check `AppState` struct and adjust accordingly.

- [ ] **Step 4: Register the new command in invoke_handler**

In the `generate_handler!` macro (around line 2046), add `get_profile_with_refresh`:

```rust
get_profile_with_refresh,
```

- [ ] **Step 5: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -20`
Expected: Compiles. Fix any borrow/lifetime issues.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(profile): add get_profile_with_refresh with 12h background caching"
```

---

## Chunk 2: Frontend — ProfileInfo Update + New ProfileView

### Task 5: Update frontend ProfileInfo interface

**Files:**
- Modify: `src/utils/profiles.ts:4-11`

- [ ] **Step 1: Add new fields to TypeScript interface**

In `src/utils/profiles.ts`, update `ProfileInfo`:

```typescript
export interface ProfileInfo {
  pubkey: string;
  name: string | null;
  display_name: string | null;
  picture: string | null;
  nip05: string | null;
  about: string | null;
  banner: string | null;
  website: string | null;
  lud16: string | null;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/utils/profiles.ts
git commit -m "feat(profile): add banner, website, lud16 to frontend ProfileInfo"
```

### Task 6: Rewrite ProfileView.tsx with new layout

**Files:**
- Modify: `src/screens/ProfileView.tsx` (full rewrite)

This is the largest task. The component needs:
- Banner hero section with overlapping avatar
- Profile info row (name, npub, NIP-05, following count)
- Bio + metadata (about, lightning, website)
- Split layout: tabbed content (left) + follows sidebar with search (right)
- `get_profile_with_refresh` call on mount
- Listen for `profile-updated` Tauri event
- Follows loading via `get_follows` + profile resolution

- [ ] **Step 1: Rewrite the component**

Replace the entire content of `src/screens/ProfileView.tsx` with the new layout. Key structural changes:

**State additions:**
```typescript
const [follows, setFollows] = useState<string[]>([]);
const [followProfiles, setFollowProfiles] = useState<Map<string, ProfileInfo>>(new Map());
const [followSearch, setFollowSearch] = useState("");
const [followingCount, setFollowingCount] = useState<number>(0);
```

**Profile loading — use get_profile_with_refresh:**
```typescript
// On mount: call get_profile_with_refresh (returns cached, triggers background refresh if stale)
const p = await invoke<ProfileInfo | null>("get_profile_with_refresh", { pubkey });
setProfile(p);

// Load follows
const followList = await invoke<string[]>("get_follows", { pubkey });
setFollows(followList);
setFollowingCount(followList.length);

// Resolve follow profiles (batch, first 50)
const batch = followList.slice(0, 200);
const profiles = await getProfiles(batch);
setFollowProfiles(profiles);
```

**Listen for profile-updated event:**
```typescript
import { listen } from "@tauri-apps/api/event";

useEffect(() => {
  const unlisten = listen<string>("profile-updated", (event) => {
    if (event.payload === pubkey) {
      invalidateProfileCache(pubkey);
      getProfiles([pubkey]).then((profiles) => {
        const updated = profiles.get(pubkey) ?? null;
        if (updated) setProfile(updated);
      });
    }
  });
  return () => { unlisten.then(fn => fn()); };
}, [pubkey]);
```

**Banner section JSX:**
```tsx
{/* Banner */}
<div className="profile-banner" style={profile?.banner ? { backgroundImage: `url(${profile.banner})` } : undefined}>
  <div className="profile-banner-overlay" />
</div>

{/* Avatar overlapping banner */}
<div className="profile-hero-info">
  <Avatar picture={profile?.picture ?? null} pubkey={pubkey} className="profile-hero-avatar" />
  <div className="profile-hero-details">
    <div className="profile-hero-name">{displayName}</div>
    <div className="profile-hero-npub">{truncatedPubkey}</div>
    {profile?.nip05 && (
      <div className="profile-hero-nip05">
        <span className="icon"><IconCheck /></span> {profile.nip05}
      </div>
    )}
    <div className="profile-hero-stats">
      <span className="profile-stat"><strong>{followingCount}</strong> Following</span>
    </div>
  </div>
</div>
```

**Bio + metadata:**
```tsx
{(profile?.about || profile?.lud16 || profile?.website) && (
  <div className="profile-bio-section">
    {profile?.about && <p className="profile-bio-text">{profile.about}</p>}
    <div className="profile-meta-row">
      {profile?.lud16 && <span className="profile-meta-item"><!-- lightning SVG --> {profile.lud16}</span>}
      {profile?.website && <span className="profile-meta-item"><!-- globe SVG --> {profile.website}</span>}
    </div>
  </div>
)}
```

**Split layout:**
```tsx
<div className="profile-body">
  {/* Left: tabbed content */}
  <div className="profile-content">
    {/* Tab bar + tab content (same as current but with new class names) */}
  </div>

  {/* Right: follows sidebar */}
  <div className="profile-follows-sidebar">
    <div className="profile-follows-search">
      <input
        type="text"
        placeholder="Search follows..."
        value={followSearch}
        onChange={(e) => setFollowSearch(e.target.value)}
      />
    </div>
    <div className="profile-follows-list">
      {filteredFollows.slice(0, 50).map((pk) => {
        const fp = followProfiles.get(pk);
        return (
          <div key={pk} className="profile-follow-item" onClick={() => navigate(`/profile/${pk}`)}>
            <Avatar picture={fp?.picture ?? null} pubkey={pk} className="profile-follow-avatar" />
            <div className="profile-follow-info">
              <div className="profile-follow-name">{profileDisplayName(fp, pk)}</div>
              <div className="profile-follow-npub">{shortPubkey(pk)}</div>
            </div>
          </div>
        );
      })}
      {filteredFollows.length > 50 && (
        <div className="profile-follows-more">+ {filteredFollows.length - 50} more</div>
      )}
    </div>
  </div>
</div>
```

**Follows filtering:**
```typescript
const filteredFollows = useMemo(() => {
  if (!followSearch.trim()) return follows;
  const q = followSearch.toLowerCase();
  return follows.filter((pk) => {
    const fp = followProfiles.get(pk);
    const name = fp ? (fp.name || fp.display_name || "") : "";
    return name.toLowerCase().includes(q) || pk.toLowerCase().includes(q);
  });
}, [follows, followProfiles, followSearch]);
```

- [ ] **Step 2: Remove the old fetch button and cache status logic**

Delete all references to `showFetchButton`, `fetching`, `fetchMessage`, `handleFetchProfile`, `CacheStatus` interface, and the `get_profile_cache_status` invoke.

- [ ] **Step 3: Verify the app builds**

Run: `cd /Users/dandelionlabs/development/personal/nostrito-app && npm run build 2>&1 | tail -10`
Expected: Builds without TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add src/screens/ProfileView.tsx
git commit -m "feat(profile): rewrite ProfileView with banner hero + follows sidebar"
```

### Task 7: Add profile CSS styles

**Files:**
- Modify: `src/styles/dashboard.css` (add new profile styles, remove old ones)

- [ ] **Step 1: Add new profile styles**

Add to `src/styles/dashboard.css` (replace the old profile-specific styles from line ~892 onwards):

```css
/* ─── Profile page redesign ─── */
.profile-banner {
  height: 140px;
  background: linear-gradient(135deg, #7c3aed 0%, #3b82f6 50%, #06b6d4 100%);
  background-size: cover;
  background-position: center;
  position: relative;
}
.profile-banner-overlay {
  position: absolute;
  inset: 0;
  background: linear-gradient(to bottom, transparent 50%, var(--bg) 100%);
}
.profile-hero-info {
  display: flex;
  gap: 16px;
  padding: 0 24px 16px;
  margin-top: -36px;
  position: relative;
  z-index: 1;
}
.profile-hero-avatar {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  border: 4px solid var(--bg);
  object-fit: cover;
  flex-shrink: 0;
  background: var(--bg-card);
}
.profile-hero-avatar-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.4rem;
  font-weight: 700;
  color: #fff;
}
.profile-hero-details {
  padding-top: 40px;
  min-width: 0;
  flex: 1;
}
.profile-hero-name {
  font-size: 1.25rem;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: var(--text);
}
.profile-hero-npub {
  font-size: 0.72rem;
  color: var(--text-muted);
  font-family: var(--mono);
  margin-top: 2px;
}
.profile-hero-nip05 {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.78rem;
  color: var(--green);
  margin-top: 4px;
}
.profile-hero-stats {
  display: flex;
  gap: 20px;
  margin-top: 8px;
  font-size: 0.82rem;
  color: var(--text-dim);
}
.profile-stat strong {
  color: var(--text);
  font-weight: 700;
}

/* Bio + metadata */
.profile-bio-section {
  padding: 0 24px 16px;
  border-bottom: 1px solid var(--border);
}
.profile-bio-text {
  font-size: 0.88rem;
  color: var(--text-dim);
  line-height: 1.55;
  margin-bottom: 8px;
}
.profile-meta-row {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}
.profile-meta-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.78rem;
  color: var(--text-muted);
}
.profile-meta-item .icon {
  font-size: 0.85rem;
}

/* Split body */
.profile-body {
  display: flex;
  flex: 1;
  min-height: 0;
}
.profile-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

/* Follows sidebar */
.profile-follows-sidebar {
  width: 220px;
  border-left: 1px solid var(--border);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 300px);
}
.profile-follows-search {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.profile-follows-search input {
  width: 100%;
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 0.78rem;
  color: var(--text);
  font-family: var(--font);
  outline: none;
  transition: border-color 0.15s;
}
.profile-follows-search input:focus {
  border-color: var(--accent);
}
.profile-follows-search input::placeholder {
  color: var(--text-muted);
}
.profile-follows-list {
  overflow-y: auto;
  flex: 1;
}
.profile-follow-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  cursor: pointer;
  transition: background 0.15s;
}
.profile-follow-item:hover {
  background: rgba(255, 255, 255, 0.02);
}
.profile-follow-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}
.profile-follow-avatar-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.65rem;
  font-weight: 700;
  color: #fff;
}
.profile-follow-info {
  min-width: 0;
}
.profile-follow-name {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.profile-follow-npub {
  font-size: 0.62rem;
  color: var(--text-muted);
  font-family: var(--mono);
}
.profile-follows-more {
  text-align: center;
  padding: 10px;
  font-size: 0.75rem;
  color: var(--text-muted);
}

/* Back button */
.profile-back-row {
  padding: 8px 16px;
}
.profile-back-btn {
  font-size: 0.82rem;
  padding: 6px 14px;
}

/* Responsive */
@media (max-width: 768px) {
  .profile-follows-sidebar {
    display: none;
  }
  .profile-hero-info {
    padding: 0 16px 12px;
  }
  .profile-bio-section {
    padding: 0 16px 12px;
  }
}
```

- [ ] **Step 2: Remove old profile styles that are no longer used**

Remove from `dashboard.css`:
- `.profile-fetch-banner` and related `.profile-fetch-*` styles (lines ~892-964)
- `.profile-fetch-message`, `.profile-fetch-success`, `.profile-fetch-empty`, `.profile-fetch-error`

Keep:
- `.profile-tabs`, `.profile-tab`, `.profile-tab-content` (still used)
- `.profile-note-card`, `.profile-article-title`, `.profile-media-grid` (still used)

- [ ] **Step 3: Verify the app builds and looks correct**

Run: `npm run build 2>&1 | tail -10`
Expected: Builds cleanly.

- [ ] **Step 4: Commit**

```bash
git add src/styles/dashboard.css
git commit -m "feat(profile): add banner hero + follows sidebar styles"
```

---

## Chunk 3: Cleanup + Integration

### Task 8: Remove get_profile_cache_status command

**Files:**
- Modify: `src-tauri/src/lib.rs` (remove command + invoke_handler entry)

- [ ] **Step 1: Remove the command function and handler registration**

In `src-tauri/src/lib.rs`:
1. Delete the `get_profile_cache_status` function (around line 1526-1530)
2. Delete the `ProfileCacheStatus` struct
3. Remove `get_profile_cache_status` from the `generate_handler!` macro (line ~2082)

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`
Expected: Compiles cleanly.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "refactor(profile): remove obsolete get_profile_cache_status command"
```

### Task 9: Manual integration test

- [ ] **Step 1: Run the full app**

Run: `npm run tauri dev`

- [ ] **Step 2: Test profile page**

1. Navigate to any profile from the feed/WoT page
2. Verify: banner shows (gradient if no banner image in kind 0)
3. Verify: avatar overlaps banner edge
4. Verify: name, npub, NIP-05, following count display correctly
5. Verify: bio/about text shows if present
6. Verify: lightning address and website show if present
7. Verify: follows sidebar shows with avatars and names
8. Verify: follows search filters the list
9. Verify: clicking a follow navigates to their profile
10. Verify: profile loads instantly from cache on revisit
11. Verify: responsive — sidebar hides on narrow window

- [ ] **Step 3: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(profile): polish profile redesign after integration testing"
```
