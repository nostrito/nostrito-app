# Profile Page Redesign

## Summary

Redesign the profile page with a banner hero layout, extended kind 0 metadata, a follows sidebar with search, and automatic 12-hour caching for profile data.

## Layout

Full-width banner hero at top, then a horizontal split: tabbed content on the left, follows sidebar on the right.

### Banner Hero (top)

- Banner image from kind 0 `banner` field. Gradient fallback (`linear-gradient(135deg, #7c3aed, #3b82f6)`) when absent.
- Avatar: 72px circle, overlaps banner bottom edge by ~32px, 4px solid `var(--bg)` border.
- Profile info row below avatar:
  - Name (bold, large)
  - Truncated npub (monospace)
  - NIP-05 verified badge (green checkmark + address)
  - Following count (from `get_follows` length)
- Bio: `about` text
- Metadata row: lightning address (`lud16`), website — shown only when present

### Content Area (left, flex:1)

Tabbed content, same tabs as current: Notes, Articles, Media. Same data loading behavior.

### Follows Sidebar (right, 220px fixed)

- Search input at top — filters follows client-side by name or npub
- Scrollable list of followed users, each showing: avatar (28px), name, truncated npub
- Click navigates to that user's profile
- "+N more" indicator when list exceeds visible area
- Follows list comes from `get_follows(pubkey)` Tauri command (reads kind 3 from WoT graph)
- Profile info for each follow resolved via `getProfiles()` utility

No followers count — local WoT graph cannot reliably calculate this.

## Extended ProfileInfo

Current Rust `ProfileInfo` struct fields: `pubkey`, `name`, `display_name`, `picture`, `nip05`.

Note: `about` exists in the frontend TypeScript interface but is **missing from the Rust struct and DB extraction**. The frontend renders it but it's always null. This must be fixed as part of this work.

Add to Rust `ProfileInfo` struct and `db.get_profiles()` extraction:
- `about: Option<String>` — bio text (**bug fix**, already in frontend interface)
- `banner: Option<String>` — banner image URL
- `website: Option<String>` — user website
- `lud16: Option<String>` — lightning address

Changes required:
- Rust `ProfileInfo` struct in `db.rs`: add four fields (`about`, `banner`, `website`, `lud16`)
- `db.get_profiles()`: extract all four additional fields from kind 0 content JSON
- Frontend `ProfileInfo` TypeScript interface: add `banner`, `website`, `lud16` (about already exists)

## Kind 0 Caching (Rust Backend)

### Goal

Always show cached profile data immediately. Only re-fetch from relays when data is >12 hours stale. Frontend never waits for relay fetch.

### Implementation

New SQLite table:

```sql
CREATE TABLE IF NOT EXISTS profile_cache (
  pubkey TEXT PRIMARY KEY,
  fetched_at INTEGER NOT NULL
);
```

New Tauri command: `get_profile_with_refresh(pubkey: String) -> Option<ProfileInfo>`
- Returns cached profile from `nostr_events` immediately (existing `get_profiles` logic)
- Checks `profile_cache.fetched_at` for the pubkey
- If null or older than 12 hours: spawns a background `tokio::spawn` task to fetch from relays
- Background task: runs existing `fetch_profile` relay logic, updates `profile_cache.fetched_at`, and emits a Tauri event `profile-updated` with the pubkey if the kind 0 event content changed

Replaces the existing `get_profile_cache_status` command (which had mismatched types between Rust and frontend). That command is removed.

Frontend flow:
1. On mount, call `get_profile_with_refresh(pubkey)` — renders cached data immediately
2. Listen for `profile-updated` Tauri event
3. On event, call `invalidateProfileCache(pubkey)` to clear frontend in-memory cache, then re-fetch from DB to update UI

The manual "Fetch profile" button is removed — caching is automatic.

### Follows sidebar rendering

Show up to 50 follows in the sidebar. If the user has more, display a "+N more" text at the bottom. Search filters the full list client-side.

## Files Changed

### Rust Backend
- `src-tauri/src/lib.rs` — add `get_profile_with_refresh` command, remove `get_profile_cache_status`, update `ProfileInfo` re-export
- `src-tauri/src/storage/db.rs` — update `ProfileInfo` struct (add `about`/`banner`/`website`/`lud16`), update `get_profiles` extraction, add `get_profile_fetched_at`/`set_profile_fetched_at` methods
- `src-tauri/src/storage/migrations.rs` — add `profile_cache` table migration

### Frontend
- `src/screens/ProfileView.tsx` — complete rewrite of the component with new layout
- `src/utils/profiles.ts` — update `ProfileInfo` interface with new fields
- `src/styles/dashboard.css` — add new profile styles (banner, sidebar, follows list, search)

### New Frontend Code
- Follows sidebar section within `ProfileView.tsx` (not a separate file — keeps it simple)
