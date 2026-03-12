/** Parse nostr:npub mentions in note content and render as clickable spans */
import type { ProfileInfo } from "./profiles";
import { profileDisplayName } from "./profiles";

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const NOSTR_MENTION_RE = /nostr:npub1[a-z0-9]{58}/g;

/** Decode a bech32 npub string to hex pubkey */
export function npubToHex(npub: string): string | null {
  try {
    const lower = npub.toLowerCase();
    const pos = lower.lastIndexOf("1");
    if (pos < 1) return null;
    const hrp = lower.slice(0, pos);
    if (hrp !== "npub") return null;
    const data = lower.slice(pos + 1);

    // Decode charset to 5-bit values
    const values: number[] = [];
    for (let i = 0; i < data.length; i++) {
      const idx = BECH32_CHARSET.indexOf(data[i]);
      if (idx === -1) return null;
      values.push(idx);
    }

    // Remove 6-char checksum
    const payload = values.slice(0, values.length - 6);

    // Convert 5-bit groups to 8-bit bytes
    let acc = 0;
    let bits = 0;
    const bytes: number[] = [];
    for (const v of payload) {
      acc = (acc << 5) | v;
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((acc >> bits) & 0xff);
      }
    }

    if (bytes.length !== 32) return null;
    return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

/** Extract hex pubkeys of all nostr:npub mentions in content */
export function extractMentionedPubkeys(content: string): string[] {
  const matches = content.match(NOSTR_MENTION_RE);
  if (!matches) return [];
  const pubkeys: string[] = [];
  for (const m of matches) {
    const hex = npubToHex(m.slice(6)); // strip "nostr:" prefix
    if (hex) pubkeys.push(hex);
  }
  return pubkeys;
}

/** Escape HTML special characters */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Replace nostr:npub mentions with clickable HTML spans */
export function replaceMentions(
  content: string,
  profiles: Map<string, ProfileInfo | undefined>,
): string {
  return content.replace(NOSTR_MENTION_RE, (match) => {
    const npub = match.slice(6); // strip "nostr:"
    const hex = npubToHex(npub);
    if (!hex) return escapeHtml(match);
    const profile = profiles.get(hex);
    const name = profile ? profileDisplayName(profile, hex) : npub.slice(0, 12) + "...";
    return `<span class="mention" data-pubkey="${hex}" style="cursor:pointer;color:var(--accent)">@${escapeHtml(name)}</span>`;
  });
}
