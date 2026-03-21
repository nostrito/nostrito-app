# Nostrito Feature Audit

Last updated: 2026-03-21

---

## Features We Have

### Core
- **Feed/Timeline** — kind 1 notes, kind 6 reposts, kind 30023 articles with WoT filtering
- **Note Detail/Thread View** — NIP-10 threaded replies (root/reply tags), hierarchical display
- **Compose Modal** — create notes (kind 1) and articles (kind 30023) with reply context
- **Profile View** — metadata, notes/articles/media tabs, follow/follower lists, on-demand relay fetch
- **Search** — full-text search on events, profile search by name, DM search, global relay search

### Identity & Signing
- **4 signing modes** — nsec (keychain), NIP-46 bunker, Nostr Connect, read-only
- **Setup Wizard** — identity selection, relay config, storage presets
- **Multi-account** — switch accounts with separate databases

### Social
- **Direct Messages (NIP-04)** — encrypted DMs grouped by conversation, send/receive/decrypt
- **Follow/Unfollow** — contact lists (kind 3)
- **Mute/Unmute** — mute pubkeys (kind 10000)
- **Track/Untrack Profiles** — persistent tracking with dedicated sync priority

### Content & Media
- **Markdown rendering** — custom zero-dependency renderer for articles
- **NIP-19 entity parsing** — npub, note, nevent, nprofile, naddr (custom bech32 decoder)
- **Hashtag navigation** — clickable hashtags in feed
- **Media gallery** — own/others/bookmarked tabs, filter by type, WoT filtering, context menus
- **Media caching** — local download, LRU eviction, storage quotas per category
- **Media viewer lightbox** — with "View Event" and "Bookmark" options

### Lightning / Wallet
- **Zap Modal** — preset amounts (17, 21, 100, 500, 1k, 5k sats), custom comment
- **Wallet connections** — NWC, LNbits, wallet provisioning
- **Wallet management** — balance, transaction history, create/pay invoices
- **Zap display** — zap counts on notes, sats formatting

### Infrastructure
- **Local relay** — NIP-01/11/16/33/40/45, write-restricted, auto-broadcasts to outbound relays
- **5-phase sync engine** — own > tracked > follows > FoF > media download
- **WoT graph** — visualization, hop distance, BFS traversal, trust-based filtering
- **Analytics dashboard** — live event stream, kind breakdown, sync progress, uptime
- **Storage management** — per-category breakdown, retention policies, media quotas
- **Relay management** — 14 preconfigured relays, add/remove, status monitoring
- **Offline mode** — toggle to stop all outbound sync
- **Native macOS notifications** — for new events via tauri-plugin-notification
- **NIP-65 relay routing** — discover and prefer user's read relays

---

## Broken / Incomplete

### Reactions (kind 7)
- Backend `publish_reaction` exists and creates kind 7 events
- Counts display via `useInteractionCounts`
- **No visual feedback** that you've already reacted — no toggle state, no "liked" indicator
- **No unlike support** — can like the same note multiple times
- Fire-and-forget with no optimistic UI update

### Reposts (kind 6)
- Repost display works (including grouped reposts)
- **No repost button** in NoteCard — can't create reposts from the UI

### Event Deletion (kind 5)
- Backend handles deletion tombstones and strips deleted events
- **No delete button** in the UI — can't delete your own events

---

## Missing Entirely

### Core Social
- [ ] **Profile editing** — no way to update your own kind 0 metadata (name, bio, picture, banner, NIP-05, LN address)
- [ ] **Repost button** — can view reposts but can't create them
- [ ] **Unlike / unreact** — no toggle for reactions
- [ ] **Quote reposts** (kind 1 with `q` tag) — not supported
- [ ] **Mentions autocomplete** — no @-mention suggestions when composing
- [ ] **Notifications screen** — no aggregated view of reactions, replies, zaps, reposts, new followers directed at you
- [ ] **Bookmark lists** (NIP-51 kind 30001/10003) — media bookmarks exist but no event/note bookmarking

### Content
- [ ] **Media upload** — can only reference URLs, no upload to nostr.build / blossom / void.cat
- [ ] **Image/video preview in compose** — no preview when pasting media URLs
- [ ] **Content warnings** (NIP-36) — no support for `content-warning` tag
- [ ] **Custom emoji** (NIP-30) — no custom emoji reactions or display
- [ ] **Polls** (NIP-1078) — not supported
- [ ] **Highlights** (kind 9802) — not supported
- [ ] **Labels** (NIP-32) — not supported

### Messaging
- [ ] **NIP-44 encrypted DMs** (kind 14/1059) — only NIP-04 (kind 4) supported, which is legacy/deprecated
- [ ] **Group DMs** — not supported

### Discovery & Social Graph
- [ ] **Trending / popular content** — no trending notes, hashtags, or profiles
- [ ] **Global / explore feed UI** — backend `fetch_global_feed` exists but no dedicated screen
- [ ] **Suggested follows** — no recommendations based on WoT
- [ ] **Lists** (NIP-51 kind 30000) — no categorized people lists
- [ ] **Communities** (NIP-72) — not supported

### Publishing
- [ ] **Drafts** — no draft saving
- [ ] **Scheduled posts** — not supported

### Settings & Management
- [ ] **Relay NIP-11 info display** — relay info fetched but not shown in UI
- [ ] **Per-relay read/write preferences** — backend supports directions but UI doesn't expose it
- [ ] **Export / import** — no way to export events or import from backup
- [ ] **Client tag** (NIP-89) — events don't include client identification

### Security & Verification
- [ ] **NIP-05 verified badge** — NIP-05 data is parsed but no badge shown on profiles
- [ ] **Event signature verification UI** — no way to verify event authenticity in the UI

### Wallet
- [ ] **Auto-zaps / recurring zaps** — not supported
- [ ] **Split zaps** (NIP-57) — not supported
- [ ] **Lightning address verification** — no verification of lud16 before zapping

### Platform
- [ ] **Keyboard shortcuts** — none implemented
- [ ] **Theme customization** — no light/dark theme toggle
- [ ] **Browser extension integration** — setup exists but incomplete

---

## Suggested Priorities

### Quick Wins
1. Fix **reactions** — add toggle state, prevent double-liking, show "liked" indicator
2. Add **repost button** to NoteCard
3. Add **delete own event** button (kind 5)
4. Add **profile editing** screen (kind 0)
5. Show **NIP-05 verified badge** on profiles

### Medium Effort, High Impact
6. Add **notifications screen** (reactions/replies/zaps/follows about you)
7. Upgrade DMs to **NIP-44** (kind 14/1059)
8. Add **media upload** (nostr.build or blossom)
9. Add **global / explore feed** UI
10. Add **quote reposts**
