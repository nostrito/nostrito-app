import React, { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { IconDashboard, IconFeed, IconMessageCircle, IconNetwork, IconDatabase, IconSettings, IconImage } from "./Icon";
import type { ProfileInfo } from "../utils/profiles";

export const Sidebar: React.FC = () => {
  const [ownProfile, setOwnProfile] = useState<ProfileInfo | null>(null);

  useEffect(() => {
    invoke<ProfileInfo | null>("get_own_profile")
      .then((p) => setOwnProfile(p))
      .catch(() => {});
  }, []);

  const navItems = [
    { to: "/", icon: <IconDashboard />, label: "Dashboard" },
    { to: "/feed", icon: <IconFeed />, label: "Feed" },
    { to: "/dms", icon: <IconMessageCircle />, label: "DMs" },
    { to: "/wot", icon: <IconNetwork />, label: "WoT" },
    { to: "/storage", icon: <IconDatabase />, label: "Storage" },
    { to: "/my-media", icon: <IconImage />, label: "My Media" },
    { to: "/settings", icon: <IconSettings />, label: "Settings" },
  ];

  return (
    <aside className="app-sidebar-nav">
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
          <span className="own-profile-name">{ownProfile.name || ownProfile.display_name || "Me"}</span>
        </NavLink>
      )}
      <div className="sidebar-status"><span className="pulse-dot" /> Live · wss://localhost:4869</div>
    </aside>
  );
};
