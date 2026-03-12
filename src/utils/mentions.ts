/** Parse nostr: entity mentions in note content and render as clickable spans */
import type { ProfileInfo } from "./profiles";
import { profileDisplayName } from "./profiles";

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const NOSTR_ENTITY_RE = /nostr:((npub|nprofile|note|nevent|naddr)1[a-z0-9]+)/g;

/** Decode bech32 data portion to bytes */
function bech32ToBytes(bech32: string): { hrp: string; bytes: number[] } | null {
  try {
    const lower = bech32.toLowerCase();
    const pos = lower.lastIndexOf("1");
    if (pos < 1) return null;
    const hrp = lower.slice(0, pos);
    const data = lower.slice(pos + 1);

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

    return { hrp, bytes };
  } catch {
    return null;
  }
}

function bytesToHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Decode a bech32 npub string to hex pubkey */
export function npubToHex(npub: string): string | null {
  const result = bech32ToBytes(npub);
  if (!result || result.hrp !== "npub" || result.bytes.length !== 32) return null;
  return bytesToHex(result.bytes);
}

/** Parse TLV-encoded bytes (used by nevent, naddr, nprofile) */
function parseTLV(bytes: number[]): Map<number, number[][]> {
  const tlv = new Map<number, number[][]>();
  let i = 0;
  while (i < bytes.length) {
    const type = bytes[i];
    const length = bytes[i + 1];
    if (length === undefined) break;
    const value = bytes.slice(i + 2, i + 2 + length);
    if (value.length !== length) break;
    if (!tlv.has(type)) tlv.set(type, []);
    tlv.get(type)!.push(value);
    i += 2 + length;
  }
  return tlv;
}

export interface DecodedEntity {
  type: "npub" | "nprofile" | "note" | "nevent" | "naddr";
  pubkey?: string;
  eventId?: string;
  kind?: number;
  dTag?: string;
  relays?: string[];
}

/** Decode any NIP-19 bech32 entity */
export function decodeEntity(bech32str: string): DecodedEntity | null {
  const result = bech32ToBytes(bech32str);
  if (!result) return null;
  const { hrp, bytes } = result;

  switch (hrp) {
    case "npub": {
      if (bytes.length !== 32) return null;
      return { type: "npub", pubkey: bytesToHex(bytes) };
    }
    case "note": {
      if (bytes.length !== 32) return null;
      return { type: "note", eventId: bytesToHex(bytes) };
    }
    case "nprofile": {
      const tlv = parseTLV(bytes);
      const pubkeyEntry = tlv.get(0)?.[0];
      if (!pubkeyEntry || pubkeyEntry.length !== 32) return null;
      const relays = (tlv.get(1) || []).map((r) => new TextDecoder().decode(new Uint8Array(r)));
      return { type: "nprofile", pubkey: bytesToHex(pubkeyEntry), relays };
    }
    case "nevent": {
      const tlv = parseTLV(bytes);
      const idEntry = tlv.get(0)?.[0];
      if (!idEntry || idEntry.length !== 32) return null;
      const relays = (tlv.get(1) || []).map((r) => new TextDecoder().decode(new Uint8Array(r)));
      const authorEntry = tlv.get(2)?.[0];
      const kindEntry = tlv.get(3)?.[0];
      return {
        type: "nevent",
        eventId: bytesToHex(idEntry),
        pubkey: authorEntry && authorEntry.length === 32 ? bytesToHex(authorEntry) : undefined,
        kind: kindEntry ? new DataView(new Uint8Array(kindEntry).buffer).getUint32(0) : undefined,
        relays,
      };
    }
    case "naddr": {
      const tlv = parseTLV(bytes);
      const dTagEntry = tlv.get(0)?.[0];
      if (!dTagEntry) return null;
      const dTag = new TextDecoder().decode(new Uint8Array(dTagEntry));
      const relays = (tlv.get(1) || []).map((r) => new TextDecoder().decode(new Uint8Array(r)));
      const authorEntry = tlv.get(2)?.[0];
      const kindEntry = tlv.get(3)?.[0];
      if (!authorEntry || authorEntry.length !== 32) return null;
      return {
        type: "naddr",
        dTag,
        pubkey: bytesToHex(authorEntry),
        kind: kindEntry ? new DataView(new Uint8Array(kindEntry).buffer).getUint32(0) : undefined,
        relays,
      };
    }
    default:
      return null;
  }
}

/** Extract hex pubkeys of all nostr: entity mentions in content */
export function extractMentionedPubkeys(content: string): string[] {
  const pubkeys: string[] = [];
  let match;
  const re = new RegExp(NOSTR_ENTITY_RE.source, NOSTR_ENTITY_RE.flags);
  while ((match = re.exec(content)) !== null) {
    const entity = decodeEntity(match[1]);
    if (entity?.pubkey) pubkeys.push(entity.pubkey);
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

/** Replace nostr: entity mentions with clickable HTML spans */
export function replaceMentions(
  content: string,
  profiles: Map<string, ProfileInfo | undefined>,
): string {
  return content.replace(NOSTR_ENTITY_RE, (fullMatch, bech32str) => {
    const entity = decodeEntity(bech32str);
    if (!entity) return escapeHtml(fullMatch);

    switch (entity.type) {
      case "npub":
      case "nprofile": {
        const hex = entity.pubkey!;
        const profile = profiles.get(hex);
        const name = profile ? profileDisplayName(profile, hex) : bech32str.slice(0, 12) + "...";
        return `<span class="mention" data-pubkey="${hex}" style="cursor:pointer;color:var(--accent)">@${escapeHtml(name)}</span>`;
      }
      case "note":
      case "nevent": {
        const id = entity.eventId!;
        const label = bech32str.slice(0, 16) + "...";
        const linkIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12" style="vertical-align:middle;margin-right:2px"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
        return `<span class="mention note-link" data-note-id="${id}" style="cursor:pointer;color:var(--accent)">${linkIcon}${label}</span>`;
      }
      case "naddr": {
        const label = entity.dTag || bech32str.slice(0, 16) + "...";
        const data = JSON.stringify({ kind: entity.kind, pubkey: entity.pubkey, dTag: entity.dTag, relays: entity.relays });
        const linkIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12" style="vertical-align:middle;margin-right:2px"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
        return `<span class="mention note-link" data-naddr='${escapeHtml(data)}' style="cursor:pointer;color:var(--accent)">${linkIcon}${escapeHtml(label)}</span>`;
      }
      default:
        return escapeHtml(fullMatch);
    }
  });
}
