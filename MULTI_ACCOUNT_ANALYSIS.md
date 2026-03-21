# Multi-Account Support: Architecture Analysis

## Why This Document

Nostrito currently supports one active Nostr identity at a time. The goal is to let a
single owner manage multiple Nostr identities (main account, alts, project accounts)
from the same app. This document analyzes the architectural options for:

1. How account switching works
2. How databases coexist
3. Whether app-level authentication (password/PIN) makes sense

---

## What We Have Today

Before diving into options, here's a quick summary of how things work now:

- **One active account** identified by its npub (public key)
- **Separate database per account**: `~/.nostrito/{npub_prefix}.db` (SQLite, 31 tables)
- **Lobby database**: `~/.nostrito/nostrito.db` — knows which account was last active
- **Keys in macOS keychain**: nsec, bunker URIs, wallet keys — each stored under the npub
- **Shared media cache**: `~/.nostrito/media/` — content-addressed by hash, not per-account
- **"Change account" is destructive**: it deletes your keychain credentials and sends you
  back to the wizard, as if starting fresh

The backend holds a single `AppState` with one database connection, one WoT graph,
one sync engine, and one local relay. The frontend has React contexts for the active
profile, signing capability, and profile cache.

---

## Part 1: Account Switching Models

### Model A: Cold Switch

**The idea**: Only one account is active at a time. Switching tears down the current
account's backend (sync engine, relay, WoT graph) and rebuilds everything for the
new account. This is essentially what `change_account` does today, except we stop
deleting the keychain credentials.

**What happens when you switch**:
1. Stop sync engine
2. Stop local relay
3. Disconnect NIP-46 signer (if bunker mode)
4. Swap the database to the new account's file
5. Load config and keychain credentials for the new account
6. Rebuild WoT graph from the new database
7. Restart sync engine and relay
8. Tell the frontend to refresh everything

**Switch time**: ~2-5 seconds (WoT graph rebuild dominates)

**Resource usage**: Low — only one account's worth of memory, network, and CPU at a time.

**What we need to build**:
- An `accounts` table in the lobby database (registry of known accounts)
- A `switch_account` command that does the non-destructive switch
- An account picker UI in the sidebar
- Modify `init_nostrito` to register each new account

**Pros**:
- Minimal changes from what we have today
- Complete data isolation between accounts
- Low resource usage (one sync engine, one WoT graph)
- Simple to reason about

**Cons**:
- 2-5 second switch time — noticeable but not terrible
- Inactive accounts don't sync, so they're stale when you switch to them
- No cross-account notifications ("your alt got a DM")
- You have to wait for WoT rebuild every time

---

### Model B: Concurrent Accounts (All Syncing in Parallel)

**The idea**: Every account runs its own sync engine simultaneously. Each account has
its own WoT graph loaded in memory. Switching only changes which account drives the
UI and the local relay — everything else is already running.

**What happens when you switch**:
1. Restart local relay with the new account's pubkey
2. Tell the frontend to show the new account
3. That's it — sync is already running, WoT is already loaded

**Switch time**: Sub-second

**Resource usage**: High — N sync engines means N sets of relay connections, N WoT
graphs in memory (~20-50MB each), N times the CPU for processing events.

**What we need to build**:
- Restructure `AppState` into per-account `AccountContext` structs
- Make every single Tauri command (~130 of them) account-aware
- Manage lifecycle of multiple sync engines
- Account picker UI

**Pros**:
- Near-instant switching
- All accounts always up-to-date
- Could show cross-account notifications
- Best experience for power users

**Cons**:
- Largest refactoring effort by far (~130 commands need changes)
- 3 accounts = 3x network connections, 60-150MB extra RAM for WoT
- All nsecs loaded in memory simultaneously
- Significantly more complex state management
- Overkill if you only switch accounts a few times a day

---

### Model C: Hybrid Active/Dormant

**The idea**: A middle ground. One account is "active" with full sync/relay/WoT.
Other accounts are "dormant" — their database is open but nothing is running.
Optionally, a lightweight heartbeat task periodically checks dormant accounts for
DMs and mentions (just one relay query every ~5 minutes, no full sync).

