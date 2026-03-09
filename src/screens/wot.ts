/** Web of Trust — interactive canvas-based graph explorer with lazy expansion. */

import { invoke } from "@tauri-apps/api/core";

interface WotNode {
  pubkey: string;
  name: string;
  picture?: string;
  x: number;
  y: number;
  radius: number;
  color: string;
  hop: number;
  expanded: boolean;
  followCount: number;
  parentPubkey?: string;
}

interface WotEdge {
  from: string;
  to: string;
}

const CX = 400,
  CY = 350;
const HOP_RADIUS = [0, 160, 280];
const NODE_COLORS = ["#7c3aed", "#4f46e5", "#0ea5e9", "#10b981"];
const MAX_NODES_PER_EXPAND = 40;

let nodes: Map<string, WotNode> = new Map();
let edges: WotEdge[] = [];
let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;
let selectedPubkey: string | null = null;
let myPubkey: string = "";
let avatarCache: Map<string, HTMLImageElement> = new Map();

function shortName(node: WotNode): string {
  if (node.name) return node.name.slice(0, 12);
  return node.pubkey.slice(0, 6) + "\u2026";
}

function nodeColor(hop: number): string {
  return NODE_COLORS[Math.min(hop, NODE_COLORS.length - 1)];
}

function placeRing(
  pubkeys: string[],
  cx: number,
  cy: number,
  radius: number,
  startAngle = 0,
  arcSpan = Math.PI * 2,
): { [pk: string]: { x: number; y: number } } {
  const positions: { [pk: string]: { x: number; y: number } } = {};
  const n = pubkeys.length;
  if (n === 0) return positions;
  const step = n === 1 ? 0 : arcSpan / n;
  pubkeys.forEach((pk, i) => {
    const angle = startAngle + i * step;
    positions[pk] = {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
    };
  });
  return positions;
}

async function loadAvatars(nodeList: WotNode[]): Promise<void> {
  const toLoad = nodeList.filter((n) => n.picture && !avatarCache.has(n.pubkey));
  await Promise.all(
    toLoad.map(
      (n) =>
        new Promise<void>((resolve) => {
          const img = new Image();
          img.crossOrigin = "anonymous";
          img.onload = () => {
            avatarCache.set(n.pubkey, img);
            resolve();
          };
          img.onerror = () => resolve();
          img.src = n.picture!;
        }),
    ),
  );
}

function draw(): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Background
  ctx.fillStyle = "#0a0a0c";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw edges
  ctx.lineWidth = 0.8;
  for (const edge of edges) {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from || !to) continue;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    const opacity = to.hop === 1 ? 0.25 : 0.12;
    ctx.strokeStyle = `rgba(124,58,237,${opacity})`;
    ctx.stroke();
  }

  // Draw nodes
  for (const node of nodes.values()) {
    const isSelected = node.pubkey === selectedPubkey;
    const isYou = node.pubkey === myPubkey;
    const r = node.radius;

    // Glow for selected
    if (isSelected) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + 6, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(124,58,237,0.2)";
      ctx.fill();
    }

    // Node circle
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    ctx.fillStyle = node.color;
    ctx.fill();

    // Avatar (clip to circle)
    const img = avatarCache.get(node.pubkey);
    if (img) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(img, node.x - r, node.y - r, r * 2, r * 2);
      ctx.restore();
    }

    // Border
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = isSelected
      ? "#a78bfa"
      : isYou
        ? "#7c3aed"
        : "rgba(255,255,255,0.1)";
    ctx.lineWidth = isSelected ? 2 : 1;
    ctx.stroke();

    // "+" indicator for unexpanded nodes with follows
    if (!node.expanded && node.followCount > 0 && !isYou) {
      ctx.beginPath();
      ctx.arc(node.x + r * 0.7, node.y - r * 0.7, 5, 0, Math.PI * 2);
      ctx.fillStyle = "#34d399";
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = "bold 7px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("+", node.x + r * 0.7, node.y - r * 0.7);
    }

    // Label
    ctx.fillStyle = isYou ? "#c4b5fd" : "rgba(200,200,220,0.8)";
    ctx.font = isYou ? "bold 11px sans-serif" : "9px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(shortName(node), node.x, node.y + r + 4);
  }
}

function hitTest(mx: number, my: number): WotNode | null {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const cx = (mx - rect.left) * scaleX;
  const cy = (my - rect.top) * scaleY;
  for (const node of nodes.values()) {
    const dx = cx - node.x,
      dy = cy - node.y;
    if (dx * dx + dy * dy <= node.radius * node.radius + 100) return node;
  }
  return null;
}

