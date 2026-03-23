import React from "react";
import { useNavigate, Link } from "react-router-dom";
import { Dashboard } from "./Dashboard";
import { Storage } from "./Storage";
import {
  IconKey,
  IconRadio,
  IconDatabase,
  IconSettings as IconSettingsIcon,
  IconDashboard,
  IconUsers,
  IconNetwork,
} from "../components/Icon";

const TABS: { id: string; label: string; Icon: React.FC }[] = [
  { id: "identity", label: "identity", Icon: IconKey },
  { id: "relays", label: "relays", Icon: IconRadio },
  { id: "storage", label: "storage", Icon: IconDatabase },
  { id: "tracked", label: "tracked profiles", Icon: IconUsers },
  { id: "analytics", label: "analytics", Icon: IconDashboard },
  { id: "advanced", label: "advanced", Icon: IconSettingsIcon },
];

export const SettingsAnalytics: React.FC = () => {
  const navigate = useNavigate();

  return (
    <div className="settings-container">
      <div className="settings-sub-nav">
        {TABS.map((tab) => (
          <div
            key={tab.id}
            className={`settings-sub-item${tab.id === "analytics" ? " active" : ""}`}
            data-settings={tab.id}
            onClick={() => {
              if (tab.id !== "analytics") navigate("/settings", { state: { tab: tab.id } });
            }}
          >
            <span className="icon">
              <tab.Icon />
            </span>{" "}
            {tab.label}
          </div>
        ))}
      </div>

      <div className="settings-panel">
        <Dashboard />
        <div style={{ margin: "32px 0", borderTop: "1px solid var(--border)" }} />
        <Storage />
        <div style={{ margin: "32px 0", borderTop: "1px solid var(--border)" }} />
        <Link
          to="/settings/analytics/wot"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "14px 18px",
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            color: "var(--text)",
            textDecoration: "none",
            fontSize: "0.88rem",
            fontWeight: 500,
            transition: "border-color 0.15s",
          }}
        >
          <span className="icon"><IconNetwork /></span>
          wot explorer
          <span style={{ marginLeft: "auto", color: "var(--text-muted)", fontSize: "0.78rem" }}>view graph &rarr;</span>
        </Link>
      </div>
    </div>
  );
};
