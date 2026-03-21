/** DMs -- Direct Messages screen. Shows NIP-04 + NIP-17 DMs grouped by conversation.
 *  When nsec is available, messages are decrypted; otherwise shown as encrypted. */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { IconMessageCircle, IconLock, IconSearch, IconX } from "../components/Icon";
import { Avatar } from "../components/Avatar";
import { EmptyState } from "../components/EmptyState";
import { formatTimestamp } from "../utils/format";
import { profileDisplayName } from "../utils/profiles";
import { useProfileContext } from "../context/ProfileContext";
import type { NostrEvent, Settings, Conversation } from "../types/nostr";
import type { ProfileInfo } from "../utils/profiles";

/** Unwrapped gift wrap result from the backend */
interface UnwrappedDm {
  sender_pubkey: string;
  recipient_pubkey: string | null;
  content: string;
  created_at: number;
  rumor_kind: number;
}

// Session-level flag: only do the expensive 30-day relay scan once
let hasFullScanned = false;

function getPartner(event: NostrEvent, ownPk: string): string | null {
  if (event.pubkey === ownPk) {
    const pTag = event.tags.find((t) => t[0] === "p" && t[1]);
    return pTag ? pTag[1] : null;
  }
  return event.pubkey;
}

export const Dms: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { getProfile, ensureProfiles, profileVersion } = useProfileContext();
  void profileVersion; // subscribe to profile cache updates
  const [loading, setLoading] = useState(true);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [ownPubkey, setOwnPubkey] = useState("");
  const [selectedPartner, setSelectedPartner] = useState<string | null>(null);
  const [signingMode, setSigningMode] = useState<"nsec" | "bunker" | "connect" | "read-only">("read-only");
  const [displayCount, setDisplayCount] = useState(30);
  const [sendAsLegacy, setSendAsLegacy] = useState(false);

  // Message input state
  const [messageInput, setMessageInput] = useState("");

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ProfileInfo[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cache for decrypted message content: eventId -> plaintext
  const decryptedCache = useRef<Map<string, string>>(new Map());
  // Cache for unwrapped gift wraps: eventId -> UnwrappedDm
  const giftWrapCache = useRef<Map<string, UnwrappedDm>>(new Map());
  // Track which gift wrap event IDs map to which partner (for isSent detection)
  const giftWrapSenderCache = useRef<Map<string, string>>(new Map());
  // Incremented to force re-render after async decryption
  const [, setDecryptTick] = useState(0);

  // Special empty-state variants
  const [emptyReason, setEmptyReason] = useState<
    | null
    | "no-identity"
    | "cannot-determine-pubkey"
    | "read-only"
    | "no-dms"
    | "error"
  >(null);

  // ── Build conversations from local DB events ─────────────────
  const buildConversations = useCallback(
    async (pk: string, mode: string) => {
      const events = await invoke<NostrEvent[]>("get_dm_events", {
        ownPubkey: pk,
        limit: 500,
      });

      if (!events || events.length === 0) {
        try {
          const kindCounts = await invoke<{ counts: Record<number, number> }>("get_kind_counts");
          const dmCount = (kindCounts.counts[4] || 0) + (kindCounts.counts[1059] || 0);
          if (dmCount > 0) return { convs: [] as Conversation[], empty: "read-only" as const };
        } catch { /* */ }
        return { convs: [] as Conversation[], empty: "no-dms" as const };
      }

      const nip04Events = events.filter((e) => e.kind === 4);
      const giftWrapEvents = events.filter((e) => e.kind === 1059);

      const gwCache = giftWrapCache.current;
      const dCache = decryptedCache.current;
      const senderCache = giftWrapSenderCache.current;

      // Unwrap gift wraps — use cache for already-unwrapped ones
      if (mode !== "read-only" && giftWrapEvents.length > 0) {
        const toUnwrap = giftWrapEvents.filter((ev) => !gwCache.has(ev.id));
        if (toUnwrap.length > 0) {
          const results = await Promise.allSettled(
            toUnwrap.map(async (ev) => {
              const result = await invoke<UnwrappedDm>("unwrap_gift_wrap", {
                eventId: ev.id,
                eventPubkey: ev.pubkey,
                eventContent: ev.content,
                eventCreatedAt: ev.created_at,
                eventTags: ev.tags,
                eventSig: ev.sig,
              });
              return { eventId: ev.id, unwrapped: result };
            }),
          );
          for (const r of results) {
            if (r.status === "fulfilled") {
              const { eventId, unwrapped } = r.value;
              gwCache.set(eventId, unwrapped);
              dCache.set(eventId, unwrapped.content);
              senderCache.set(eventId, unwrapped.sender_pubkey);
            }
          }
        }
      }

      // Group by conversation partner
      const convMap = new Map<string, NostrEvent[]>();

      for (const ev of nip04Events) {
        const partner = getPartner(ev, pk);
        if (!partner) continue;
        if (!convMap.has(partner)) convMap.set(partner, []);
        convMap.get(partner)!.push(ev);
      }

      for (const ev of giftWrapEvents) {
        const unwrapped = gwCache.get(ev.id);
        if (!unwrapped) continue;
        let partner: string;
        if (unwrapped.sender_pubkey === pk) {
          partner = unwrapped.recipient_pubkey || "";
        } else {
          partner = unwrapped.sender_pubkey;
        }
        if (!partner) continue;
        if (!convMap.has(partner)) convMap.set(partner, []);
        convMap.get(partner)!.push(ev);
      }

      const getTimestamp = (m: NostrEvent) => {
        const u = gwCache.get(m.id);
        return u ? u.created_at : m.created_at;
      };

      const sorted = Array.from(convMap.entries())
        .map(([partnerPubkey, messages]) => ({
          partnerPubkey,
          messages: messages.sort((a, b) => getTimestamp(b) - getTimestamp(a)),
          lastTimestamp: Math.max(...messages.map(getTimestamp)),
        }))
        .sort((a, b) => b.lastTimestamp - a.lastTimestamp);

      ensureProfiles(sorted.map((c) => c.partnerPubkey));

      return { convs: sorted, empty: null };
    },
    [ensureProfiles],
  );

  // ── Main load: instant from local DB, then background sync ──
  const loadDms = useCallback(async () => {
    setLoading(true);
    setEmptyReason(null);

    try {
      const settings = await invoke<Settings>("get_settings");
      if (!settings.npub) {
        setEmptyReason("no-identity");
        setLoading(false);
        return;
      }

      let mode: string = "read-only";
      try {
        mode = await invoke<string>("get_signing_mode");
        setSigningMode(mode as "nsec" | "bunker" | "connect" | "read-only");
      } catch {
        setSigningMode("read-only");
      }

      let pk: string;
      if (settings.npub.startsWith("npub1")) {
        const profile = await invoke<{ pubkey: string } | null>("get_own_profile");
        if (profile) {
          pk = profile.pubkey;
        } else {
          setEmptyReason("cannot-determine-pubkey");
          setLoading(false);
          return;
        }
      } else {
        pk = settings.npub;
      }
      setOwnPubkey(pk);

      // ── Phase A: load from local DB instantly ──
      const { convs, empty } = await buildConversations(pk, mode);
      if (empty) setEmptyReason(empty);
      setConversations(convs);
      prevTotalMessages.current = convs.reduce((sum, c) => sum + c.messages.length, 0);
      setLoading(false); // user sees messages NOW

      // Decrypt NIP-04 previews in background (non-blocking)
      if (mode !== "read-only") {
        decryptPreviews(convs, pk);
      }

      // ── Phase B: background relay sync (fire-and-forget) ──
      if (mode !== "read-only") {
        (async () => {
          try {
            // Publish inbox relays so others know where to send us gift wraps
            invoke("publish_inbox_relays").catch(() => {});

            // Full scan only once per session; short poll otherwise
            const doFull = !hasFullScanned;
            if (doFull) hasFullScanned = true;

            const fetched = await invoke<number>("fetch_new_dms", { fullScan: doFull });
            if (fetched > 0) {
              console.log(`[dms] background sync: ${fetched} new DMs`);
              // Silently rebuild conversations with new data
              const { convs: updated, empty: updatedEmpty } = await buildConversations(pk, mode);
              if (updatedEmpty) setEmptyReason(updatedEmpty);
              else setEmptyReason(null);
              setConversations(updated);
              if (mode !== "read-only") decryptPreviews(updated, pk);
            }
          } catch (e) {
            console.debug("[dms] background sync:", e);
          }
        })();
      }
    } catch (e) {
      console.error("[dms] Error loading DMs:", e);
      setEmptyReason("error");
      setLoading(false);
    }

    async function decryptPreviews(convs: Conversation[], pk: string) {
      const cache = decryptedCache.current;
      let updated = false;
      for (const conv of convs) {
        const lastMsg = conv.messages[0];
        if (!lastMsg || cache.has(lastMsg.id)) continue;
        if (lastMsg.kind === 1059) continue;
        const senderPk = lastMsg.pubkey === pk ? conv.partnerPubkey : lastMsg.pubkey;
        try {
          const plaintext = await invoke<string>("decrypt_dm", {
            content: lastMsg.content,
            senderPubkey: senderPk,
          });
          cache.set(lastMsg.id, plaintext);
          updated = true;
        } catch {
          cache.set(lastMsg.id, "[Decryption failed]");
          updated = true;
        }
      }
      if (updated) setDecryptTick((v) => v + 1);
    }
  }, [buildConversations]);

  useEffect(() => {
    loadDms();
  }, [loadDms]);

  // Poll for new DMs — 5s when a chat is open (near-realtime feel), 60s on sidebar.
  const prevTotalMessages = useRef<number>(0);
  useEffect(() => {
    if (!ownPubkey || signingMode === "read-only") return;
    const pollMs = selectedPartner ? 5000 : 60000;
    const interval = setInterval(async () => {
      try {
        await invoke("fetch_new_dms", { fullScan: false });
        const { convs, empty } = await buildConversations(ownPubkey, signingMode);

        const totalNow = convs.reduce((sum, c) => sum + c.messages.length, 0);
        const prevTotal = prevTotalMessages.current;
        prevTotalMessages.current = totalNow;

        if (totalNow !== prevTotal) {
          if (empty) setEmptyReason(empty);
          else setEmptyReason(null);
          setConversations(convs);
        }
      } catch (e) {
        console.debug("[dms] poll error:", e);
      }
    }, pollMs);
    return () => clearInterval(interval);
  }, [selectedPartner, ownPubkey, signingMode, buildConversations]);

  // Decrypt messages for the selected thread
  const decryptThread = useCallback(async (messages: NostrEvent[], partnerPubkey: string) => {
    const cache = decryptedCache.current;
    let updated = false;

    for (const msg of messages) {
      if (cache.has(msg.id)) continue;

      // NIP-17 gift wraps: try unwrapping if not already cached
      if (msg.kind === 1059) {
        try {
          const unwrapped = await invoke<UnwrappedDm>("unwrap_gift_wrap", {
            eventId: msg.id,
            eventPubkey: msg.pubkey,
            eventContent: msg.content,
            eventCreatedAt: msg.created_at,
            eventTags: msg.tags,
            eventSig: msg.sig,
          });
          giftWrapCache.current.set(msg.id, unwrapped);
          giftWrapSenderCache.current.set(msg.id, unwrapped.sender_pubkey);
          cache.set(msg.id, unwrapped.content);
          updated = true;
        } catch (e) {
          console.warn("[dms] Gift wrap unwrap failed for", msg.id, e);
          cache.set(msg.id, "[Unwrap failed]");
          updated = true;
        }
        continue;
      }

      // NIP-04: decrypt as before
      const senderPk = msg.pubkey === ownPubkey ? partnerPubkey : msg.pubkey;

      try {
        const plaintext = await invoke<string>("decrypt_dm", {
          content: msg.content,
          senderPubkey: senderPk,
        });
        cache.set(msg.id, plaintext);
        updated = true;
      } catch (e) {
        console.warn("[dms] Decrypt failed for", msg.id, e);
        cache.set(msg.id, "[Decryption failed]");
        updated = true;
      }
    }

    if (updated) {
      setDecryptTick((v) => v + 1);
    }
  }, [ownPubkey]);

  // Trigger decryption when selecting a conversation with nsec
  useEffect(() => {
    if (!selectedPartner || signingMode === "read-only") return;

    const conv = conversations.find((c) => c.partnerPubkey === selectedPartner);
    if (!conv) return;

    decryptThread(conv.messages, selectedPartner);
  }, [selectedPartner, signingMode, conversations, decryptThread]);

  // Track whether user is scrolled to the bottom of the thread
  const threadRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const prevMessageCount = useRef<number>(0);

  const scrollToBottom = useCallback((smooth = true) => {
    const el = threadRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "instant" });
    setHasNewMessages(false);
  }, []);

  // Auto-scroll on conversation switch
  const prevPartnerRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedPartner && threadRef.current && selectedPartner !== prevPartnerRef.current) {
      setDisplayCount(30);
      setHasNewMessages(false);
      prevMessageCount.current = 0;
      setTimeout(() => scrollToBottom(false), 0);
    }
    prevPartnerRef.current = selectedPartner;
  }, [selectedPartner, scrollToBottom]);

  // When conversations update: auto-scroll if at bottom, show indicator if not.
  // Uses isAtBottomRef (updated by scroll listener) instead of checking scroll position
  // at render time, since the DOM hasn't updated yet when this effect fires.
  useEffect(() => {
    if (!selectedPartner) return;
    const conv = conversations.find((c) => c.partnerPubkey === selectedPartner);
    if (!conv) return;
    const count = conv.messages.length;
    if (prevMessageCount.current > 0 && count > prevMessageCount.current) {
      if (isAtBottomRef.current) {
        // User was at bottom — scroll to show new message after DOM paints
        requestAnimationFrame(() => {
          setTimeout(() => scrollToBottom(true), 0);
        });
      } else {
        setHasNewMessages(true);
      }
    }
    prevMessageCount.current = count;
  }, [conversations, selectedPartner, scrollToBottom]);

  // Track scroll position to detect if user is at bottom
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      isAtBottomRef.current = atBottom;
      if (atBottom) setHasNewMessages(false);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [selectedPartner]);

  // Sentinel observer to load older messages on scroll-up
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!sentinelRef.current || !selectedPartner) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setDisplayCount((prev) => prev + 30);
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [selectedPartner]);

  // Pre-select partner from navigation state (e.g. from profile "message" button)
  useEffect(() => {
    const partner = (location.state as any)?.partner;
    if (partner && !loading) {
      ensureProfiles([partner]);
      // Check if conversation exists, if not create temporary one
      const existing = conversations.find((c) => c.partnerPubkey === partner);
      if (!existing) {
        setConversations((prev) => [{
          partnerPubkey: partner,
          messages: [],
          lastTimestamp: Math.floor(Date.now() / 1000),
        }, ...prev]);
      }
      setSelectedPartner(partner);
      // Clear the state so refreshes don't re-trigger
      window.history.replaceState({}, document.title);
    }
  }, [location.state, loading, conversations, ensureProfiles]);

  // Debounced profile search
  const handleSearchInput = useCallback((value: string) => {
    setSearchQuery(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);

    if (!value.trim()) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    searchTimerRef.current = setTimeout(async () => {
      try {
        const results = await invoke<ProfileInfo[]>("search_profiles", {
          query: value.trim(),
          limit: 15,
        });
        setSearchResults(results.filter((r) => r.pubkey !== ownPubkey));
      } catch (e) {
        console.error("[dms] Profile search failed:", e);
        setSearchResults([]);
      }
      setIsSearching(false);
    }, 300);
  }, [ownPubkey]);

  // Handle selecting a search result
  const handleSelectSearchResult = useCallback((pubkey: string) => {
    setSearchQuery("");
    setSearchResults([]);

    const existing = conversations.find((c) => c.partnerPubkey === pubkey);
    if (existing) {
      setSelectedPartner(pubkey);
    } else {
      const newConv: Conversation = {
        partnerPubkey: pubkey,
        messages: [],
        lastTimestamp: Math.floor(Date.now() / 1000),
      };
      setConversations((prev) => [newConv, ...prev]);
      setSelectedPartner(pubkey);
      ensureProfiles([pubkey]);
    }
  }, [conversations, ensureProfiles]);

  // Send a DM — optimistic: message appears instantly, publish happens in background
  const pendingIdCounter = useRef(0);
  const handleSendDm = useCallback(() => {
    const text = messageInput.trim();
    if (!text || !selectedPartner || signingMode === "read-only") return;

    // Generate a temporary optimistic ID
    pendingIdCounter.current += 1;
    const optimisticId = `pending-${Date.now()}-${pendingIdCounter.current}`;
    const now = Math.floor(Date.now() / 1000);

    // Create an optimistic message event
    const optimisticMsg: NostrEvent = {
      id: optimisticId,
      pubkey: ownPubkey,
      created_at: now,
      kind: sendAsLegacy ? 4 : 1059,
      tags: [["p", selectedPartner]],
      content: "",
      sig: "",
    };

    // Cache the plaintext so it renders immediately
    decryptedCache.current.set(optimisticId, text);
    // For gift wraps, also mark as sent by us
    if (!sendAsLegacy) {
      giftWrapSenderCache.current.set(optimisticId, ownPubkey);
    }

    // Insert into conversations optimistically
    setConversations((prev) => {
      const updated = prev.map((conv) => {
        if (conv.partnerPubkey !== selectedPartner) return conv;
        return {
          ...conv,
          messages: [optimisticMsg, ...conv.messages],
          lastTimestamp: now,
        };
      });
      // If no conversation existed yet, create one
      if (!updated.find((c) => c.partnerPubkey === selectedPartner)) {
        updated.unshift({
          partnerPubkey: selectedPartner,
          messages: [optimisticMsg],
          lastTimestamp: now,
        });
      }
      return updated;
    });
    setDecryptTick((v) => v + 1);
    // Bump message count so the new-message effect doesn't trigger for our own send
    prevMessageCount.current += 1;
    prevTotalMessages.current += 1;
    // Ensure we're "at bottom" so the scroll works
    isAtBottomRef.current = true;

    // Clear input immediately — user can keep typing
    setMessageInput("");

    // Scroll to bottom
    setTimeout(() => {
      if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }, 50);

    // Publish in background — no await, no blocking
    const partner = selectedPartner;
    const legacy = sendAsLegacy;
    (async () => {
      try {
        if (legacy) {
          await invoke("publish_dm", { content: text, recipientPubkey: partner });
        } else {
          await invoke("publish_gift_wrap_dm", { content: text, recipientPubkey: partner });
        }
        // After publish succeeds, rebuild from local DB to replace optimistic message
        const { convs } = await buildConversations(ownPubkey, signingMode);
        setConversations(convs);
      } catch (e) {
        console.error("[dms] Background publish failed:", e);
        // Mark the optimistic message as failed
        decryptedCache.current.set(optimisticId, `[send failed] ${text}`);
        setDecryptTick((v) => v + 1);
      }
    })();
  }, [messageInput, selectedPartner, signingMode, sendAsLegacy, ownPubkey, buildConversations]);

  // Loading state
  if (loading) {
    return (
      <div className="dms-page-inner">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 48, color: "var(--text-muted)" }}>
          loading DMs...
        </div>
      </div>
    );
  }

  // Full-page empty states (no identity, cannot determine pubkey, error)
  if (emptyReason === "no-identity") {
    return (
      <div className="dms-page-inner">
        <EmptyState
          message="set up your identity in settings first."
          icon={<span className="icon"><IconMessageCircle /></span>}
        />
      </div>
    );
  }

  if (emptyReason === "cannot-determine-pubkey") {
    return (
      <div className="dms-page-inner">
        <EmptyState
          message="could not determine your pubkey."
          icon={<span className="icon"><IconMessageCircle /></span>}
        />
      </div>
    );
  }

  if (emptyReason === "error") {
    return (
      <div className="dms-page-inner">
        <EmptyState
          message="failed to load DMs."
          icon={<span className="icon"><IconMessageCircle /></span>}
        />
      </div>
    );
  }

  // Selected conversation data
  const selectedConv = selectedPartner
    ? conversations.find((c) => c.partnerPubkey === selectedPartner) ?? null
    : null;
  const cache = decryptedCache.current;

  // Determine if a message was sent by us
  function isSentByUs(msg: NostrEvent): boolean {
    if (msg.kind === 1059) {
      // Gift wrap: check the unwrapped sender
      const sender = giftWrapSenderCache.current.get(msg.id);
      return sender === ownPubkey;
    }
    return msg.pubkey === ownPubkey;
  }

  // Get the effective timestamp for sorting (rumor's created_at for gift wraps)
  function effectiveTimestamp(msg: NostrEvent): number {
    const unwrapped = giftWrapCache.current.get(msg.id);
    return unwrapped ? unwrapped.created_at : msg.created_at;
  }

  // Truncate preview text
  function previewText(conv: Conversation): React.ReactNode {
    if (signingMode === "read-only") {
      return <><span className="icon"><IconLock /></span> encrypted</>;
    }
    const lastMsg = conv.messages[0];
    if (!lastMsg) return null;
    const decrypted = cache.get(lastMsg.id);
    if (!decrypted) return "...";
    const maxLen = 40;
    return decrypted.length > maxLen ? decrypted.slice(0, maxLen) + "\u2026" : decrypted;
  }

  // Protocol label for a message
  function protocolTag(msg: NostrEvent): React.ReactNode {
    if (msg.kind === 1059) {
      return <span className="dms-msg-protocol dms-msg-nip17" title="NIP-17 (private)">nip-17</span>;
    }
    return <span className="dms-msg-protocol dms-msg-nip04" title="NIP-04 (legacy)">nip-04</span>;
  }

  // Render right panel
  function renderChatPanel() {
    // No conversation selected
    if (!selectedConv) {
      if (emptyReason === "no-dms" || conversations.length === 0) {
        // No DMs at all
        if (signingMode !== "read-only") {
          return (
            <div className="dms-empty-panel">
              <span className="icon dms-empty-icon"><IconMessageCircle /></span>
              <div className="dms-empty-title">no conversations yet</div>
              <div className="dms-empty-hint">DMs will appear here after the next sync cycle.</div>
            </div>
          );
        }
        return (
          <div className="dms-empty-panel">
            <span className="icon dms-empty-icon"><IconLock /></span>
            <div className="dms-empty-title">enable write mode to send messages</div>
            <div className="dms-empty-hint">connect a signer in settings to decrypt and read your messages.</div>
            <button className="dms-empty-cta" onClick={() => navigate("/settings")}>go to settings</button>
          </div>
        );
      }

      // Has conversations, none selected
      if (signingMode !== "read-only") {
        return (
          <div className="dms-empty-panel">
            <span className="icon dms-empty-icon"><IconMessageCircle /></span>
            <div className="dms-empty-title">select a conversation</div>
            <div className="dms-empty-hint">choose a chat from the sidebar to view messages.</div>
          </div>
        );
      }
      return (
        <div className="dms-empty-panel">
          <span className="icon dms-empty-icon"><IconLock /></span>
          <div className="dms-empty-title">read-only mode</div>
          <div className="dms-empty-hint">connect a signer in settings to decrypt and send messages.</div>
          <button className="dms-empty-cta" onClick={() => navigate("/settings")}>go to settings</button>
        </div>
      );
    }

    // Conversation selected — render thread
    const profile = getProfile(selectedPartner!);
    const name = profileDisplayName(profile, selectedPartner!);
    const avatar = profile?.picture || "";
    const avatarLocal = profile?.picture_local || null;
    const sorted = [...selectedConv.messages].sort((a, b) => effectiveTimestamp(a) - effectiveTimestamp(b));
    const visible = sorted.slice(Math.max(0, sorted.length - displayCount));
    const hasMore = sorted.length > displayCount;

    return (
      <>
        <div className="dms-thread-header">
          <div
            className="dms-thread-profile"
            onClick={() => navigate(`/profile/${selectedPartner}`)}
            title="view profile"
          >
            <Avatar
              picture={avatar || null}
              pictureLocal={avatarLocal}
              pubkey={selectedPartner!}
              className="dms-thread-avatar"
              fallbackClassName="dms-thread-avatar-fallback"
            />
            <span className="dms-thread-name">{name}</span>
          </div>
          <span className="dms-thread-count">{selectedConv.messages.length} msgs</span>
        </div>
        {signingMode === "read-only" && (
          <div className="dms-banner" style={{ margin: "0 16px 0" }}>
            <span className="icon"><IconLock /></span> messages are encrypted. connect a signer in settings to decrypt.
          </div>
        )}
        <div className="dms-thread-messages-wrap">
          <div className="dms-thread-messages" ref={threadRef}>
            <div className="dms-thread-messages-inner">
              {hasMore && <div ref={sentinelRef} className="dms-scroll-sentinel" />}
              {visible.map((msg) => {
                const sent = isSentByUs(msg);
                const timeStr = formatTimestamp(effectiveTimestamp(msg));
                const decrypted = cache.get(msg.id);

                return (
                  <div key={msg.id} className={`dms-msg ${sent ? "dms-msg-sent" : "dms-msg-received"}`}>
                    <div className="dms-msg-bubble">
                      <div className="dms-msg-content">
                        {decrypted
                          ? decrypted
                          : <><span className="icon"><IconLock /></span> encrypted message</>
                        }
                      </div>
                      <div className="dms-msg-meta">
                        {protocolTag(msg)}
                        <span className="dms-msg-time">{timeStr}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          {hasNewMessages && (
            <button className="dms-new-msg-indicator" onClick={() => scrollToBottom(true)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
              new messages
            </button>
          )}
        </div>
        {signingMode !== "read-only" ? (
          <div className="dms-input-bar">
            <input
              type="text"
              placeholder="type a message..."
              value={messageInput}
              onChange={(e) => setMessageInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSendDm(); } }}
            />
            <button
              className="dms-protocol-toggle"
              onClick={() => setSendAsLegacy(!sendAsLegacy)}
              title={sendAsLegacy ? "Sending as NIP-04 (legacy). Click for NIP-17." : "Sending as NIP-17 (private). Click for NIP-04."}
            >
              {sendAsLegacy ? "04" : "17"}
            </button>
            <button onClick={handleSendDm} disabled={!messageInput.trim()}>
              send
            </button>
          </div>
        ) : (
          <div className="dms-input-readonly">
            <span className="icon"><IconLock /></span>
            connect a signer in{" "}
            <span className="dms-settings-link" onClick={() => navigate("/settings")}>settings</span>
            {" "}to send messages
          </div>
        )}
      </>
    );
  }

  // --- Split-pane layout ---
  return (
    <div className="dms-container">
      {/* Sidebar */}
      <div className="dms-sidebar">
        <div className="dms-sidebar-header">
          <span className="icon"><IconMessageCircle /></span>
          <span>conversations</span>
          <span className="dms-sidebar-count">{conversations.length}</span>
        </div>
        <div className="dms-search-wrap">
          <span className="icon dms-search-icon"><IconSearch /></span>
          <input
            type="text"
            className="dms-search-input"
            placeholder="search people..."
            value={searchQuery}
            onChange={(e) => handleSearchInput(e.target.value)}
          />
          {searchQuery && (
            <button className="dms-search-clear" onClick={() => { setSearchQuery(""); setSearchResults([]); }}>
              <span className="icon"><IconX /></span>
            </button>
          )}
        </div>
        {searchQuery.trim() ? (
          <div className="dms-search-results">
            {isSearching && <div className="dms-search-loading">searching...</div>}
            {!isSearching && searchResults.length === 0 && searchQuery.trim() && (
              <div className="dms-search-empty">no profiles found</div>
            )}
            {searchResults.map((p) => {
              const name = profileDisplayName(p, p.pubkey);
              return (
                <div
                  key={p.pubkey}
                  className="dms-conv-item"
                  onClick={() => handleSelectSearchResult(p.pubkey)}
                >
                  <div className="dms-conv-avatar">
                    <Avatar
                      picture={p.picture || null}
                      pictureLocal={p.picture_local || null}
                      pubkey={p.pubkey}
                      className="dms-conv-avatar-img"
                      fallbackClassName="dms-conv-avatar-fallback"
                    />
                  </div>
                  <div className="dms-conv-info">
                    <div className="dms-conv-name">{name}</div>
                    {p.nip05 && <div className="dms-conv-preview">{p.nip05}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        ) : conversations.length === 0 ? (
          <div className="dms-sidebar-empty">no conversations yet</div>
        ) : (
          <div className="dms-conversation-list">
            {conversations.map((conv) => {
              const profile = getProfile(conv.partnerPubkey);
              const name = profileDisplayName(profile, conv.partnerPubkey);
              const avatar = profile?.picture || "";
              const timeStr = formatTimestamp(conv.lastTimestamp);
              const msgCount = conv.messages.length;
              const isActive = selectedPartner === conv.partnerPubkey;

              return (
                <div
                  key={conv.partnerPubkey}
                  className={`dms-conv-item${isActive ? " active" : ""}`}
                  data-partner={conv.partnerPubkey}
                  onClick={() => setSelectedPartner(conv.partnerPubkey)}
                >
                  <div className="dms-conv-avatar">
                    <Avatar
                      picture={avatar || null}
                      pictureLocal={profile?.picture_local || null}
                      pubkey={conv.partnerPubkey}
                      className="dms-conv-avatar-img"
                      fallbackClassName="dms-conv-avatar-fallback"
                    />
                  </div>
                  <div className="dms-conv-info">
                    <div className="dms-conv-name">{name}</div>
                    <div className="dms-conv-preview">
                      {previewText(conv)}
                    </div>
                  </div>
                  <div className="dms-conv-meta">
                    <div className="dms-conv-time">{timeStr}</div>
                    <div className="dms-conv-count">{msgCount}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Chat panel */}
      <div className="dms-chat-panel">
        {renderChatPanel()}
      </div>
    </div>
  );
};
