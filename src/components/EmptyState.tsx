import React from "react";

interface EmptyStateProps {
  message: string;
  icon?: React.ReactNode;
  hint?: string;
  cta?: { label: string; onClick?: () => void };
}

export const EmptyState: React.FC<EmptyStateProps> = ({ message, icon, hint, cta }) => (
  <div className="empty-state">
    {icon && <div className="empty-state-icon">{icon}</div>}
    <div className="empty-state-message">{message}</div>
    {hint && <div className="empty-state-hint">{hint}</div>}
    {cta && (
      <button
        className="btn btn-primary"
        onClick={cta.onClick}
        style={{ marginTop: 4, padding: "10px 28px", fontSize: "0.9rem", fontWeight: 600, border: "none", borderRadius: 8, background: "var(--accent)", color: "#fff", cursor: "pointer" }}
      >
        {cta.label}
      </button>
    )}
  </div>
);
