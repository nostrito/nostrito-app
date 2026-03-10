import React, { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IconSearch } from "../components/Icon";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

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

interface WotStatus {
  root_pubkey: string;
  node_count: number;
  edge_count: number;
  nodes_with_follows: number;
}

interface ProfileResult {
  pubkey: string;
  name: string | null;
  display_name: string | null;
  picture: string | null;
}

interface SelectedInfo {
  pubkey: string;
  name: string;
  picture?: string;
  hop: number;
  followCount: number;
  expanded: boolean;
  isYou: boolean;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const CX = 1200,
  CY = 1000;
const LOGICAL_W = 2400,
  LOGICAL_H = 2000;
const HOP_RADIUS = [0, 500, 950];
const NODE_COLORS = ["#7c3aed", "#4f46e5", "#0ea5e9", "#10b981"];
const MAX_NODES_PER_EXPAND = 500;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function nodeColor(hop: number): string {
  return NODE_COLORS[Math.min(hop, NODE_COLORS.length - 1)];
}

function shortName(node: WotNode): string {
  if (node.name) return node.name.slice(0, 12);
  return node.pubkey.slice(0, 6) + "\u2026";
}

function placeRing(
  pubkeys: string[],
  cx: number,
  cy: number,
  radius: number,
  startAngle = 0,
  arcSpan = Math.PI * 2,
): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
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

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const Wot: React.FC = () => {
  /* --- React state (drives non-canvas UI) ------------------------- */
  const [stats, setStats] = useState({ nodes: 0, edges: 0, rendered: 0 });
  const [globalStats, setGlobalStats] = useState<{ nodeCount: number; edgeCount: number } | null>(null);
  const [selectedInfo, setSelectedInfo] = useState<SelectedInfo | null>(null);
  const [resetKey, setResetKey] = useState(0);

  /* --- Refs for canvas + mutable state that doesn't trigger renders */
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<Map<string, WotNode>>(new Map());
  const edgesRef = useRef<WotEdge[]>([]);
  const myPubkeyRef = useRef<string>("");
  const selectedPubkeyRef = useRef<string | null>(null);
  const avatarCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const expandedByHopRef = useRef<Map<number, string>>(new Map());

  // Pan & zoom
  const panRef = useRef({ x: LOGICAL_W * 0.5 * (1 - 0.35), y: LOGICAL_H * 0.5 * (1 - 0.35) });
  const zoomRef = useRef(0.35);
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const mouseDownPosRef = useRef({ x: 0, y: 0 });

  /* --- Sync stats helper ------------------------------------------ */
  const syncStats = useCallback(() => {
    setStats({
      nodes: nodesRef.current.size,
      edges: edgesRef.current.length,
      rendered: nodesRef.current.size,
    });
  }, []);

  /* --- Update selected info in React state ------------------------ */
  const syncSelectedInfo = useCallback((node: WotNode | null) => {
    if (!node) {
      setSelectedInfo(null);
      return;
    }
    setSelectedInfo({
      pubkey: node.pubkey,
      name: node.name || shortName(node),
      picture: node.picture,
      hop: node.hop,
      followCount: node.followCount,
      expanded: node.expanded,
      isYou: node.pubkey === myPubkeyRef.current,
    });
  }, []);

  /* --- Draw function (reads from refs, not state) ----------------- */
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const nodes = nodesRef.current;
    const edges = edgesRef.current;
    const pan = panRef.current;
    const zoom = zoomRef.current;
    const selectedPubkey = selectedPubkeyRef.current;
    const myPubkey = myPubkeyRef.current;
    const avatarCache = avatarCacheRef.current;

    // Reset to DPR-only transform and clear
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, LOGICAL_W, LOGICAL_H);

    // Background
    ctx.fillStyle = "#0a0a0c";
    ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

    // Apply pan + zoom on top of DPR
    ctx.save();
    ctx.translate(pan.x, pan.y);
    ctx.scale(zoom, zoom);

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
      const isNoData = node.expanded && node.followCount === 0 && !isYou;
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
      ctx.fillStyle = isNoData ? "rgba(30,30,40,0.6)" : node.color;
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

