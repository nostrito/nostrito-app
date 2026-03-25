# Nostrito Feature Audit

Last updated: 2026-03-24

---

## Features We Have

### Core
- **Feed/Timeline** — kind 1 notes, kind 6 reposts, kind 30023 articles with WoT filtering
- **Note Detail/Thread View** — NIP-10 threaded replies (root/reply tags), hierarchical display
- **Compose Modal** — create notes (kind 1) and articles (kind 30023) with reply context
- **Profile View** — metadata, notes/articles/media tabs, follow/follower lists, on-demand relay fetch
- **Search** — full-text search on events, profile search by name, DM search, global relay search
- **Global / Explore Feed** — consent-gated global feed from relays, integrated into Feed screen

### Identity & Signing
- **4 signing modes** — nsec (keychain), NIP-46 bunker, Nostr Connect, read-only
- **Setup Wizard** — identity selection, relay config, storage presets
- **Profile editing** — edit name, about, picture, banner, NIP-05, lightning address, website from own profile
- **Event deletion** (kind 5) — delete own events with confirmation; best-effort request to relays
- **Change account** — switch to a different npub (destructive: clears keychain, returns to wizard). Not true multi-account yet — see Future Decisions below

### Social
- **Direct Messages (NIP-04 + NIP-17)** — encrypted DMs grouped by conversation; NIP-17 gift wrap (default) + NIP-04 legacy with toggle. NIP-04 messages show danger badge (open-lock icon with tooltip)
- **DM notifications** — native macOS notification when a new DM arrives (`check_new_dms_notify`)
- **Follow/Unfollow** — contact lists (kind 3)
- **Mute/Unmute** — mute pubkeys (kind 10000)
- **Track/Untrack Profiles** — persistent tracking with dedicated sync priority
- **Reactions (kind 7)** — like button with filled-heart toggle state, optimistic UI. Unlike/unreact via kind 5 deletion.
- **Reposts (kind 6)** — repost button in NoteCard, count display, disable-after-repost, grouped repost rendering
- **Quote reposts** — renders quoted notes via `q` tag with embedded author/preview
- **NIP-05 verified badge** — checkmark + identifier shown on profiles when present

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
- **Relay management** — 14 preconfigured relays + custom relay URLs, add/remove, status monitoring
- **Offline mode** — toggle to stop all outbound sync
- **Native macOS notifications** — for new events via tauri-plugin-notification
- **NIP-65 relay routing** — discover and prefer user's read relays

---

## Broken / Incomplete

### NIP-51 Bookmarks (kind 10003/30001)
- Fully implemented: toggle, sync, dedicated screen, sidebar nav, batched queries
- **UI disabled** pending interop fixes with other clients (see commit d312f9d)
- Backend functional — ready to re-enable once interop is resolved

### Event Deletion Request (kind 5)
- Full-stack: tombstone backend + `publish_deletion` command + delete button in NoteCard + confirmation modal
- Available on own events in Feed, ProfileView, and NoteDetail
- **Important**: Nostr deletion is best-effort. Kind 5 is a *request* — our local relay hard-deletes, well-behaved outbound relays may stop serving it, but there is no guarantee. Events already fetched by other clients or stored on non-compliant relays persist indefinitely. This is a "hide from your view + politely ask the network" feature, not true deletion.

### Profile Editing (kind 0)
- Full-stack: `publish_metadata` command (name, about, picture, banner, NIP-05, LN address, website) + edit profile modal on own ProfileView
- Also available during wizard (initial setup)

---

## Prioritized Backlog

### P0 — Quick Wins (small effort, high polish)

| # | Feature | Status |
|---|---------|--------|
| 1 | **NIP-04 danger badge on DMs** | **Done** — open-lock icon on NIP-04 messages, no badge on NIP-17 (clean = secure). |
| 2 | **Delete request for own events** (kind 5) | **Done** — trash button + confirmation modal on own events in Feed/Profile/NoteDetail. |
| 3 | **Profile editing screen** | **Done** — edit profile modal on own ProfileView with all metadata fields. |
| 4 | **Re-enable NIP-51 bookmarks** | Pending — code is complete, fix interop issues and flip the switch. |
| 5 | **Unlike / unreact** | **Done** — heart toggles off, publishes kind 5 deletion targeting the kind 7 reaction. |

### P1 — Core Missing Features (medium effort, high impact)

| # | Feature | Notes |
|---|---------|-------|
| 6 | **DM compatibility detection + soft warning** | Passive per-contact `dm_protocol_hint` based on received message kinds. Conversation header hint for likely-NIP-04 contacts with one-tap fallback. Per-conversation protocol memory. See DM Strategy section. |
| 7 | **Notifications screen** | Aggregated view of reactions, replies, zaps, reposts, new followers directed at you. No backend or UI yet. |
| 8 | **Media upload** | Upload integration (nostr.build / blossom). Unlocks profile picture editing, article covers, image notes. |
| 9 | **Mentions autocomplete** | @-mention suggestions when composing. Need profile search-as-you-type in ComposeModal. |
| 10 | **Image/video preview in compose** | Show preview when pasting media URLs before publishing. |