async function expandNode(node: WotNode): Promise<void> {
  if (node.expanded) return;
  node.expanded = true;

  const follows: string[] = await invoke("get_follows", {
    pubkey: node.pubkey,
  });
  node.followCount = follows.length;
  if (follows.length === 0) {
    draw();
    return;
  }

  const capped = follows.slice(0, MAX_NODES_PER_EXPAND);
  const newPubkeys = capped.filter((pk) => !nodes.has(pk));

  // Fetch profiles for new nodes
  const profilesRaw: Array<{
    pubkey: string;
    name: string | null;
    display_name: string | null;
    picture: string | null;
  }> =
    newPubkeys.length > 0
      ? await invoke("get_profiles_batch", { pubkeys: newPubkeys })
      : [];
  const profileMap = new Map(profilesRaw.map((p) => [p.pubkey, p]));

  const hop = node.hop + 1;
  const isRoot = node.pubkey === myPubkey;

  if (isRoot) {
    // Hop 1: place evenly around center
    const radius = HOP_RADIUS[1];
    const positions = placeRing(newPubkeys, CX, CY, radius);
    for (const pk of newPubkeys) {
      const profile = profileMap.get(pk);
      const pos = positions[pk];
      nodes.set(pk, {
        pubkey: pk,
        name: profile?.display_name || profile?.name || "",
        picture: profile?.picture || undefined,
        x: pos.x,
        y: pos.y,
        radius: 12,
        color: nodeColor(hop),
        hop,
        expanded: false,
        followCount: 0,
        parentPubkey: node.pubkey,
      });
    }
  } else {
    // Hop 2+: place in an arc radiating outward from parent
    const parentAngle = Math.atan2(node.y - CY, node.x - CX);
    const distFromCenter = Math.sqrt(
      (node.x - CX) ** 2 + (node.y - CY) ** 2,
    );
    const ringRadius = distFromCenter + 120;
    const arcSpan =
      newPubkeys.length === 1
        ? 0
        : Math.min(Math.PI * 0.8, newPubkeys.length * 0.15);
    const startAngle = parentAngle - arcSpan / 2;
    const positions = placeRing(
      newPubkeys,
      CX,
      CY,
      ringRadius,
      startAngle,
      arcSpan || Math.PI * 2,
    );

    for (const pk of newPubkeys) {
      const profile = profileMap.get(pk);
      const pos = positions[pk] || {
        x: node.x + (Math.random() - 0.5) * 60,
        y: node.y + (Math.random() - 0.5) * 60,
      };
      nodes.set(pk, {
        pubkey: pk,
        name: profile?.display_name || profile?.name || "",
        picture: profile?.picture || undefined,
        x: pos.x,
        y: pos.y,
        radius: 8,
        color: nodeColor(hop),
        hop,
        expanded: false,
        followCount: 0,
        parentPubkey: node.pubkey,
      });
    }
  }

  // Add edges from parent to all follows (even already-existing nodes)
  for (const pk of capped) {
    if (!edges.some((e) => e.from === node.pubkey && e.to === pk)) {
      edges.push({ from: node.pubkey, to: pk });
    }
  }

  // Update the "+N more" indicator
  if (follows.length > MAX_NODES_PER_EXPAND) {
    node.followCount = follows.length;
  }

  // Load avatars then redraw
  await loadAvatars([...nodes.values()]);
  updateStats();
  draw();
}

function updateStats(): void {
  const nodesEl = document.getElementById("wot-stat-nodes");
  const edgesEl = document.getElementById("wot-stat-edges");
  const renderedEl = document.getElementById("wot-stat-rendered");
  if (nodesEl) nodesEl.textContent = `${nodes.size} nodes`;
  if (edgesEl) edgesEl.textContent = `${edges.length} edges`;
  if (renderedEl) renderedEl.textContent = `${nodes.size} rendered`;
}

function updateNodeInfo(node: WotNode | null): void {
  const infoEl = document.getElementById("wot-node-info");
  if (!infoEl) return;
  if (!node) {
    infoEl.innerHTML = `<div class="wot-node-info-placeholder">Click a node to explore</div>`;
    return;
  }
  const isYou = node.pubkey === myPubkey;
  const avatarHtml = node.picture
    ? `<img src="${node.picture}" class="wot-info-avatar" onerror="this.style.display='none'">`
    : `<div class="wot-info-avatar-fallback">${(node.name || node.pubkey).charAt(0).toUpperCase()}</div>`;
  infoEl.innerHTML = `
    ${avatarHtml}
    <div class="wot-info-name">${node.name || shortName(node)}${isYou ? ' <span class="wot-you-badge">You</span>' : ""}</div>
    <div class="wot-info-pubkey">${node.pubkey.slice(0, 12)}\u2026${node.pubkey.slice(-6)}</div>
    <div class="wot-info-meta">Hop ${node.hop}${node.followCount > 0 ? ` \u00b7 ${node.followCount} follows` : ""}</div>
    ${!node.expanded && !isYou ? `<div class="wot-info-hint">Click node to expand follows</div>` : ""}
    ${node.expanded ? `<div class="wot-info-expanded">\u2713 Expanded</div>` : ""}
  `;
}