**What happens when you switch**:
1. Demote current account to dormant (stop sync, relay, free WoT)
2. Promote target account to active (rebuild WoT, start sync, start relay)
3. Tell the frontend to refresh

**Switch time**: ~1-3 seconds (DB is already open, saves some time vs. Cold Switch)

**Resource usage**: Moderate — one full sync engine + lightweight heartbeat queries.

**What we need to build**:
- Everything from Model A, plus:
- Dormant account management (open DBs, track state)
- Optional heartbeat task for cross-account notification checks
- System notifications for dormant account activity

**Pros**:
- Faster than Cold Switch (DB already open)
- Cross-account DM/mention awareness without full sync
- Moderate resource usage

**Cons**:
- WoT rebuild still takes 1-3 seconds on switch
- Heartbeat adds complexity
- More state to manage than Cold Switch
- Only marginally faster than Model A in practice

---

### Summary Table

| | Cold Switch | Concurrent | Hybrid |
|---|---|---|---|
| Switch time | 2-5 sec | <1 sec | 1-3 sec |
| Memory overhead | None | High (N x WoT) | Low-moderate |
| Network overhead | None | High (N x sync) | Low (heartbeat) |
| Cross-account notifs | No | Yes | Partial (DM/mention) |
| Implementation effort | Small | Very large | Moderate |
| Commands to modify | ~5 | ~130 | ~5-10 |

---

## Part 2: Database Coexistence

### Option A: Keep Separate Databases Per Account (Current)

Each account has its own `.db` file. Add an `accounts` table to the lobby database
to track known accounts. Media cache stays shared on the filesystem.

- Zero migration for existing users
- Full isolation (one account's corruption doesn't affect others)
- Simple backup: copy one `.db` file
- Cross-account search requires opening multiple DBs on demand
- Some duplication (relay stats, relay info exist in each DB)

**This is the simplest and most practical option.**

### Option B: Single Unified Database

Merge everything into one database. Add an `account_npub` column to every table.
Every query gains a `WHERE account_npub = ?` clause.

- Massive schema change (31 tables, every query modified)
- Cross-account search is trivial
- One corrupt DB = all accounts lost
- Complex migration from existing per-account DBs
- Shared relay stats (minor benefit)

**Not recommended.** The refactoring cost is enormous for minimal practical benefit
when the owner is one person.

### Option C: Hybrid (Shared + Per-Account)

A shared database for cross-account data (relay stats, relay info, media metadata)
plus per-account databases for everything else (events, WoT, settings, mutes).

- Moderate effort: extract a few tables into shared DB
- Two DB connections to manage
- Cross-DB transactions are complex
- Nice optimization but not necessary for initial release

**Nice to have later, but not needed now.**

### Recommendation

**Option A: Keep separate databases.** The per-npub isolation works well, requires
no migration, and media is already shared via the filesystem. This is the pragmatic
choice.

---

## Part 3: Authentication / Password Models

### Context: Who Are We Protecting Against?

The owner is **one person** with multiple Nostr identities. This is NOT a shared
device scenario. The threats are:

1. **Someone walks up to your unlocked Mac** → they can open the app and use your accounts
2. **Malware on your Mac** → can access keychain with user privileges
3. **Stolen Mac (locked)** → macOS keychain is encrypted at rest, protected
4. **Stolen disk/backup** → keychain is tied to hardware, protected

The nsec (private key) is the critical secret. Everything else (notes, follows,
DMs) exists on public relays anyway.

### Option 1: No Password (Rely on macOS Security)

This is what we have today. The nsec lives in the macOS system keychain, which is
encrypted at rest and requires your login session to access.

- **Zero friction** — just open the app and go
- **Already implemented** — no new code
- **macOS keychain is battle-tested** — Apple's security team maintains it
- **Risk**: anyone with access to your unlocked Mac session can use all accounts
- **Mitigation**: use macOS screen lock (Cmd+L, auto-lock after idle)

Adding multi-account doesn't change the security model at all — each npub already
has its own keychain entry.

### Option 2: Single Master PIN/Password

Set one PIN or password that protects the entire app. On launch, you enter the PIN
to unlock. The PIN derives an encryption key (via Argon2) that wraps all your nsecs.

