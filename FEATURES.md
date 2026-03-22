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
- **Change account** — switch to a different npub (destructive: clears keychain, returns to wizard). Not true multi-account yet — see Future Decisions below

### Social
- **Direct Messages (NIP-04 + NIP-17)** — encrypted DMs grouped by conversation; NIP-17 gift wrap (default) + NIP-04 legacy with toggle
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
- [ ] **Profile editing** — no way to update your own kind 0 metadata after initial setup (name, bio, picture, banner, NIP-05, LN address). Backend `publish_metadata` command exists.
- [ ] **Repost button** — can view reposts but can't create them
- [ ] **Unlike / unreact** — no toggle for reactions
- [ ] **Quote reposts** (kind 1 with `q` tag) — not supported
- [ ] **Mentions autocomplete** — no @-mention suggestions when composing
- [ ] **Notifications screen** — no aggregated view of reactions, replies, zaps, reposts, new followers directed at you
- [ ] **Bookmark lists** (NIP-51 kind 30001/10003) — media bookmarks exist but no event/note bookmarking

### Content
- [ ] **Media upload service** — need a real upload integration (default provider configurable in settings). Required for:
  1. **Profile pictures** — upload during setup wizard and profile editing
  2. **Banners** — upload during profile editing
  3. **Article covers** — upload when composing/editing kind 30023 articles
  4. **Notes** — media uploader in compose modal for attaching images/videos to kind 1 notes
  - Candidate services: nostr.build, blossom (NIP-96), void.cat, nostrimg.com
  - Should support at minimum image upload; video/audio as stretch goals
  - Provider selection in Settings with a sensible default (e.g. nostr.build)
- [ ] **Image/video preview in compose** — no preview when pasting media URLs
- [ ] **Content warnings** (NIP-36) — no support for `content-warning` tag
- [ ] **Custom emoji** (NIP-30) — no custom emoji reactions or display
- [ ] **Polls** (NIP-1078) — not supported
- [ ] **Highlights** (kind 9802) — not supported
- [ ] **Labels** (NIP-32) — not supported

### Messaging
- [x] **NIP-17 private DMs** (kind 14/1059 gift wrap) — send & receive NIP-17 gift-wrapped DMs with NIP-44 encryption
- [x] **NIP-04 legacy DMs** (kind 4) — full send/receive/decrypt, toggleable from compose bar
- [ ] **Group DMs** — not supported
- [ ] **DM notifications** — native macOS notification when a new DM is received

#### DM Protocol Architecture: NIP-04 vs NIP-17

Nostrito supports both the legacy NIP-04 and the modern NIP-17 direct messaging
standards. NIP-17 is the default for sending; NIP-04 is available as a toggle
for backward compatibility with older clients.

**NIP-04 (legacy, kind 4)**
- Simple: sender publishes a kind 4 event with NIP-04 (AES-CBC + ECDH) encrypted
  content and a `p` tag naming the recipient.
- The **event metadata is fully public**: anyone can see who is messaging whom, how
  often, and the exact timestamps. Only the message body is encrypted.
- Encryption uses AES-CBC which lacks modern authenticated-encryption guarantees.
- Supported by every Nostr client since the beginning.

**NIP-17 (modern, kinds 13 / 14 / 1059)**
- Three-layer envelope: **rumor → seal → gift wrap**.
  1. **Rumor (kind 14)** — the actual message. Unsigned, contains the `p` tag
     pointing to the recipient, and the plaintext content.
  2. **Seal (kind 13)** — the rumor encrypted with NIP-44 (XChaCha20-Poly1305)
     to the *recipient's* key, signed by the sender. Has a **randomised
     timestamp** (±2 days) so observers cannot correlate events by time.
  3. **Gift Wrap (kind 1059)** — the seal encrypted with NIP-44 to the
     recipient's key, signed by a **random throwaway key**. The only public
     metadata is the `p` tag (recipient) and another randomised timestamp.
- Because the outer event is signed by a random key, **observers cannot
  determine the sender**. Combined with the fuzzy timestamps, message frequency
  and timing are also hidden.
- Encryption uses NIP-44 (XChaCha20-Poly1305 + HKDF) — authenticated encryption
  with a proper KDF, replacing NIP-04's weaker AES-CBC.
- Sender creates **two** gift wraps per message: one addressed to the recipient
  and one addressed to themselves (the "self-copy"), so sent messages appear in
  the sender's conversation view.

**How we maintain seamless compatibility**

