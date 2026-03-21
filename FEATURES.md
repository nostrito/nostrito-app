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
- [x] **NIP-17 private DMs** (kind 14/1059 gift wrap) — send & receive NIP-17 gift-wrapped DMs with NIP-44 encryption
- [x] **NIP-04 legacy DMs** (kind 4) — full send/receive/decrypt, toggleable from compose bar
- [ ] **Group DMs** — not supported

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
