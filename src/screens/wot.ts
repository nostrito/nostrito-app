/** Web of Trust — trust graph view. Stats from get_wot backend command. */

import { invoke } from "@tauri-apps/api/core";

interface WotStatus {
  root_pubkey: string;
  node_count: number;
  edge_count: number;
  nodes_with_follows: number;
}

export function renderWot(container: HTMLElement): void {
  container.className = "main-content";
  container.innerHTML = `
    <div class="wot-page-inner">
      <div class="wot-stats">
        <div class="wot-stat-card"><div class="wot-stat-val" id="wot-nodes">—</div><div class="wot-stat-label">Nodes</div></div>
        <div class="wot-stat-card"><div class="wot-stat-val" id="wot-edges">—</div><div class="wot-stat-label">Edges</div></div>
        <div class="wot-stat-card"><div class="wot-stat-val" id="wot-with-follows">—</div><div class="wot-stat-label">With Follows</div></div>
      </div>
      <div class="wot-graph-wrap">
        <svg viewBox="0 0 400 300" width="360" height="270">
          <circle cx="200" cy="150" r="120" fill="none" stroke="#2a2a34" stroke-width="1" stroke-dasharray="4,4"/>
          <circle cx="200" cy="150" r="80" fill="none" stroke="#2a2a34" stroke-width="1" stroke-dasharray="4,4"/>
          <circle cx="200" cy="150" r="40" fill="none" stroke="#7c3aed" stroke-width="1.5" stroke-dasharray="4,4"/>
          <!-- You -->
          <circle cx="200" cy="150" r="8" fill="#7c3aed"/>
          <text x="200" y="175" text-anchor="middle" fill="#8b5cf6" font-size="10" font-weight="600">You</text>
          <!-- Legend -->
          <circle cx="30" cy="20" r="5" fill="#a78bfa"/><text x="42" y="24" fill="#7a7a90" font-size="9">1-hop</text>
          <circle cx="30" cy="38" r="4" fill="#60a5fa"/><text x="42" y="42" fill="#7a7a90" font-size="9">2-hop</text>
          <circle cx="30" cy="56" r="3" fill="#34d399"/><text x="42" y="60" fill="#7a7a90" font-size="9">3-hop</text>
        </svg>
      </div>
      <div class="wot-trusted-title">Graph Summary</div>
      <div id="wot-summary" style="color:var(--text-muted);font-size:0.85rem;padding:8px 0;">
        Loading WoT data...
      </div>
    </div>
  `;

  loadWotStats();
}

async function loadWotStats(): Promise<void> {
  try {
    console.log("[wot] Calling get_wot...");
    const wot = await invoke<WotStatus>("get_wot");
    console.log("[wot] get_wot response:", JSON.stringify(wot));

    const nodesEl = document.getElementById("wot-nodes");
    const edgesEl = document.getElementById("wot-edges");
    const followsEl = document.getElementById("wot-with-follows");
    if (nodesEl) nodesEl.textContent = wot.node_count.toLocaleString();
    if (edgesEl) edgesEl.textContent = wot.edge_count.toLocaleString();
    if (followsEl) followsEl.textContent = wot.nodes_with_follows.toLocaleString();

    const summaryEl = document.getElementById("wot-summary");
    if (summaryEl) {
      if (wot.node_count === 0) {
        summaryEl.textContent = "No WoT data yet — sync will populate the trust graph.";
      } else {
        const rootShort = wot.root_pubkey.length > 12
          ? wot.root_pubkey.slice(0, 8) + "…" + wot.root_pubkey.slice(-4)
          : wot.root_pubkey || "—";
        summaryEl.innerHTML = `
          Root: <span style="font-family:var(--mono);color:var(--accent-light)">${rootShort}</span><br>
          ${wot.node_count.toLocaleString()} unique pubkeys discovered across ${wot.edge_count.toLocaleString()} follow relationships.
          ${wot.nodes_with_follows} nodes have published contact lists.
        `;
      }
    }
  } catch (_) {
    const summaryEl = document.getElementById("wot-summary");
    if (summaryEl) summaryEl.textContent = "Failed to load WoT stats.";
  }
}
