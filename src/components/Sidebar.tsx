import React from "react";
import { NavLink } from "react-router-dom";
import logoUrl from "../assets/logo.png";
import { IconDashboard, IconFeed, IconMessageCircle, IconImage, IconNetwork, IconWallet, IconDatabase, IconSettings } from "./Icon";
import { useAppContext } from "../context/AppContext";

export const Sidebar: React.FC = () => {
  const { ownProfile } = useAppContext();

  const navItems = [
    { to: "/", icon: <IconFeed />, label: "feed" },
    { to: "/dms", icon: <IconMessageCircle />, label: "messages" },
    { to: "/gallery", icon: <IconImage />, label: "gallery" },
    { to: "/wot", icon: <IconNetwork />, label: "wot" },
    { to: "/wallet", icon: <IconWallet />, label: "wallet" },
    { to: "/analytics", icon: <IconDashboard />, label: "analytics" },
    { to: "/storage", icon: <IconDatabase />, label: "storage" },
    { to: "/settings", icon: <IconSettings />, label: "settings" },
  ];

  return (
    <aside className="app-sidebar-nav">
      <div className="sidebar-logo">
        <img src={logoUrl} alt="nostrito" style={{ width: 52, height: 52, borderRadius: 12, display: "block", margin: "0 auto 8px" }} />
      </div>
      {navItems.map((item) => (
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
      <div className="sidebar-status"><span className="pulse-dot" /> live · wss://localhost:4869</div>
    </aside>
  );
};