### P2 — Ecosystem & Discovery (medium effort, differentiating)

| # | Feature | Notes |
|---|---------|-------|
| 11 | **Trending / popular content** | Trending notes, hashtags, profiles. Could use relay aggregation or local heuristics. |
| 12 | **Suggested follows** | WoT-based recommendations — graph is already there, need ranking + UI. |
| 13 | **Lists** (NIP-51 kind 30000) | Categorized people lists (friends, devs, news, etc.). |
| 14 | **Event rebroadcasting** | Re-publish tracked users' events that fell off relays. Signed events are immutable — any relay will accept them. |
| 15 | **Content warnings** (NIP-36) | Support `content-warning` tag — blur/collapse with reveal button. |

### P3 — Nice to Have (lower urgency)

| # | Feature | Notes |
|---|---------|-------|
| 16 | **Drafts** | Auto-save compose state. |
| 17 | **Keyboard shortcuts** | Navigation, compose, search. |
| 18 | **Per-relay read/write preferences** | Backend supports directions, UI doesn't expose it. |
| 19 | **Relay NIP-11 info display** | Show relay capabilities, software, limitations in relay management. |
| 20 | **Export / import** | Export events to JSON, import from backup. |
| 21 | **Client tag** (NIP-89) | Tag events with Nostrito client identifier. Also useful as a signal for DM compatibility detection. |
| 22 | **Theme customization** | Light/dark toggle. CSS variables exist, needs runtime switcher. |

### P4 — Long Tail

| # | Feature | Notes |
|---|---------|-------|
| 23 | **Group DMs** | Multi-party encrypted conversations. |
| 24 | **Custom emoji** (NIP-30) | Custom emoji reactions and display. |
| 25 | **Polls** (NIP-1078) | Create and vote on polls. |
| 26 | **Highlights** (kind 9802) | Highlight text passages from articles. |
| 27 | **Labels** (NIP-32) | Content labeling/categorization. |
| 28 | **Communities** (NIP-72) | Moderated community groups. |
| 29 | **Scheduled posts** | Publish notes at a future time. |
| 30 | **Auto-zaps / recurring zaps** | Automatic zapping. |
| 31 | **Split zaps** (NIP-57) | Zap multiple recipients. |
| 32 | **Lightning address verification** | Verify lud16 before zapping. |
| 33 | **Media rebroadcasting** | Re-upload dead media from cache. Partially solvable (see Data Preservation notes below). |
| 34 | **Event signature verification UI** | Verify event authenticity in the UI. |
| 35 | **Browser extension integration** | Setup exists but incomplete. |

---

## DM Strategy: NIP-17 Default + NIP-04 Compatibility

### The Problem

NIP-17 is the right default — better encryption, hidden metadata, proper privacy.
But Nostr is fragmented: some contacts use clients that only speak NIP-04. Sending
NIP-17 to someone whose client can't unwrap gift wraps means they **never see your
message**, with no error on either side. Users shouldn't need to know or care about
protocol versions.

### Design Principles

1. **NIP-17 is always the default** — never downgrade silently
2. **NIP-04 messages are visible but marked as insecure** — users learn over time
3. **Detection is passive, not blocking** — don't interrupt the send flow
4. **Per-conversation, not global** — legacy fallback is contextual

### UX Design

#### NIP-04 Danger Badge

Every NIP-04 message (sent or received) shows a small warning icon inline:

- **Icon**: small open-lock or caution triangle next to the message bubble
- **Tooltip on hover**: "legacy encryption — who you're talking to and when is
  publicly visible on relays"
- **Applies to both sides**: your old sent NIP-04 messages *and* incoming NIP-04
  from others — makes it clear this is a protocol property, not a sender's fault
- **No badge on NIP-17** — clean bubbles = secure, badge = legacy. Users learn
  the difference without reading docs.

#### Passive NIP-17 Compatibility Detection

We can infer whether a contact likely supports NIP-17 by observing their behavior
**over time** — no instant detection, no blocking:

| Signal | Meaning |
|--------|---------|
| We've received NIP-17 (kind 1059) from them | They support NIP-17. No action needed. |
| We've only ever received NIP-04 (kind 4) from them | Likely on a legacy client. |
| We've never exchanged DMs with them | Unknown — default to NIP-17 (optimistic). |
| Their client tag (kind 10002 / NIP-89) names a known NIP-17 client | Likely supports it. Low confidence but useful signal. |

**Storage**: per-contact `dm_protocol_hint` field — `"nip17"`, `"nip04_only"`, or
`null` (unknown). Updated passively whenever we decrypt a DM from them.

#### Soft Warning for Likely-NIP-04 Contacts

When opening a conversation with a contact flagged as `nip04_only`:

- **Conversation header hint** (not a modal, not a blocker): subtle banner like
  "this contact may be using a legacy client — your messages might not be visible
  to them"
- **One-tap fallback**: banner includes a link: "send as legacy instead?" which
  switches the conversation to NIP-04 mode (same as the existing compose bar
  toggle, but surfaced contextually)
- **Dismissable**: user can dismiss the banner; it won't reappear for that contact
  unless the hint resets

