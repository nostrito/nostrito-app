/** DMs -- Direct Messages screen. Shows encrypted NIP-04 DMs grouped by conversation. */

import React, { useState, useEffect, useCallback } from "react";
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

type DmsView =
  | { kind: "list" }
  | { kind: "thread"; partnerPubkey: string };

export const Dms: React.FC = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [ownPubkey, setOwnPubkey] = useState("");
  const [view, setView] = useState<DmsView>({ kind: "list" });

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
    } catch (e) {
      console.error("[dms] Error loading DMs:", e);
      setEmptyReason("error");
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDms();
  }, [loadDms]);

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

  // Empty states
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

  if (emptyReason === "read-only") {
    return (
      <div className="dms-page-inner">
        <EmptyState
          message="You have DMs but your configuration is read-only."
          icon={<span className="icon"><IconLock /></span>}
          hint="Connect your Nostr account to decrypt and read your messages."
          cta={{ label: "Settings", onClick: () => navigate("/settings") }}
        />
      </div>
    );
  }

  if (emptyReason === "no-dms") {
    return (
      <div className="dms-page-inner">
        <EmptyState
          message="No DMs found yet."
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

  // Thread view
  if (view.kind === "thread") {
    const conv = conversations.find((c) => c.partnerPubkey === view.partnerPubkey);
    if (!conv) return null;

    const profile = getCachedProfile(view.partnerPubkey);
    const name = profileDisplayName(profile, view.partnerPubkey);
    const sorted = [...conv.messages].sort((a, b) => a.created_at - b.created_at);

    return (
      <div className="dms-page-inner">
        <div className="dms-thread-header">
          <button className="dms-back-btn" onClick={() => setView({ kind: "list" })}>
            &#x2190; Back
          </button>
          <span className="dms-thread-name">{name}</span>
          <span className="dms-thread-count">{conv.messages.length} messages</span>
        </div>
        <div className="dms-thread-messages">
          {sorted.map((msg) => {
            const isSent = msg.pubkey === ownPubkey;
            const timeStr = formatTimestamp(msg.created_at);
            return (
              <div key={msg.id} className={`dms-msg ${isSent ? "dms-msg-sent" : "dms-msg-received"}`}>
                <div className="dms-msg-bubble">
                  <div className="dms-msg-content">
                    <span className="icon"><IconLock /></span> Encrypted message — NIP-04
                  </div>
                  <div className="dms-msg-time">{timeStr}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // Conversation list view
  const count = conversations.length;
  const totalMsgs = conversations.reduce((sum, c) => sum + c.messages.length, 0);

  return (
    <div className="dms-page-inner">
      <div className="dms-banner">
        <span>
          <span className="icon"><IconMessageCircle /></span>{" "}
          {count} encrypted conversation{count !== 1 ? "s" : ""} &middot; {totalMsgs} messages &middot; Connect a signer to read
        </span>
      </div>
      <div className="dms-conversation-list">
        {conversations.map((conv) => {
          const profile = getCachedProfile(conv.partnerPubkey);
          const name = profileDisplayName(profile, conv.partnerPubkey);
          const avatar = profile?.picture || "";
          const timeStr = formatTimestamp(conv.lastTimestamp);
          const msgCount = conv.messages.length;

          return (
            <div
              key={conv.partnerPubkey}
              className="dms-conv-item"
              data-partner={conv.partnerPubkey}
              onClick={() => setView({ kind: "thread", partnerPubkey: conv.partnerPubkey })}
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
                  <span className="icon"><IconLock /></span> Encrypted
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
    </div>
  );
};