      // Border -- dashed for "no data" nodes
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      if (isNoData) {
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = "rgba(255,255,255,0.15)";
        ctx.lineWidth = 1;
      } else {
        ctx.setLineDash([]);
        ctx.strokeStyle = isSelected
          ? "#a78bfa"
          : isYou
            ? "#7c3aed"
            : "rgba(255,255,255,0.1)";
        ctx.lineWidth = isSelected ? 2 : 1;
      }
      ctx.stroke();
      ctx.setLineDash([]);

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
      ctx.fillStyle = isYou
        ? "#c4b5fd"
        : isNoData
          ? "rgba(200,200,220,0.4)"
          : "rgba(200,200,220,0.8)";
      ctx.font = isYou ? "bold 11px sans-serif" : "9px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(shortName(node), node.x, node.y + r + 4);
    }

    ctx.restore();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }, []);

  /* --- Hit test --------------------------------------------------- */
  const hitTest = useCallback((mx: number, my: number): WotNode | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const pan = panRef.current;
    const zoom = zoomRef.current;
    const cx = ((mx - rect.left) / rect.width * LOGICAL_W - pan.x) / zoom;
    const cy = ((my - rect.top) / rect.height * LOGICAL_H - pan.y) / zoom;
    for (const node of nodesRef.current.values()) {
      const dx = cx - node.x,
        dy = cy - node.y;
      if (dx * dx + dy * dy <= (node.radius + 4) * (node.radius + 4)) return node;
    }
    return null;
  }, []);

  /* --- Avatar loading --------------------------------------------- */
  const loadAvatars = useCallback(async (nodeList: WotNode[]): Promise<void> => {
    const avatarCache = avatarCacheRef.current;
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
  }, []);

  /* --- Collapse node ---------------------------------------------- */
  const collapseNode = useCallback((pubkey: string) => {
    const nodes = nodesRef.current;
    const node = nodes.get(pubkey);
    if (!node || !node.expanded) return;
    node.expanded = false;

    // Collect all children recursively
    const toRemove = new Set<string>();
    function collectChildren(pk: string): void {
      for (const [npk, n] of nodes.entries()) {
        if (n.parentPubkey === pk && !toRemove.has(npk)) {
          toRemove.add(npk);
          collectChildren(npk);
        }
      }
    }
    collectChildren(pubkey);

    // Remove child nodes
    for (const pk of toRemove) {
      nodes.delete(pk);
    }

    // Remove edges to/from removed nodes
    edgesRef.current = edgesRef.current.filter((e) => !toRemove.has(e.from) && !toRemove.has(e.to));

    // Clean up expandedByHop for removed nodes
    for (const [hop, pk] of expandedByHopRef.current.entries()) {
      if (toRemove.has(pk)) expandedByHopRef.current.delete(hop);
    }
  }, []);

  /* --- Expand node ------------------------------------------------ */
  const expandNode = useCallback(async (node: WotNode) => {
    if (node.expanded) return;

    const nodes = nodesRef.current;
    const myPubkey = myPubkeyRef.current;

    // Accordion: collapse any other expanded node at the same hop level
    const previousPubkey = expandedByHopRef.current.get(node.hop);
    if (previousPubkey && previousPubkey !== node.pubkey) {
      collapseNode(previousPubkey);
    }
    expandedByHopRef.current.set(node.hop, node.pubkey);

    const follows: string[] = await invoke("get_follows", { pubkey: node.pubkey });
    node.expanded = true;
    node.followCount = follows.length;

    if (follows.length === 0) {
      syncSelectedInfo(node);
      syncStats();
      draw();
      return;
    }

    const capped = follows.slice(0, MAX_NODES_PER_EXPAND);

    // Update existing nodes if we found a shorter path
    for (const pk of capped) {
      const newHop = node.hop + 1;
      if (nodes.has(pk)) {
        const existingNode = nodes.get(pk)!;
        if (newHop < existingNode.hop) {
          existingNode.hop = newHop;
          existingNode.color = nodeColor(newHop);
          existingNode.radius = newHop === 1 ? 12 : 8;
        }
        if (!edgesRef.current.some((e) => e.from === node.pubkey && e.to === pk)) {
          edgesRef.current.push({ from: node.pubkey, to: pk });
        }
      }
    }

    const newPubkeys = capped.filter((pk) => !nodes.has(pk));

    // Fetch profiles for new nodes
    const profilesRaw: ProfileResult[] =
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
      const distFromCenter = Math.sqrt((node.x - CX) ** 2 + (node.y - CY) ** 2);
      const ringRadius = distFromCenter + 380;
      const arcSpan =
        newPubkeys.length === 1
          ? 0
          : Math.min(Math.PI * 1.6, newPubkeys.length * 0.12);
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
      if (!edgesRef.current.some((e) => e.from === node.pubkey && e.to === pk)) {
        edgesRef.current.push({ from: node.pubkey, to: pk });
      }
    }

    // Update the "+N more" indicator
    if (follows.length > MAX_NODES_PER_EXPAND) {
      node.followCount = follows.length;
    }

    // Load avatars then redraw
    await loadAvatars([...nodes.values()]);
    syncStats();
    syncSelectedInfo(node);
    draw();
  }, [collapseNode, draw, loadAvatars, syncStats, syncSelectedInfo]);

  /* --- Initialization effect -------------------------------------- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Reset mutable refs
    nodesRef.current = new Map();
    edgesRef.current = [];
    selectedPubkeyRef.current = null;
    avatarCacheRef.current = new Map();
    expandedByHopRef.current = new Map();
    panRef.current = { x: LOGICAL_W * 0.5 * (1 - 0.35), y: LOGICAL_H * 0.5 * (1 - 0.35) };
    zoomRef.current = 0.35;
    isPanningRef.current = false;

    // Set up canvas with DPR support
    const dpr = window.devicePixelRatio || 1;
    canvas.width = LOGICAL_W * dpr;
    canvas.height = LOGICAL_H * dpr;
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.scale(dpr, dpr);

    let cancelled = false;

    async function init() {
      // Load WoT status
      let wotStatus: WotStatus;
      try {
        wotStatus = await invoke("get_wot");
      } catch {
        return;
      }
      if (cancelled) return;

      myPubkeyRef.current = wotStatus.root_pubkey;
      if (!wotStatus.root_pubkey) return;

      setGlobalStats({ nodeCount: wotStatus.node_count, edgeCount: wotStatus.edge_count });

      // Fetch root profile
      const myProfiles: ProfileResult[] = await invoke("get_profiles_batch", {
        pubkeys: [wotStatus.root_pubkey],
      });
      if (cancelled) return;

      const myProfile = myProfiles[0];

      // Create root node
      nodesRef.current.set(wotStatus.root_pubkey, {
        pubkey: wotStatus.root_pubkey,
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

      // Auto-expand root
      const rootNode = nodesRef.current.get(wotStatus.root_pubkey);
      if (rootNode && !cancelled) {
        await expandNode(rootNode);
      }
    }

    init();

    return () => {
      cancelled = true;
    };
  }, [resetKey, draw, expandNode]);

  /* --- Mouse / wheel event handlers ------------------------------- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleMouseDown = (e: MouseEvent) => {
      mouseDownPosRef.current = { x: e.clientX, y: e.clientY };
      const hit = hitTest(e.clientX, e.clientY);
      if (!hit) {
        isPanningRef.current = true;
        panStartRef.current = {
          x: e.clientX,
          y: e.clientY,
          panX: panRef.current.x,
          panY: panRef.current.y,
        };
        canvas.style.cursor = "grabbing";
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (isPanningRef.current) {
        const rect = canvas.getBoundingClientRect();
        const scaleX = LOGICAL_W / rect.width;
        const scaleY = LOGICAL_H / rect.height;
        panRef.current = {
          x: panStartRef.current.panX + (e.clientX - panStartRef.current.x) * scaleX,
          y: panStartRef.current.panY + (e.clientY - panStartRef.current.y) * scaleY,
        };
        draw();
        return;
      }
      const hit = hitTest(e.clientX, e.clientY);
      canvas.style.cursor = hit ? "pointer" : "grab";
    };

    const handleMouseUp = () => {
      if (isPanningRef.current) {
        isPanningRef.current = false;
        canvas.style.cursor = "grab";
      }
    };

    const handleMouseLeave = () => {
      isPanningRef.current = false;
    };

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
      const oldZoom = zoomRef.current;
      const newZoom = Math.max(0.2, Math.min(5, oldZoom * zoomFactor));

      const rect = canvas.getBoundingClientRect();
      const mouseX = (e.clientX - rect.left) / rect.width * LOGICAL_W;
      const mouseY = (e.clientY - rect.top) / rect.height * LOGICAL_H;

      panRef.current = {
        x: mouseX - (mouseX - panRef.current.x) * (newZoom / oldZoom),
        y: mouseY - (mouseY - panRef.current.y) * (newZoom / oldZoom),
      };
      zoomRef.current = newZoom;
      draw();
    };

    const handleClick = async (e: MouseEvent) => {
      const dx = e.clientX - mouseDownPosRef.current.x;
      const dy = e.clientY - mouseDownPosRef.current.y;
      if (dx * dx + dy * dy > 25) return;

      const hit = hitTest(e.clientX, e.clientY);
      if (!hit) return;
      selectedPubkeyRef.current = hit.pubkey;
      syncSelectedInfo(hit);
      draw();
      if (!hit.expanded && hit.pubkey !== myPubkeyRef.current) {
        await expandNode(hit);
      }
    };

    canvas.addEventListener("mousedown", handleMouseDown);
    canvas.addEventListener("mousemove", handleMouseMove);
    canvas.addEventListener("mouseup", handleMouseUp);
    canvas.addEventListener("mouseleave", handleMouseLeave);
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    canvas.addEventListener("click", handleClick);

    return () => {
      canvas.removeEventListener("mousedown", handleMouseDown);
      canvas.removeEventListener("mousemove", handleMouseMove);
      canvas.removeEventListener("mouseup", handleMouseUp);
      canvas.removeEventListener("mouseleave", handleMouseLeave);
      canvas.removeEventListener("wheel", handleWheel);
      canvas.removeEventListener("click", handleClick);
    };
  }, [draw, hitTest, expandNode, syncSelectedInfo]);

  /* --- Reset handler ---------------------------------------------- */
  const handleReset = useCallback(() => {
    setStats({ nodes: 0, edges: 0, rendered: 0 });
    setGlobalStats(null);
    setSelectedInfo(null);
    setResetKey((k) => k + 1);
  }, []);

  /* --- Render ----------------------------------------------------- */
  return (
    <div className="main-content" style={{ padding: 0 }}>
      <style>{`
        .wot-info-no-data {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
          margin-top: 12px;
          padding: 10px;
          background: rgba(100,100,120,.08);
          border-radius: 8px;
          font-size: 0.78rem;
          color: var(--text-muted);
          text-align: center;
        }
        .wot-info-no-data-hint {
          font-size: 0.7rem;
          color: var(--text-muted);
          opacity: 0.7;
          line-height: 1.3;
        }
      `}</style>

      <div className="wot-explorer">
        {/* ---- Top bar ---- */}
        <div className="wot-top-bar">
          <div className="wot-stat-row">
            <span>{stats.nodes} nodes</span>
            <span>{stats.edges} edges</span>
            <span>{stats.rendered} rendered</span>
          </div>
          <button
            className="btn-secondary"
            onClick={handleReset}
            style={{
              fontSize: "0.75rem",
              padding: "4px 10px",
              borderRadius: "6px",
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-dim)",
              cursor: "pointer",
            }}
          >
            {"\u21ba"} Reset
          </button>
        </div>

        {/* ---- Main area ---- */}
        <div className="wot-main">
          <div className="wot-canvas-wrap">
            <canvas
              ref={canvasRef}
              style={{
                width: "100%",
                height: "auto",
                cursor: "grab",
                borderRadius: "8px",
              }}
            />
          </div>

          {/* ---- Sidebar ---- */}
          <div className="wot-sidebar">
            <div className="wot-node-info">
              {!selectedInfo && (
                <div className="wot-node-info-placeholder">Click a node to explore</div>
              )}
              {selectedInfo && (
                <>
                  {selectedInfo.picture ? (
                    <img
                      src={selectedInfo.picture}
                      className="wot-info-avatar"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = "none";
                      }}
                    />
                  ) : (
                    <div className="wot-info-avatar-fallback">
                      {(selectedInfo.name || selectedInfo.pubkey).charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="wot-info-name">
                    {selectedInfo.name}
                    {selectedInfo.isYou && (
                      <span className="wot-you-badge"> You</span>
                    )}
                  </div>
                  <div className="wot-info-pubkey">
                    {selectedInfo.pubkey.slice(0, 12)}{"\u2026"}{selectedInfo.pubkey.slice(-6)}
                  </div>
                  <div className="wot-info-meta">
                    Hop {selectedInfo.hop}
                    {selectedInfo.followCount > 0 && ` \u00b7 ${selectedInfo.followCount} follows`}
                  </div>
                  {!selectedInfo.expanded && !selectedInfo.isYou && (
                    <div className="wot-info-hint">Click node to expand follows</div>
                  )}
                  {selectedInfo.expanded && (
                    <div className="wot-info-expanded">{"\u2713"} Expanded</div>
                  )}
                  {selectedInfo.expanded && selectedInfo.followCount === 0 && !selectedInfo.isYou && (
                    <div className="wot-info-no-data">
                      <span style={{ fontSize: "1.2rem" }}>
                        <IconSearch />
                      </span>
                      <span>Not synced yet</span>
                      <span className="wot-info-no-data-hint">
                        This account's follow list hasn't been discovered. It will appear after deeper WoT sync.
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* ---- Global stats ---- */}
            <div
              style={{
                marginTop: "16px",
                fontSize: "0.78rem",
                color: "var(--text-muted)",
              }}
            >
              {globalStats && (
                <>
                  Total graph:<br />
                  {globalStats.nodeCount.toLocaleString()} nodes {"\u00b7"}{" "}
                  {globalStats.edgeCount.toLocaleString()} edges
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
