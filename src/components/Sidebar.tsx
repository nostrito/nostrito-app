import React, { useState, useEffect, useRef } from "react";
import { NavLink, useNavigate, useLocation } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import logoUrl from "../assets/logo.png";
import { IconFeed, IconMessageCircle, IconImage, IconWallet, IconSettings, IconPenSquare, IconLock, IconX, IconSearch, IconBell, IconBookmark } from "./Icon";
import { useAppContext } from "../context/AppContext";
import { useCanWrite } from "../context/SigningContext";
import { ComposeModal } from "./ComposeModal";

export const Sidebar: React.FC = () => {
  const { ownProfile, appStatus } = useAppContext();
  const canWrite = useCanWrite();
  const navigate = useNavigate();
  const location = useLocation();
  const [showCompose, setShowCompose] = useState(false);
  const [showSigningPrompt, setShowSigningPrompt] = useState(false);

  const [sidebarSearch, setSidebarSearch] = useState("");

  // Notification badge
  const [notifCount, setNotifCount] = useState(0);
  const notifTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const pollCount = async () => {
      try {
        const lastSeen = parseInt(localStorage.getItem("nostrito:notif-last-seen") || "0", 10);
        const count = await invoke<number>("get_notification_count", { sinceStoredAt: lastSeen });
        setNotifCount(count);
      } catch (_) {}
    };
    pollCount();
    notifTimer.current = setInterval(pollCount, 30_000);
    return () => { if (notifTimer.current) clearInterval(notifTimer.current); };
  }, []);

  // Clear badge when visiting notifications
  useEffect(() => {
    if (location.pathname === "/notifications") {
      setNotifCount(0);
    }
  }, [location.pathname]);

  const navItems = [
    { to: "/", icon: <IconFeed />, label: "feed" },
    { to: "/notifications", icon: <IconBell />, label: "notifications", badge: notifCount },
    { to: "/bookmarks", icon: <IconBookmark />, label: "bookmarks" },
    { to: "/dms", icon: <IconMessageCircle />, label: "messages" },
    { to: "/gallery", icon: <IconImage />, label: "gallery" },
    { to: "/wallet", icon: <IconWallet />, label: "wallet" },
    { to: "/settings", icon: <IconSettings />, label: "settings" },
  ] as const;

  return (
    <aside className="app-sidebar-nav">
      <div className="sidebar-logo">
        <img src={logoUrl} alt="nostrito" style={{ width: 52, height: 52, borderRadius: 12, display: "block", margin: "0 auto 8px" }} />
      </div>
      <div className="sidebar-search">
        <span className="icon sidebar-search-icon"><IconSearch /></span>
        <input
          type="text"
          className="sidebar-search-input"
          placeholder="search..."
          value={sidebarSearch}
          onChange={(e) => setSidebarSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && sidebarSearch.trim()) {
              navigate(`/?q=${encodeURIComponent(sidebarSearch.trim())}`);
              setSidebarSearch("");
            }
          }}
        />
      </div>
      {navItems.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === "/"}
          className={({ isActive }) => `app-nav-item${isActive ? " active" : ""}`}
        >
          <span className="icon">{item.icon}</span> {item.label}
          {"badge" in item && (item as any).badge > 0 && (
            <span className="sidebar-badge">{(item as any).badge > 99 ? "99+" : (item as any).badge}</span>
          )}
        </NavLink>
      ))}
      <div className="sidebar-spacer" />
      <button
        className="sidebar-compose-btn"
        onClick={() => canWrite ? setShowCompose(true) : setShowSigningPrompt(true)}
      >
        <span className="icon"><IconPenSquare /></span> new post
      </button>
      {showSigningPrompt && (
        <div className="sidebar-signing-prompt">
          <span className="icon"><IconLock /></span>
          <span>connect a signer to publish</span>
          <button className="sidebar-signing-prompt-btn" onClick={() => { setShowSigningPrompt(false); navigate("/settings"); }}>settings</button>
          <button className="sidebar-signing-prompt-close" onClick={() => setShowSigningPrompt(false)}><span className="icon"><IconX /></span></button>
        </div>
      )}
      {ownProfile && (
        <NavLink to={`/profile/${ownProfile.pubkey}`} className="own-profile" style={{ display: "flex", cursor: "pointer" }}>
          {ownProfile.picture ? (
            <img src={ownProfile.picture} className="own-profile-avatar" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
          ) : (
            <div className="own-profile-avatar" />
          )}
          <span className="own-profile-name">{ownProfile.name || ownProfile.display_name || "me"}</span>
        </NavLink>
      )}
      <div className={`sidebar-status${appStatus?.relay_running === false ? " offline" : ""}`}>
        <span className={appStatus?.relay_running === false ? "status-dot-offline" : "pulse-dot"} />
        {appStatus?.relay_running === false
          ? "offline · sync unavailable"
          : `live · wss://localhost:${appStatus?.relay_port ?? 4869}`}
      </div>
      {showCompose && (
        <ComposeModal
          onClose={() => setShowCompose(false)}
          onPublished={(event) => {
            window.dispatchEvent(new CustomEvent("nostrito:note-published", { detail: event }));
          }}
        />
      )}
    </aside>
  );
};
