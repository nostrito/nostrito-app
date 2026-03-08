/** DMs — Direct Messages screen. Shows encrypted NIP-04 DMs grouped by conversation. */

import { invoke } from "@tauri-apps/api/core";
import { getProfiles, getCachedProfile, profileDisplayName } from "../utils/profiles";

interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

interface Settings {
  npub: string;
  relay_port: number;
  max_storage_mb: number;
  wot_max_depth: number;
  sync_interval_secs: number;
  outbound_relays: string[];
  auto_start: boolean;
}

interface Conversation {
  partnerPubkey: string;
  messages: NostrEvent[];
  lastTimestamp: number;
}

let allConversations: Conversation[] = [];
let ownPubkey: string = "";

export function renderDms(container: HTMLElement): void {
  container.className = "main-content";
  allConversations = [];
  ownPubkey = "";

  container.innerHTML = `
    <div class="dms-page-inner" id="dms-root">
      <div style="display:flex;align-items:center;justify-content:center;padding:48px;color:var(--text-muted);">
        Loading DMs...
      </div>
    </div>
  `;

  loadDms();
}

async function loadDms(): Promise<void> {
  const root = document.getElementById("dms-root");
  if (!root) return;

  try {
    // Get own pubkey from settings
    const settings = await invoke<Settings>("get_settings");
    if (!settings.npub) {
      root.innerHTML = renderEmpty("Set up your identity in Settings first.");
      return;
    }

    // Convert npub to hex if needed
    if (settings.npub.startsWith("npub1")) {
      // Use the backend's hex_pubkey via get_status
      const profile = await invoke<{ pubkey: string } | null>("get_own_profile");
      if (profile) {
        ownPubkey = profile.pubkey;
      } else {
        root.innerHTML = renderEmpty("Could not determine your pubkey.");
        return;
      }
    } else {
      ownPubkey = settings.npub;
    }

    // Fetch DM events
    const events = await invoke<NostrEvent[]>("get_dm_events", {
      ownPubkey: ownPubkey,
      limit: 200,
    });

    if (!events || events.length === 0) {
      root.innerHTML = renderEmpty("No DMs found yet.");
      return;
    }

    // Group by conversation partner
    const convMap = new Map<string, NostrEvent[]>();
    for (const ev of events) {
      const partner = getPartner(ev, ownPubkey);
      if (!partner) continue;
      if (!convMap.has(partner)) convMap.set(partner, []);
      convMap.get(partner)!.push(ev);
    }

    // Sort conversations by most recent message
    allConversations = Array.from(convMap.entries())
      .map(([partnerPubkey, messages]) => ({
        partnerPubkey,
        messages: messages.sort((a, b) => b.created_at - a.created_at),
        lastTimestamp: Math.max(...messages.map((m) => m.created_at)),
      }))
      .sort((a, b) => b.lastTimestamp - a.lastTimestamp);

    // Fetch profiles for all partners
    const partnerKeys = allConversations.map((c) => c.partnerPubkey);
    await getProfiles(partnerKeys);

    renderConversationList(root);
  } catch (e) {
    console.error("[dms] Error loading DMs:", e);
    root.innerHTML = renderEmpty("Failed to load DMs.");
  }
}

function getPartner(event: NostrEvent, ownPk: string): string | null {
  if (event.pubkey === ownPk) {
    // We sent it — partner is the "p" tag recipient
    const pTag = event.tags.find((t) => t[0] === "p" && t[1]);
    return pTag ? pTag[1] : null;
  } else {
    // We received it — partner is the sender
    return event.pubkey;
  }
}

function renderEmpty(message: string): string {
  return `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 24px;color:var(--text-muted);text-align:center;gap:12px;">
      <div style="font-size:2rem;">💬</div>
      <div style="font-size:0.95rem;font-weight:500;color:var(--text-dim);">${message}</div>
    </div>
  `;
}

function renderConversationList(root: HTMLElement): void {
  const count = allConversations.length;
  const totalMsgs = allConversations.reduce((sum, c) => sum + c.messages.length, 0);

  let html = `
    <div class="dms-banner">
      <span>💬 ${count} encrypted conversation${count !== 1 ? "s" : ""} · ${totalMsgs} messages · Connect a signer to read</span>
    </div>
    <div class="dms-conversation-list">
  `;

  for (const conv of allConversations) {
    const profile = getCachedProfileSafe(conv.partnerPubkey);
    const name = profileDisplayName(profile, conv.partnerPubkey);
    const avatar = profile?.picture || "";
    const timeStr = formatTimestamp(conv.lastTimestamp);
    const msgCount = conv.messages.length;

    html += `
      <div class="dms-conv-item" data-partner="${conv.partnerPubkey}">
        <div class="dms-conv-avatar">
          ${avatar ? `<img src="${escapeHtml(avatar)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" />` : ""}
          <div class="dms-conv-avatar-fallback" ${avatar ? 'style="display:none"' : ""}>${name.charAt(0).toUpperCase()}</div>
        </div>
        <div class="dms-conv-info">
          <div class="dms-conv-name">${escapeHtml(name)}</div>
          <div class="dms-conv-preview">🔒 Encrypted</div>
        </div>
        <div class="dms-conv-meta">
          <div class="dms-conv-time">${timeStr}</div>
          <div class="dms-conv-count">${msgCount}</div>
        </div>
      </div>
    `;
  }

  html += `</div>`;
  root.innerHTML = html;

  // Add click handlers
  root.querySelectorAll(".dms-conv-item").forEach((el) => {
    el.addEventListener("click", () => {
      const partner = (el as HTMLElement).dataset.partner;
      if (partner) renderThread(root, partner);
    });
  });
}

function renderThread(root: HTMLElement, partnerPubkey: string): void {
  const conv = allConversations.find((c) => c.partnerPubkey === partnerPubkey);
  if (!conv) return;

  const profile = getCachedProfileSafe(partnerPubkey);
  const name = profileDisplayName(profile, partnerPubkey);

  let html = `
    <div class="dms-thread-header">
      <button class="dms-back-btn" id="dms-back">← Back</button>
      <span class="dms-thread-name">${escapeHtml(name)}</span>
      <span class="dms-thread-count">${conv.messages.length} messages</span>
    </div>
    <div class="dms-thread-messages">
  `;

  // Messages sorted oldest first for thread view
  const sorted = [...conv.messages].sort((a, b) => a.created_at - b.created_at);

  for (const msg of sorted) {
    const isSent = msg.pubkey === ownPubkey;
    const timeStr = formatTimestamp(msg.created_at);

    html += `
      <div class="dms-msg ${isSent ? "dms-msg-sent" : "dms-msg-received"}">
        <div class="dms-msg-bubble">
          <div class="dms-msg-content">🔒 Encrypted message — NIP-04</div>
          <div class="dms-msg-time">${timeStr}</div>
        </div>
      </div>
    `;
  }

  html += `</div>`;
  root.innerHTML = html;

  // Back button
  document.getElementById("dms-back")?.addEventListener("click", () => {
    renderConversationList(root);
  });
}

function formatTimestamp(ts: number): string {
  const date = new Date(ts * 1000);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } else if (diffDays === 1) {
    return "Yesterday";
  } else if (diffDays < 7) {
    return date.toLocaleDateString([], { weekday: "short" });
  } else {
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getCachedProfileSafe(pubkey: string) {
  return getCachedProfile(pubkey);
}