- **Protects against the "unlocked Mac" threat**
- **Single PIN for all accounts** — appropriate for one owner
- **PIN fatigue**: you enter it every time you open the app
- **Forgotten PIN = lost nsecs** (unless you have recovery/backup of your keys)
- **~1 second delay** for key derivation on each unlock
- **Does NOT protect against malware** that can intercept the PIN entry

### Option 3: Per-Account Passwords

Each account gets its own password. You enter a password every time you switch accounts.

- **Maximum granularity** — one compromised password doesn't expose others
- **Terrible UX** for one person managing their own identities
- **No practical security benefit** over Option 2 since the same person knows all passwords

**Not recommended.** This model exists for shared devices (multiple people, one computer),
not for one person with multiple identities.

### Option 4: Biometric (Touch ID)

Use macOS Touch ID to gate access to keychain items. The nsec keychain entries get
created with biometric access control, so accessing them requires a fingerprint.

- **Zero friction** — just touch the sensor
- **Strong protection** against the "unlocked Mac" threat
- **Not all Macs have Touch ID** (older models, some desktops without Magic Keyboard)
- **Platform-specific** — no Linux equivalent, Windows Hello is different
- **Needs a fallback** for machines without biometrics

### Option 5: Biometric + PIN Fallback

Touch ID when available, 4-6 digit PIN as fallback. Best of Options 2 and 4.

- **Works on all hardware**
- **Best UX** where biometrics are available
- **Two code paths** to implement and maintain
- **Most complex** option

### Summary Table

| | No password | Master PIN | Per-account | Biometric | Bio + PIN |
|---|---|---|---|---|---|
| Friction | None | Every launch | Every switch | Touch | Touch or PIN |
| Protects unlocked Mac | No | Yes | Yes | Yes | Yes |
| Implementation effort | None | Moderate | Moderate | Moderate | High |
| Risk of lockout | None | Forgotten PIN | Forgotten passwords | Hardware failure | Low |
| Recommended for 1 owner | Yes | Maybe | No | Yes (if available) | Yes |

### Recommendation

**Start with Option 1 (No Password)** for the initial multi-account release.
Rationale:
- The keychain already protects secrets at rest
- Multi-account doesn't weaken the existing security model
- PIN fatigue is real — Nostr clients that added PINs report user complaints
- macOS screen lock is the proper defense against casual physical access

**Plan for Option 5 (Biometric + PIN) as a future opt-in "App Lock" feature** in
Settings, for users who want the extra protection.

---

## What I'd Build (Proposed Path)

Based on all the above, the sweet spot is:

**Cold Switch (Model A) + Separate DBs (Option A) + No Password (Option 1)**

### Why This Combination

- **Minimal changes**: The existing architecture already has per-npub DBs, per-npub
  keychain entries, and a DB-swap mechanism. We just need to stop being destructive
  on account change and add an account registry.
- **2-5 sec switch is fine**: If you're switching accounts a few times a day, a brief
  loading moment is acceptable. It's similar to switching Slack workspaces.
- **No password complexity**: Ship the feature without auth overhead. Users who want
  protection can lock their Mac.
- **Upgrade path**: Can evolve to Hybrid (Model C) later by adding the heartbeat task
  for cross-account notifications. Can add App Lock (Option 5) as an opt-in setting.

### High-Level Steps

1. Add `accounts` table to lobby DB
2. New commands: `list_accounts`, `switch_account`, `remove_account`
3. Modify `init_nostrito` to register accounts
4. Modify `change_account` to preserve keychain credentials
5. Account picker component in the sidebar
6. Frontend context updates for account switching
7. Wizard tweaks (show "back to account" when accounts exist)

---

## Open Questions for Discussion

1. **Switch model**: Are you OK with 2-5 sec cold switch, or is sub-second switching
   important enough to justify the much larger refactor (Concurrent model)?

2. **Authentication**: Ship without password, or do you want a master PIN from day one?

3. **Account removal**: When removing an account, should we:
   - Always ask the user if they also want to delete the data file?
   - Always delete the data?
   - Never delete the data (just unlink from the app)?

4. **Cross-account awareness**: Is the heartbeat notification feature (checking dormant
   accounts for DMs/mentions) something you want in the initial release, or can it
   wait?

5. **Anything else** you'd approach differently or want me to reconsider?