export async function renderWot(container: HTMLElement): Promise<void> {
  nodes.clear();
  edges = [];
  selectedPubkey = null;
  avatarCache.clear();

  container.className = "main-content";
  container.style.padding = "0";
  container.innerHTML = `
    <div class="wot-explorer">
      <div class="wot-top-bar">
        <div class="wot-stat-row">
          <span id="wot-stat-nodes">\u2014 nodes</span>
          <span id="wot-stat-edges">\u2014 edges</span>
          <span id="wot-stat-rendered">\u2014 rendered</span>
        </div>
        <button class="btn-secondary" id="wot-reset-btn" style="font-size:0.75rem;padding:4px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text-dim);cursor:pointer">\u21ba Reset</button>
      </div>
      <div class="wot-main">
        <div class="wot-canvas-wrap" id="wot-canvas-wrap"></div>
        <div class="wot-sidebar">
          <div class="wot-node-info" id="wot-node-info">
            <div class="wot-node-info-placeholder">Click a node to explore</div>
          </div>
          <div class="wot-global-stats" id="wot-global-stats" style="margin-top:16px;font-size:0.78rem;color:var(--text-muted)"></div>
        </div>
      </div>
    </div>
  `;

  // Create canvas
  canvas = document.createElement("canvas");
  canvas.width = 800;
  canvas.height = 700;
  canvas.style.cssText =
    "width:100%;height:auto;cursor:pointer;border-radius:8px;";
  ctx = canvas.getContext("2d")!;
  document.getElementById("wot-canvas-wrap")!.appendChild(canvas);

  // Load root pubkey
  let wotStatus: {
    root_pubkey: string;
    node_count: number;
    edge_count: number;
    nodes_with_follows: number;
  };
  try {
    wotStatus = await invoke("get_wot");
  } catch {
    container.innerHTML =
      '<div style="padding:32px;color:var(--text-muted)">WoT data not available yet \u2014 sync first.</div>';
    return;
  }

  myPubkey = wotStatus.root_pubkey;
  if (!myPubkey) {
    container.innerHTML =
      '<div style="padding:32px;color:var(--text-muted)">No identity configured.</div>';
    return;
  }

  // Show global stats
  const globalEl = document.getElementById("wot-global-stats");
  if (globalEl) {
    globalEl.innerHTML = `Total graph:<br>${wotStatus.node_count.toLocaleString()} nodes \u00b7 ${wotStatus.edge_count.toLocaleString()} edges`;
  }

  // Fetch your profile
  const myProfiles: Array<{
    pubkey: string;
    name: string | null;
    display_name: string | null;
    picture: string | null;
  }> = await invoke("get_profiles_batch", { pubkeys: [myPubkey] });
  const myProfile = myProfiles[0];

  // Root node (You)
  nodes.set(myPubkey, {
    pubkey: myPubkey,
    name: myProfile?.display_name || myProfile?.name || "You",
    picture: myProfile?.picture || undefined,
    x: CX,
    y: CY,
    radius: 18,
    color: nodeColor(0),
    hop: 0,
    expanded: false,
    followCount: 0,
    parentPubkey: undefined,
  });

  draw();

  // Auto-expand root (load direct follows immediately)
  await expandNode(nodes.get(myPubkey)!);

  // Wire events
  canvas.addEventListener("click", async (e) => {
    const hit = hitTest(e.clientX, e.clientY);
    if (!hit) return;
    selectedPubkey = hit.pubkey;
    updateNodeInfo(hit);
    draw();
    if (!hit.expanded && hit.pubkey !== myPubkey) {
      await expandNode(hit);
    }
  });

  canvas.addEventListener("mousemove", (e) => {
    const hit = hitTest(e.clientX, e.clientY);
    canvas.style.cursor = hit ? "pointer" : "default";
  });

  document
    .getElementById("wot-reset-btn")
    ?.addEventListener("click", async () => {
      await renderWot(container);
    });
}
