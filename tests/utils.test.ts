/**
 * Tests for pure utility functions — no relay or Tauri dependency.
 */

import { describe, it, expect } from "vitest";
import {
  RELAYS,
  RELAY_URL_MAP,
  resolveRelayUrl,
  urlToAlias,
  isKnownRelay,
  isValidRelayUrl,
} from "../src/relays";
import {
  shortPubkey,
  formatBytes,
  timeAgo,
  formatDate,
} from "../src/utils/format";
import { profileDisplayName } from "../src/utils/profiles";
import type { ProfileInfo } from "../src/utils/profiles";

// ── Relay URL Resolution ─────────────────────────────────────────

describe("Relay URL resolution", () => {
  it("resolves known aliases to wss:// URLs", () => {
    expect(resolveRelayUrl("primal")).toBe("wss://relay.primal.net");
    expect(resolveRelayUrl("damus")).toBe("wss://relay.damus.io");
    expect(resolveRelayUrl("nos.lol")).toBe("wss://nos.lol");
    expect(resolveRelayUrl("nostr.wine")).toBe("wss://nostr.wine");
    expect(resolveRelayUrl("yakihonne")).toBe("wss://relay.yakihonne.com");
  });

  it("returns unknown aliases unchanged", () => {
    expect(resolveRelayUrl("wss://custom.relay.com")).toBe("wss://custom.relay.com");
    expect(resolveRelayUrl("unknown-alias")).toBe("unknown-alias");
  });

  it("reverse-maps wss:// URLs to aliases", () => {
    expect(urlToAlias("wss://relay.primal.net")).toBe("primal");
    expect(urlToAlias("wss://relay.damus.io")).toBe("damus");
    expect(urlToAlias("wss://nos.lol")).toBe("nos.lol");
  });

  it("returns null for unknown URLs", () => {
    expect(urlToAlias("wss://unknown.relay")).toBeNull();
  });

  it("detects known relays by alias or URL", () => {
    expect(isKnownRelay("primal")).toBe(true);
    expect(isKnownRelay("wss://relay.primal.net")).toBe(true);
    expect(isKnownRelay("wss://unknown.relay")).toBe(false);
  });

  it("validates relay URLs", () => {
    expect(isValidRelayUrl("wss://relay.damus.io")).toBe(true);
    expect(isValidRelayUrl("ws://127.0.0.1:7777")).toBe(true);
    expect(isValidRelayUrl("https://not-a-relay.com")).toBe(false);
    expect(isValidRelayUrl("not-a-url")).toBe(false);
    expect(isValidRelayUrl("")).toBe(false);
  });

  it("has matching entries in RELAYS and RELAY_URL_MAP", () => {
    for (const relay of RELAYS) {
      expect(
        relay.id in RELAY_URL_MAP,
        `RELAYS entry "${relay.id}" missing from RELAY_URL_MAP`,
      ).toBe(true);
    }
  });

  it("all RELAY_URL_MAP values are valid wss:// URLs", () => {
    for (const [alias, url] of Object.entries(RELAY_URL_MAP)) {
      expect(isValidRelayUrl(url), `Invalid URL for alias "${alias}": ${url}`).toBe(true);
    }
  });
});

// ── Formatting Utilities ─────────────────────────────────────────

describe("Format utilities", () => {
  it("shortens pubkeys correctly", () => {
    const pk = "a".repeat(64);
    expect(shortPubkey(pk)).toBe("aaaaaa...aaaa");
    expect(shortPubkey("short")).toBe("short");
  });

  it("formats byte sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
    expect(formatBytes(512)).toBe("512.0 B");
  });

  it("formats timeAgo correctly", () => {
    const nowTs = Math.floor(Date.now() / 1000);
    expect(timeAgo(nowTs - 30)).toBe("30s ago");
    expect(timeAgo(nowTs - 120)).toBe("2m ago");
    expect(timeAgo(nowTs - 7200)).toBe("2h ago");
    expect(timeAgo(nowTs - 172800)).toBe("2d ago");
  });

  it("timeAgo respects withSuffix option", () => {
    const nowTs = Math.floor(Date.now() / 1000);
    expect(timeAgo(nowTs - 30, false)).toBe("30s");
    expect(timeAgo(nowTs - 120, false)).toBe("2m");
  });

  it("formats dates", () => {
    // 2024-01-15 12:00:00 UTC — midday to avoid timezone edge issues
    const ts = 1705320000;
    const result = formatDate(ts);
    expect(result).toContain("2024");
    expect(result).toContain("January");
    expect(result).toContain("15");
  });
});

// ── Profile Utilities ────────────────────────────────────────────

describe("Profile utilities", () => {
  it("returns name when available", () => {
    const profile: ProfileInfo = {
      pubkey: "a".repeat(64),
      name: "alice",
      display_name: "Alice",
      picture: null,
      picture_local: null,
      nip05: null,
      about: null,
      banner: null,
      website: null,
      lud16: null,
    };
    expect(profileDisplayName(profile, profile.pubkey)).toBe("alice");
  });

  it("falls back to display_name when name is null", () => {
    const profile: ProfileInfo = {
      pubkey: "a".repeat(64),
      name: null,
      display_name: "Alice",
      picture: null,
      picture_local: null,
      nip05: null,
      about: null,
      banner: null,
      website: null,
      lud16: null,
    };
    expect(profileDisplayName(profile, profile.pubkey)).toBe("Alice");
  });

  it("falls back to shortened pubkey when no names", () => {
    const pk = "a".repeat(64);
    expect(profileDisplayName(undefined, pk)).toBe(shortPubkey(pk));
  });
});