#### No Instant Send-Time Warning

Deliberately **not** showing a warning at the moment you hit send:

- It would interrupt the natural flow for a problem that *might not exist*
- The passive detection can be wrong (contact may have upgraded clients)
- NIP-17 is the right default — we shouldn't second-guess it on every message
- If the contact truly can't read NIP-17, the conversation header hint already
  told the user before they started typing

#### Per-Conversation Protocol Memory

- Once a user manually switches to NIP-04 for a conversation, **remember it** for
  that contact — don't reset to NIP-17 on next session
- If we later receive a NIP-17 message from that contact (they upgraded), auto-clear
  the `nip04_only` flag and switch back to NIP-17 default
- Show a small toast: "this contact now supports modern encryption" — positive
  reinforcement

### Protocol Reference

**NIP-04 (legacy, kind 4)**
- AES-CBC + ECDH encrypted content, `p` tag names recipient
- **Metadata is fully public**: who, when, how often — only body is encrypted
- Supported by every Nostr client since the beginning

**NIP-17 (modern, kinds 13 / 14 / 1059)**
- Three-layer envelope: **rumor (kind 14) → seal (kind 13) → gift wrap (kind 1059)**
- Sender hidden (random signing key), timestamps randomized (±2 days)
- NIP-44 (XChaCha20-Poly1305 + HKDF) — authenticated encryption
- Two gift wraps per message: one for recipient, one self-copy

**How we maintain seamless compatibility**

| Concern | Approach |
|---|---|
| **Receiving** | Sync engine fetches both kind 4 and kind 1059. DB returns both in a single call. |
| **Decryption** | Kind 4 → `nip04::decrypt`. Kind 1059 → three-layer unwrap with `nip44::decrypt`. Both work with nsec and NIP-46 signers. |
| **Conversation grouping** | Kind 4: partner from `pubkey`/`p` tag. Kind 1059: unwrap to extract real sender/recipient, merge into same conversation. |
| **Sending** | NIP-17 by default. Per-conversation NIP-04 fallback via compose bar toggle or conversation header hint. |
| **Timestamps** | Gift wrap timestamps randomized. Display uses rumor's `created_at` for actual send time. |
| **NIP-46 signers** | Seal encrypted via remote `nip44_encrypt`, signed via `sign_event`. Gift wrap uses local random key. |

---

## Data Preservation Notes

### Event Rebroadcasting (P2)
Detect when tracked users' events have fallen off relays and re-publish from local cache. Signed events are immutable — any relay will accept a valid signature regardless of age. Clear win.

### Media Rebroadcasting / Dead-Link Recovery (P4)
- **Limitation**: re-uploading to a *different* service produces a new URL, but **existing notes cannot be rewritten** — the event id is a hash of the content.
- **Blossom (content-addressed)**: re-upload to the *same* server restores the URL. Different blossom server = different domain.
- **Mitigations**: NIP-94 file metadata events, publish new event (delete old + repost), proactive multi-service redundancy at upload time.
- **Bottom line**: partially solvable today, improves as blossom and NIP-94 adoption grows.

---

## Future Decisions

### Nostrito Mobile as Remote Signer

The mobile app (iOS/Android) acts as the **key custodian and remote signer** for
the desktop client — similar to how WhatsApp Web delegates to the phone. The phone
holds the nsec; the desktop never sees it.

**How it works**:
1. Desktop shows a QR code (NIP-46 `nostrconnect://` URI)
2. Phone scans it, establishing an encrypted session over relays
3. Desktop sends signing requests (publish note, react, zap, DM encrypt/decrypt)
4. Phone prompts for approval (or auto-approves trusted event kinds) and returns signatures
5. Desktop publishes the signed event — never touches the private key

**UX goals**:
- **Pair once, stay connected** — persistent session like WhatsApp Web, not per-action QR scans
- **Push-notification approval** — signing requests arrive as push notifications; tap to approve/reject
- **Selective auto-sign** — user configures which kinds auto-approve (e.g. kind 1, 7) vs. require tap (e.g. kind 4 DMs, NWC wallet ops)
- **Multi-device** — phone can authorize multiple desktops; revoke any session from the phone
- **Offline grace** — desktop queues requests if phone is temporarily unreachable; phone processes the queue on reconnect

**Built on**: NIP-46 (Nostr Connect / remote signer protocol) — already supported as a signing mode in the desktop app. Mobile side needs a NIP-46 **bunker service** (respond to requests) rather than the current client role.

**Status**: Future — requires Nostrito Mobile to exist first

---

### Multi-Account Support

Full analysis in `MULTI_ACCOUNT_ANALYSIS.md`.

**TL;DR**: Manage multiple Nostr identities (main, alts, project accounts) from one app. Proposed path: **Cold Switch** (2-5 sec swap, ~5 commands to modify) + **separate DBs per account** (already how it works) + **no password** (rely on macOS keychain). An account registry in the lobby DB, a non-destructive `switch_account` command, and a sidebar account picker are the main deliverables. Can evolve to hybrid active/dormant model with cross-account DM notifications later.

Key decisions to make:

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
