import React, { useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import logoUrl from "../assets/logo.png";
import { IconFeed, IconMessageCircle, IconImage, IconWallet, IconSettings, IconPenSquare, IconLock, IconX, IconSearch } from "./Icon";
import { useAppContext } from "../context/AppContext";
import { useCanWrite } from "../context/SigningContext";
import { ComposeModal } from "./ComposeModal";

export const Sidebar: React.FC = () => {
  const { ownProfile, appStatus } = useAppContext();
  const canWrite = useCanWrite();
  const navigate = useNavigate();
  const [showCompose, setShowCompose] = useState(false);
  const [showSigningPrompt, setShowSigningPrompt] = useState(false);

  const [sidebarSearch, setSidebarSearch] = useState("");

  const navItems = [
    { to: "/", icon: <IconFeed />, label: "feed" },
    // { to: "/bookmarks", icon: <IconBookmark />, label: "bookmarks" }, // TODO: NIP-51 bookmarks pending interop fixes
    { to: "/dms", icon: <IconMessageCircle />, label: "messages" },
    { to: "/gallery", icon: <IconImage />, label: "gallery" },
    { to: "/wot", icon: <IconNetwork />, label: "wot" },
    { to: "/wallet", icon: <IconWallet />, label: "wallet", requiresWrite: true },
    { to: "/analytics", icon: <IconDashboard />, label: "analytics" },
    { to: "/storage", icon: <IconDatabase />, label: "storage" },
    { to: "/settings", icon: <IconSettings />, label: "settings" },
  ];

  const visibleItems = navItems.filter((item) => !item.requiresWrite || canWrite);

  return (
    <aside className="app-sidebar-nav">
      <div className="sidebar-logo">
        <img src={logoUrl} alt="nostrito" style={{ width: 52, height: 52, borderRadius: 12, display: "block", margin: "0 auto 8px" }} />
      </div>
      {visibleItems.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === "/"}
          className={({ isActive }) => `app-nav-item${isActive ? " active" : ""}`}
        >
          <span className="icon">{item.icon}</span> {item.label}
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
