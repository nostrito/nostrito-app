/** DMs -- Direct Messages screen. Shows NIP-04 DMs grouped by conversation.
 *  When nsec is available, messages are decrypted; otherwise shown as encrypted. */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { IconMessageCircle, IconLock } from "../components/Icon";
import { Avatar } from "../components/Avatar";
import { EmptyState } from "../components/EmptyState";
import { formatTimestamp } from "../utils/format";
import { getCachedProfile, getProfiles, profileDisplayName } from "../utils/profiles";
import type { NostrEvent, Settings, Conversation } from "../types/nostr";

function getPartner(event: NostrEvent, ownPk: string): string | null {
  if (event.pubkey === ownPk) {
    const pTag = event.tags.find((t) => t[0] === "p" && t[1]);
    return pTag ? pTag[1] : null;
  }
  return event.pubkey;
}

export const Dms: React.FC = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [ownPubkey, setOwnPubkey] = useState("");
  const [selectedPartner, setSelectedPartner] = useState<string | null>(null);
  const [signingMode, setSigningMode] = useState<"nsec" | "read-only">("read-only");

  // Cache for decrypted message content: eventId -> plaintext
  const decryptedCache = useRef<Map<string, string>>(new Map());
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

      // Check signing mode
      let mode: string = "read-only";
      try {
        mode = await invoke<string>("get_signing_mode");
        setSigningMode(mode as "nsec" | "read-only");
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

      const events = await invoke<NostrEvent[]>("get_dm_events", {
        ownPubkey: pk,
        limit: 200,
      });

      if (!events || events.length === 0) {
        try {
          const kindCounts = await invoke<{ counts: Record<number, number> }>("get_kind_counts");
          const dmCount = kindCounts.counts[4] || 0;
          if (dmCount > 0) {
            setEmptyReason("read-only");
            setLoading(false);
            return;
          }
        } catch {
          /* kind counts not critical */
        }
        setEmptyReason("no-dms");
        setLoading(false);
        return;
      }

      // Group by conversation partner
      const convMap = new Map<string, NostrEvent[]>();
      for (const ev of events) {
        const partner = getPartner(ev, pk);
        if (!partner) continue;
        if (!convMap.has(partner)) convMap.set(partner, []);
        convMap.get(partner)!.push(ev);
      }

      const sorted = Array.from(convMap.entries())
        .map(([partnerPubkey, messages]) => ({
          partnerPubkey,
          messages: messages.sort((a, b) => b.created_at - a.created_at),
          lastTimestamp: Math.max(...messages.map((m) => m.created_at)),
        }))
        .sort((a, b) => b.lastTimestamp - a.lastTimestamp);

      // Fetch profiles for all partners
      const partnerKeys = sorted.map((c) => c.partnerPubkey);
      await getProfiles(partnerKeys);

      setConversations(sorted);
      setLoading(false);

      // Decrypt last message of each conversation for sidebar preview
      if (mode === "nsec") {
        decryptPreviews(sorted, pk);
      }
    } catch (e) {
      console.error("[dms] Error loading DMs:", e);
      setEmptyReason("error");
      setLoading(false);
    }

    // Inner helper — uses closure over decryptedCache
    async function decryptPreviews(convs: Conversation[], pk: string) {
      const cache = decryptedCache.current;
      let updated = false;
      for (const conv of convs) {
        const lastMsg = conv.messages[0]; // sorted desc, first = latest
        if (!lastMsg || cache.has(lastMsg.id)) continue;
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
  }, []);

  useEffect(() => {
    loadDms();
  }, [loadDms]);

  // Decrypt messages for the selected thread
  const decryptThread = useCallback(async (messages: NostrEvent[], partnerPubkey: string) => {
    const cache = decryptedCache.current;
    let updated = false;

    for (const msg of messages) {
      if (cache.has(msg.id)) continue;

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
    if (!selectedPartner || signingMode !== "nsec") return;

    const conv = conversations.find((c) => c.partnerPubkey === selectedPartner);
    if (!conv) return;

    decryptThread(conv.messages, selectedPartner);
  }, [selectedPartner, signingMode, conversations, decryptThread]);

  // Auto-scroll thread to bottom
  const threadRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selectedPartner && threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [selectedPartner, conversations]);

  // Loading state
  if (loading) {
    return (
      <div className="dms-page-inner">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 48, color: "var(--text-muted)" }}>
          Loading DMs...
        </div>
      </div>
    );
  }

  // Full-page empty states (no identity, cannot determine pubkey, error)
  if (emptyReason === "no-identity") {
    return (
      <div className="dms-page-inner">
        <EmptyState
          message="Set up your identity in Settings first."
          icon={<span className="icon"><IconMessageCircle /></span>}
        />
      </div>
    );
  }

  if (emptyReason === "cannot-determine-pubkey") {
    return (
      <div className="dms-page-inner">
        <EmptyState
          message="Could not determine your pubkey."
          icon={<span className="icon"><IconMessageCircle /></span>}
        />
      </div>
    );
  }

  if (emptyReason === "error") {
    return (
      <div className="dms-page-inner">
        <EmptyState
          message="Failed to load DMs."
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

  // Truncate preview text
  function previewText(conv: Conversation): React.ReactNode {
    if (signingMode !== "nsec") {
      return <><span className="icon"><IconLock /></span> Encrypted</>;
    }
    const lastMsg = conv.messages[0];
    if (!lastMsg) return null;
    const decrypted = cache.get(lastMsg.id);
    if (!decrypted) return "...";
    const maxLen = 40;
    return decrypted.length > maxLen ? decrypted.slice(0, maxLen) + "\u2026" : decrypted;
  }

  // Render right panel
  function renderChatPanel() {
    // No conversation selected
    if (!selectedConv) {
      if (emptyReason === "no-dms" || conversations.length === 0) {
        // No DMs at all
        if (signingMode === "nsec") {
          return (
            <div className="dms-empty-panel">
              <span className="icon dms-empty-icon"><IconMessageCircle /></span>
              <div className="dms-empty-title">No conversations yet</div>
              <div className="dms-empty-hint">DMs will appear here after the next sync cycle.</div>
            </div>
          );
        }
        return (
          <div className="dms-empty-panel">
            <span className="icon dms-empty-icon"><IconLock /></span>
            <div className="dms-empty-title">Enable write mode to send messages</div>
            <div className="dms-empty-hint">Add your nsec in Settings to decrypt and read your messages.</div>
            <button className="dms-empty-cta" onClick={() => navigate("/settings")}>Go to Settings</button>
          </div>
        );
      }

      // Has conversations, none selected
      if (signingMode === "nsec") {
        return (
          <div className="dms-empty-panel">
            <span className="icon dms-empty-icon"><IconMessageCircle /></span>
            <div className="dms-empty-title">Select a conversation</div>
            <div className="dms-empty-hint">Choose a chat from the sidebar to view messages.</div>
          </div>
        );
      }
      return (
        <div className="dms-empty-panel">
          <span className="icon dms-empty-icon"><IconLock /></span>
          <div className="dms-empty-title">Read-only mode</div>
          <div className="dms-empty-hint">Add your nsec in Settings to decrypt and send messages.</div>
          <button className="dms-empty-cta" onClick={() => navigate("/settings")}>Go to Settings</button>
        </div>
      );
    }

    // Conversation selected — render thread
    const profile = getCachedProfile(selectedPartner!);
    const name = profileDisplayName(profile, selectedPartner!);
    const avatar = profile?.picture || "";
    const sorted = [...selectedConv.messages].sort((a, b) => a.created_at - b.created_at);

    return (
      <>
        <div className="dms-thread-header">
          <div
            className="dms-thread-profile"
            onClick={() => navigate(`/profile/${selectedPartner}`)}
            title="View profile"
          >
            <Avatar
              picture={avatar || null}
              pubkey={selectedPartner!}
              className="dms-thread-avatar"
              fallbackClassName="dms-thread-avatar-fallback"
            />
            <span className="dms-thread-name">{name}</span>
          </div>
          <span className="dms-thread-count">{selectedConv.messages.length} messages</span>
        </div>
        {signingMode !== "nsec" && (
          <div className="dms-banner" style={{ margin: "0 16px 0" }}>
            <span className="icon"><IconLock /></span> Messages are encrypted. Add your nsec in Settings to decrypt.
          </div>
        )}
        <div className="dms-thread-messages" ref={threadRef}>
          {sorted.map((msg) => {
            const isSent = msg.pubkey === ownPubkey;
            const timeStr = formatTimestamp(msg.created_at);
            const decrypted = cache.get(msg.id);

            return (
              <div key={msg.id} className={`dms-msg ${isSent ? "dms-msg-sent" : "dms-msg-received"}`}>
                <div className="dms-msg-bubble">
                  <div className="dms-msg-content">
                    {decrypted
                      ? decrypted
                      : <><span className="icon"><IconLock /></span> Encrypted message</>
                    }
                  </div>
                  <div className="dms-msg-time">{timeStr}</div>
                </div>
              </div>
            );
          })}
        </div>
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
          <span>Conversations</span>
          <span className="dms-sidebar-count">{conversations.length}</span>
        </div>
        {conversations.length === 0 ? (
          <div className="dms-sidebar-empty">No conversations yet</div>
        ) : (
          <div className="dms-conversation-list">
            {conversations.map((conv) => {
              const profile = getCachedProfile(conv.partnerPubkey);
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
