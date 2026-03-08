/** Web of Trust — trust graph view matching reference design */

import { invoke } from "@tauri-apps/api/core";

interface WotStatus {
  root_pubkey: string;
  node_count: number;
  edge_count: number;
  nodes_with_follows: number;
}

function shortPubkey(pk: string): string {
  if (pk.length > 12) return pk.slice(0, 8) + "..." + pk.slice(-4);
  return pk;
}

export async function renderWot(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <div class="wot-page-inner">
      <div class="wot-stats">
        <div class="wot-stat-card">
          <div class="wot-stat-val" id="wot-nodes">—</div>
          <div class="wot-stat-label">Total Nodes</div>
        </div>
        <div class="wot-stat-card">
          <div class="wot-stat-val" id="wot-edges">—</div>
          <div class="wot-stat-label">Edges</div>
        </div>
        <div class="wot-stat-card">
          <div class="wot-stat-val" id="wot-with-follows">—</div>
          <div class="wot-stat-label">With Follows</div>
        </div>
      </div>

      <div class="wot-graph-wrap" id="wot-graph">
        <svg viewBox="0 0 400 300" width="360" height="270">
          <circle cx="200" cy="150" r="120" fill="none" stroke="#2a2a34" stroke-width="1" stroke-dasharray="4,4"/>
          <circle cx="200" cy="150" r="80" fill="none" stroke="#2a2a34" stroke-width="1" stroke-dasharray="4,4"/>
          <circle cx="200" cy="150" r="40" fill="none" stroke="#7c3aed" stroke-width="1.5" stroke-dasharray="4,4"/>
          <circle cx="200" cy="150" r="8" fill="#7c3aed"/>
          <text x="200" y="175" text-anchor="middle" fill="#8b5cf6" font-size="10" font-weight="600">You</text>
          <!-- 1-hop dots -->
          <circle cx="240" cy="130" r="5" fill="#a78bfa" opacity="0.9"/>
          <circle cx="170" cy="120" r="5" fill="#a78bfa" opacity="0.9"/>
          <circle cx="210" cy="115" r="4" fill="#a78bfa" opacity="0.8"/>
          <circle cx="185" cy="180" r="5" fill="#a78bfa" opacity="0.9"/>
          <circle cx="225" cy="175" r="4" fill="#a78bfa" opacity="0.8"/>
          <circle cx="160" cy="150" r="5" fill="#a78bfa" opacity="0.9"/>
          <circle cx="230" cy="150" r="4" fill="#a78bfa" opacity="0.8"/>
          <line x1="200" y1="150" x2="240" y2="130" stroke="#7c3aed" stroke-width="0.5" opacity="0.3"/>
          <line x1="200" y1="150" x2="170" y2="120" stroke="#7c3aed" stroke-width="0.5" opacity="0.3"/>
          <line x1="200" y1="150" x2="185" y2="180" stroke="#7c3aed" stroke-width="0.5" opacity="0.3"/>
          <line x1="200" y1="150" x2="160" y2="150" stroke="#7c3aed" stroke-width="0.5" opacity="0.3"/>
          <line x1="200" y1="150" x2="230" y2="150" stroke="#7c3aed" stroke-width="0.5" opacity="0.3"/>
          <!-- 2-hop dots -->
          <circle cx="280" cy="110" r="3.5" fill="#60a5fa" opacity="0.6"/>
          <circle cx="130" cy="100" r="3.5" fill="#60a5fa" opacity="0.6"/>
          <circle cx="260" cy="190" r="3" fill="#60a5fa" opacity="0.5"/>
          <circle cx="140" cy="180" r="3.5" fill="#60a5fa" opacity="0.6"/>
          <circle cx="270" cy="155" r="3" fill="#60a5fa" opacity="0.5"/>
          <line x1="240" y1="130" x2="280" y2="110" stroke="#60a5fa" stroke-width="0.4" opacity="0.2"/>
          <line x1="170" y1="120" x2="130" y2="100" stroke="#60a5fa" stroke-width="0.4" opacity="0.2"/>
          <line x1="185" y1="180" x2="140" y2="180" stroke="#60a5fa" stroke-width="0.4" opacity="0.2"/>
          <!-- Legend -->
          <circle cx="30" cy="20" r="5" fill="#a78bfa"/><text x="42" y="24" fill="#7a7a90" font-size="9">1-hop</text>
          <circle cx="30" cy="38" r="4" fill="#60a5fa"/><text x="42" y="42" fill="#7a7a90" font-size="9">2-hop</text>
          <circle cx="30" cy="56" r="3" fill="#34d399"/><text x="42" y="60" fill="#7a7a90" font-size="9">3-hop</text>
        </svg>
      </div>

      <div id="wot-root-info" style="font-size:0.82rem;color:var(--text-dim);margin-bottom:16px;font-family:var(--mono);">
        Loading...
      </div>
    </div>
  `;

  try {
    const wot = await invoke<WotStatus>("get_wot");
    const nodesEl = document.getElementById("wot-nodes");
    const edgesEl = document.getElementById("wot-edges");
    const followsEl = document.getElementById("wot-with-follows");
    const rootEl = document.getElementById("wot-root-info");

    if (nodesEl) nodesEl.textContent = wot.node_count.toLocaleString();
    if (edgesEl) edgesEl.textContent = wot.edge_count.toLocaleString();
    if (followsEl) followsEl.textContent = wot.nodes_with_follows.toLocaleString();
    if (rootEl) rootEl.textContent = wot.root_pubkey ? `Root: ${shortPubkey(wot.root_pubkey)}` : "No root set";
  } catch (e) {
    console.error("[wot]", e);
  }
}
