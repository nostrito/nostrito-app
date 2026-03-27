import React, { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RelayOption } from "../relays";
import { resolveRelayUrl } from "../relays";

interface RelayCardProps {
  relay: RelayOption;
  selected: boolean;
  onToggle: (id: string) => void;
  onRemove?: (id: string) => void;
}

interface NipInfo {
  name?: string;
  description?: string;
  supported_nips?: number[];
  software?: string;
  version?: string;
  limitation?: {
    payment_required?: boolean;
    auth_required?: boolean;
    max_message_length?: number;
    max_subscriptions?: number;
  };
  contact?: string;
}

export const RelayCard: React.FC<RelayCardProps> = ({ relay, selected, onToggle, onRemove }) => {
  const [expanded, setExpanded] = useState(false);
  const [info, setInfo] = useState<NipInfo | null>(null);
  const [loadingInfo, setLoadingInfo] = useState(false);

  const handleExpand = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (!info) {
      setLoadingInfo(true);
      try {
        const url = resolveRelayUrl(relay.id);
        const data = await invoke<NipInfo>("get_relay_info", { relayUrl: url });
        setInfo(data);
      } catch (err) {
        setInfo({ name: relay.name, description: "Failed to load relay info" });
      } finally {
        setLoadingInfo(false);
      }
    }
  }, [expanded, info, relay.id, relay.name]);

  return (
    <div className={`relay-card${selected ? " selected" : ""}`} data-relay={relay.id}>
      <div className="relay-card-main" onClick={() => onToggle(relay.id)}>
        <div className="relay-card-info">
          <span className="relay-card-name">{relay.name}</span>
          <span className="relay-card-desc">{relay.description}</span>
        </div>
        <div className="relay-card-actions">
          <button
            className="relay-info-btn"
            title="relay info (NIP-11)"
            onClick={handleExpand}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
          </button>
          {onRemove && (
            <button
              className="relay-remove-btn"
              title="remove custom relay"
              onClick={(e) => { e.stopPropagation(); onRemove(relay.id); }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          )}
          <div className="relay-check">{selected ? "\u2713" : ""}</div>
        </div>
      </div>
      {expanded && (
        <div className="relay-card-details">
          {loadingInfo ? (
            <span className="relay-detail-loading">loading relay info...</span>
          ) : info ? (
            <>
              {info.description && info.description !== relay.description && (
                <div className="relay-detail-row">
                  <span className="relay-detail-label">description</span>
                  <span className="relay-detail-value">{info.description}</span>
                </div>
              )}
              {info.software && (
                <div className="relay-detail-row">
                  <span className="relay-detail-label">software</span>
                  <span className="relay-detail-value">{info.software}{info.version ? ` v${info.version}` : ""}</span>
                </div>
              )}
              {info.supported_nips && info.supported_nips.length > 0 && (
                <div className="relay-detail-row">
                  <span className="relay-detail-label">supported NIPs</span>
                  <span className="relay-detail-value relay-nips">{info.supported_nips.join(", ")}</span>
                </div>
              )}
              {info.limitation && (
                <div className="relay-detail-row">
                  <span className="relay-detail-label">limits</span>
                  <span className="relay-detail-value">
                    {info.limitation.payment_required && <span className="relay-badge relay-badge-paid">paid</span>}
                    {info.limitation.auth_required && <span className="relay-badge relay-badge-auth">auth</span>}
                    {info.limitation.max_message_length && ` max msg: ${(info.limitation.max_message_length / 1024).toFixed(0)}KB`}
                    {info.limitation.max_subscriptions && ` max subs: ${info.limitation.max_subscriptions}`}
                  </span>
                </div>
              )}
              {info.contact && (
                <div className="relay-detail-row">
                  <span className="relay-detail-label">contact</span>
                  <span className="relay-detail-value">{info.contact}</span>
                </div>
              )}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
};
