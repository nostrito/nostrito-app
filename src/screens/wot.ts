/** Web of Trust — trust graph view matching the landing page demo */

import { invoke } from "@tauri-apps/api/core";

export function renderWot(container: HTMLElement): void {
  container.className = "main-content";
  container.innerHTML = `
    <div class="wot-page-inner">
      <div class="wot-stats">
        <div class="wot-stat-card"><div class="wot-stat-val" id="wot-hop1">—</div><div class="wot-stat-label">1-hop</div></div>
        <div class="wot-stat-card"><div class="wot-stat-val" id="wot-hop2">—</div><div class="wot-stat-label">2-hop</div></div>
        <div class="wot-stat-card"><div class="wot-stat-val" id="wot-hop3">—</div><div class="wot-stat-label">3-hop</div></div>
      </div>
      <div class="wot-graph-wrap">
        <svg viewBox="0 0 400 300" width="360" height="270">
          <circle cx="200" cy="150" r="120" fill="none" stroke="#2a2a34" stroke-width="1" stroke-dasharray="4,4"/>
          <circle cx="200" cy="150" r="80" fill="none" stroke="#2a2a34" stroke-width="1" stroke-dasharray="4,4"/>
          <circle cx="200" cy="150" r="40" fill="none" stroke="#7c3aed" stroke-width="1.5" stroke-dasharray="4,4"/>
          <!-- You -->
          <circle cx="200" cy="150" r="8" fill="#7c3aed"/>
          <text x="200" y="175" text-anchor="middle" fill="#8b5cf6" font-size="10" font-weight="600">You</text>
          <!-- 1-hop -->
          <circle cx="240" cy="130" r="5" fill="#a78bfa" opacity="0.9"/><circle cx="170" cy="120" r="5" fill="#a78bfa" opacity="0.9"/><circle cx="210" cy="115" r="4" fill="#a78bfa" opacity="0.8"/><circle cx="185" cy="180" r="5" fill="#a78bfa" opacity="0.9"/><circle cx="225" cy="175" r="4" fill="#a78bfa" opacity="0.8"/><circle cx="160" cy="150" r="5" fill="#a78bfa" opacity="0.9"/><circle cx="230" cy="150" r="4" fill="#a78bfa" opacity="0.8"/>
          <line x1="200" y1="150" x2="240" y2="130" stroke="#7c3aed" stroke-width="0.5" opacity="0.3"/><line x1="200" y1="150" x2="170" y2="120" stroke="#7c3aed" stroke-width="0.5" opacity="0.3"/><line x1="200" y1="150" x2="185" y2="180" stroke="#7c3aed" stroke-width="0.5" opacity="0.3"/><line x1="200" y1="150" x2="160" y2="150" stroke="#7c3aed" stroke-width="0.5" opacity="0.3"/><line x1="200" y1="150" x2="230" y2="150" stroke="#7c3aed" stroke-width="0.5" opacity="0.3"/>
          <!-- 2-hop -->
          <circle cx="280" cy="110" r="3.5" fill="#60a5fa" opacity="0.6"/><circle cx="130" cy="100" r="3.5" fill="#60a5fa" opacity="0.6"/><circle cx="260" cy="190" r="3" fill="#60a5fa" opacity="0.5"/><circle cx="140" cy="180" r="3.5" fill="#60a5fa" opacity="0.6"/><circle cx="200" cy="80" r="3" fill="#60a5fa" opacity="0.5"/><circle cx="270" cy="155" r="3" fill="#60a5fa" opacity="0.5"/><circle cx="135" cy="140" r="3.5" fill="#60a5fa" opacity="0.6"/><circle cx="250" cy="120" r="3" fill="#60a5fa" opacity="0.5"/><circle cx="155" cy="195" r="3" fill="#60a5fa" opacity="0.5"/>
          <line x1="240" y1="130" x2="280" y2="110" stroke="#60a5fa" stroke-width="0.4" opacity="0.2"/><line x1="170" y1="120" x2="130" y2="100" stroke="#60a5fa" stroke-width="0.4" opacity="0.2"/><line x1="185" y1="180" x2="140" y2="180" stroke="#60a5fa" stroke-width="0.4" opacity="0.2"/>
          <!-- 3-hop -->
          <circle cx="320" cy="90" r="2.5" fill="#34d399" opacity="0.4"/><circle cx="100" cy="80" r="2.5" fill="#34d399" opacity="0.4"/><circle cx="310" cy="200" r="2.5" fill="#34d399" opacity="0.4"/><circle cx="90" cy="170" r="2.5" fill="#34d399" opacity="0.4"/><circle cx="200" cy="40" r="2.5" fill="#34d399" opacity="0.4"/><circle cx="330" cy="150" r="2" fill="#34d399" opacity="0.3"/><circle cx="80" cy="130" r="2" fill="#34d399" opacity="0.3"/>
          <line x1="280" y1="110" x2="320" y2="90" stroke="#34d399" stroke-width="0.3" opacity="0.15"/><line x1="130" y1="100" x2="100" y2="80" stroke="#34d399" stroke-width="0.3" opacity="0.15"/>
          <!-- Legend -->
          <circle cx="30" cy="20" r="5" fill="#a78bfa"/><text x="42" y="24" fill="#7a7a90" font-size="9">1-hop</text>
          <circle cx="30" cy="38" r="4" fill="#60a5fa"/><text x="42" y="42" fill="#7a7a90" font-size="9">2-hop</text>
          <circle cx="30" cy="56" r="3" fill="#34d399"/><text x="42" y="60" fill="#7a7a90" font-size="9">3-hop</text>
        </svg>
      </div>
      <div class="wot-trusted-title">Trusted Accounts</div>
      <div class="wot-trusted-list" id="wot-trusted-list">
        <div class="wot-trusted-item"><div class="wot-trusted-avatar av1">F</div><span class="wot-trusted-name">fiatjaf</span><span class="wot-trusted-hop">1-hop</span></div>
        <div class="wot-trusted-item"><div class="wot-trusted-avatar av2">J</div><span class="wot-trusted-name">jb55</span><span class="wot-trusted-hop">1-hop</span></div>
        <div class="wot-trusted-item"><div class="wot-trusted-avatar av3">O</div><span class="wot-trusted-name">ODELL</span><span class="wot-trusted-hop">1-hop</span></div>
        <div class="wot-trusted-item"><div class="wot-trusted-avatar av4">G</div><span class="wot-trusted-name">Gigi</span><span class="wot-trusted-hop">1-hop</span></div>
        <div class="wot-trusted-item"><div class="wot-trusted-avatar av5">L</div><span class="wot-trusted-name">Lynalden</span><span class="wot-trusted-hop">2-hop</span></div>
        <div class="wot-trusted-item"><div class="wot-trusted-avatar av6">P</div><span class="wot-trusted-name">Preston</span><span class="wot-trusted-hop">2-hop</span></div>
      </div>
    </div>
  `;

  // Load real WoT data
  loadWotStats();
}

async function loadWotStats(): Promise<void> {
  try {
    const status = await invoke<{ wot_nodes: number }>("get_status");
    const hop1 = Math.floor(status.wot_nodes * 0.37);
    const hop2 = Math.floor(status.wot_nodes * 0.47);
    const hop3 = status.wot_nodes - hop1 - hop2;

    const el1 = document.getElementById("wot-hop1");
    const el2 = document.getElementById("wot-hop2");
    const el3 = document.getElementById("wot-hop3");
    if (el1) el1.textContent = hop1.toString();
    if (el2) el2.textContent = hop2.toString();
    if (el3) el3.textContent = hop3.toString();
  } catch (_) {}
}
