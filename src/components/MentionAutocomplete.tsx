import React, { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Avatar } from "./Avatar";
import type { ProfileInfo } from "../utils/profiles";

interface MentionAutocompleteProps {
  query: string;
  onSelect: (pubkey: string, displayName: string) => void;
  onClose: () => void;
}

export const MentionAutocomplete: React.FC<MentionAutocompleteProps> = ({ query, onSelect, onClose }) => {
  const [results, setResults] = useState<ProfileInfo[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced search
  useEffect(() => {
    if (!query || query.length < 1) {
      setResults([]);
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      try {
        const profiles = await invoke<ProfileInfo[]>("search_profiles", { query, limit: 5 });
        setResults(profiles);
        setSelectedIndex(0);
      } catch (_) {
        setResults([]);
      }
    }, 150);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [query]);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === "Enter" && results.length > 0) {
      e.preventDefault();
      const r = results[selectedIndex];
      onSelect(r.pubkey, r.name || r.display_name || r.pubkey.slice(0, 8));
    } else if (e.key === "Escape") {
      onClose();
    }
  }, [results, selectedIndex, onSelect, onClose]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  if (results.length === 0) return null;

  return (
    <div className="mention-autocomplete">
      {results.map((profile, i) => (
        <div
          key={profile.pubkey}
          className={`mention-item${i === selectedIndex ? " selected" : ""}`}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(profile.pubkey, profile.name || profile.display_name || profile.pubkey.slice(0, 8));
          }}
          onMouseEnter={() => setSelectedIndex(i)}
        >
          <Avatar picture={profile.picture} pictureLocal={profile.picture_local} pubkey={profile.pubkey} className="mention-item-avatar" />
          <div>
            <div className="mention-item-name">{profile.name || profile.display_name || profile.pubkey.slice(0, 12)}</div>
            {profile.nip05 && <div className="mention-item-nip05">{profile.nip05}</div>}
          </div>
        </div>
      ))}
    </div>
  );
};