| Concern | Approach |
|---|---|
| **Receiving** | The sync engine fetches both kind 4 and kind 1059 events addressed to the user. The DB query returns both kinds in a single call. |
| **Decryption** | Kind 4 → `nip04::decrypt`. Kind 1059 → three-layer unwrap (`gift_wrap → seal → rumor`) using `nip44::decrypt` at each layer. Both paths work with local nsec *and* NIP-46 remote signers. |
| **Conversation grouping** | Kind 4 messages identify the partner from `pubkey` / `p` tag directly. Kind 1059 messages are unwrapped first to extract the real sender and recipient from the inner rumor, then merged into the same conversation map. |
| **Sending (default NIP-17)** | New messages are sent as NIP-17 gift wraps by default. A toggle in the compose bar lets the user switch to NIP-04 for specific conversations (e.g. when messaging someone whose client only supports NIP-04). |
| **Timestamps** | Gift wrap timestamps are intentionally randomised (±2 days). For display and sorting we use the rumor's `created_at` which reflects the actual send time. |
| **NIP-46 remote signers** | Gift wrap creation requires NIP-44 encrypt + event signing. For NIP-46: the seal content is encrypted via `nip44_encrypt` on the remote signer, the seal is signed via `sign_event`, and the outer gift wrap uses a locally-generated random key (no remote call needed). Unwrapping mirrors this with `nip44_decrypt`. |

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

### Data Preservation & Rebroadcasting
- [ ] **Event rebroadcasting** — detect when tracked users' events have fallen off relays and re-publish them from the local cache. Fully feasible: signed events are immutable, any relay will accept a valid signature regardless of age.
- [ ] **Media rebroadcasting / dead-link recovery** — detect when cached media files are no longer available at their original URLs (blossom servers down, nostr.build purged, etc.) and re-upload from local cache to a working media service.
  - **Limitation**: re-uploading to a *different* service produces a new URL, but **existing notes cannot be rewritten** — the event id is a hash of the content, so changing the URL would invalidate the signature. The original links in published notes stay broken.
  - **Blossom (content-addressed)**: URLs are `https://server/<sha256>.<ext>`. If re-uploaded to the *same* server the URL works again. If to a different blossom server, the hash matches but the domain differs — would require clients to support multi-server hash lookup (not widely adopted yet).
  - **Possible mitigations**:
    1. Publish **NIP-94 file metadata events (kind 1063)** mapping the original URL / file hash → new URL. Smart clients could use these as fallback resolution. Ecosystem support is still nascent.
    2. For the user's *own* notes: offer to publish a **new event** (delete old + repost with updated links). Destructive but functional.
    3. Proactive redundancy: at upload time, push to multiple media services simultaneously so if one dies the others still serve the file.
  - **Bottom line**: event rebroadcasting is a clear win. Media recovery is partially solvable today and will improve as blossom and NIP-94 adoption grows.

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
7. ~~Upgrade DMs to **NIP-44** (kind 14/1059)~~ ✅ Done — NIP-17 gift wrap DMs with NIP-44 encryption
8. Add **media upload** (nostr.build or blossom)
9. Add **global / explore feed** UI
10. Add **quote reposts**

---

## Future Decisions

### Multi-Account Support

Full analysis in `MULTI_ACCOUNT_ANALYSIS.md`. Key decisions to make:

#### 1. Switching Model — How do we switch between accounts?

| Option | Switch Time | Effort | Notes |
|--------|------------|--------|-------|
| **Cold Switch** | 2-5 sec | Small | Make `change_account` non-destructive, add account registry. Minimal changes. |
| **Concurrent** | <1 sec | Very large | All accounts sync in parallel. ~130 commands become account-aware. |
| **Hybrid** | 1-3 sec | Moderate | One active + dormant accounts with optional DM/mention heartbeat. |

**Leaning toward**: Cold Switch for initial release — leverages existing per-npub DB
isolation and keychain-per-npub storage. Can evolve to Hybrid later.

**Status**: Undecided

#### 2. Database Strategy — How do multiple accounts' data coexist?

| Option | Notes |
|--------|-------|
| **Separate DBs per account (current)** | Zero migration. Full isolation. Media already shared on filesystem. |
| **Single unified DB** | Massive refactor (31 tables). Not worth it for one-owner scenario. |
| **Hybrid shared + per-account** | Shared relay stats + media metadata. Nice but not needed initially. |

**Leaning toward**: Keep separate DBs. Add `accounts` table to lobby DB as registry.

**Status**: Undecided

#### 3. App Authentication — Should the app require a password/PIN?

| Option | Notes |
|--------|-------|
| **No password** | Rely on macOS keychain + screen lock. Zero friction. Current model. |
| **Master PIN** | One PIN for the app. Protects against unlocked-Mac access. PIN fatigue. |
| **Biometric + PIN** | Touch ID when available, PIN fallback. Best UX but most complex. |
| **Per-account passwords** | Not recommended — one person owns all accounts, no benefit. |

**Leaning toward**: No password initially. Optional "App Lock" (biometric + PIN) as
a future settings toggle.

**Status**: Undecided

#### 4. Account Removal — What happens to data when removing an account?

| Option | Notes |
|--------|-------|
| **Ask each time** | Confirmation dialog with "also delete data" checkbox |
| **Always delete** | Clean break, remove DB + keychain |
| **Never delete** | Just unlink from registry, data stays on disk |

**Status**: Undecided

#### 5. Cross-Account Notifications — Should dormant accounts get checked?

A lightweight heartbeat could check dormant accounts for DMs/mentions every ~5 min
without running a full sync. Shows macOS notification like "Your @altname got a DM".

**Status**: Undecided — could be deferred to a later release
