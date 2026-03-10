import React from "react";
import type { RelayOption } from "../relays";

interface RelayCardProps {
  relay: RelayOption;
  selected: boolean;
  onToggle: (id: string) => void;
}

export const RelayCard: React.FC<RelayCardProps> = ({ relay, selected, onToggle }) => (
  <div
    className={`relay-card${selected ? " selected" : ""}`}
    data-relay={relay.id}
    onClick={() => onToggle(relay.id)}
  >
    <div className="relay-card-info">
      <span className="relay-card-name">{relay.name}</span>
      <span className="relay-card-desc">{relay.description}</span>
    </div>
    <div className="relay-check">{selected ? "\u2713" : ""}</div>
  </div>
);
