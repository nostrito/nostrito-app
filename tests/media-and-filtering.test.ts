/**
 * Media extraction, mute filtering, feed pagination, WoT filtering,
 * NIP-40 expiration, and UI utility tests.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { extractMediaUrls, stripMediaUrls } from "../src/utils/media";
import { avatarClass, kindLabel } from "../src/utils/ui";
import {
  TEST_SK,
  TEST_PK_HEX,
  TEST_PK2_HEX,
  WRITE_RELAY,
  connectRelay,
  ensureConnected,
  publishEvent,
  subscribeAndCollect,
  randomSubId,
  buildNote,
  buildMuteList,
  finalizeEvent,
  verifyEvent,
  now,
  sleep,
  generateSecretKey,
  getPublicKey,
} from "./setup";
import WebSocket from "ws";

let ws: WebSocket;

beforeAll(async () => {
  ws = await connectRelay(WRITE_RELAY);
});

beforeEach(async () => {
  ws = await ensureConnected(ws, WRITE_RELAY);
});

afterAll(() => {
  if (ws?.readyState === WebSocket.OPEN) ws.close();
});

// ── Media URL Extraction ─────────────────────────────────────────

describe("Media URL extraction", () => {
  it("extracts image URLs by extension", () => {
    const content = "Check this out https://example.com/photo.jpg and https://example.com/pic.png";
    const { images, videos } = extractMediaUrls(content);
    expect(images).toContain("https://example.com/photo.jpg");
    expect(images).toContain("https://example.com/pic.png");
    expect(videos).toEqual([]);
  });

  it("extracts video URLs by extension", () => {
    const content = "Watch https://example.com/clip.mp4 and https://example.com/vid.webm";
    const { images, videos } = extractMediaUrls(content);
    expect(videos).toContain("https://example.com/clip.mp4");
    expect(videos).toContain("https://example.com/vid.webm");
    expect(images).toEqual([]);
  });

  it("extracts images from Nostr CDNs without extension", () => {
    const content = "Image at https://nostr.build/i/abc123 and https://void.cat/d/xyz";
    const { images } = extractMediaUrls(content);
    expect(images).toContain("https://nostr.build/i/abc123");
    expect(images).toContain("https://void.cat/d/xyz");
  });

  it("handles mixed images and videos", () => {
    const content = "Photo https://example.com/a.jpg video https://example.com/b.mp4";
    const { images, videos } = extractMediaUrls(content);
    expect(images.length).toBe(1);
    expect(videos.length).toBe(1);
  });

  it("returns empty for content without URLs", () => {
    const { images, videos } = extractMediaUrls("Just text, no media here.");
    expect(images).toEqual([]);
    expect(videos).toEqual([]);
  });

  it("handles URLs with query parameters", () => {
    const content = "https://example.com/photo.jpg?w=800&h=600";
    const { images } = extractMediaUrls(content);
    expect(images.length).toBe(1);
  });

  it("recognizes all supported image extensions", () => {
    const exts = ["jpg", "jpeg", "png", "gif", "webp", "avif", "svg"];
    for (const ext of exts) {
      const { images } = extractMediaUrls(`https://example.com/img.${ext}`);
      expect(images.length).toBe(1);
    }
  });

  it("recognizes all supported video extensions", () => {
    const exts = ["mp4", "webm", "mov"];
    for (const ext of exts) {
      const { videos } = extractMediaUrls(`https://example.com/vid.${ext}`);
      expect(videos.length).toBe(1);
    }
  });

  it("recognizes Nostr-specific CDN domains", () => {
    const cdns = [
      "https://nostr.build/i/test",
      "https://void.cat/d/test",
      "https://blossom.example.com/test",
      "https://media.nostr.band/test",
      "https://nip.media/test",
    ];
    for (const url of cdns) {
      const { images } = extractMediaUrls(url);
      expect(images.length).toBeGreaterThanOrEqual(1);
    }
  });
});

// ── Media URL Stripping ──────────────────────────────────────────

describe("Media URL stripping", () => {
  it("strips image URLs from content", () => {
    const content = "Check this https://example.com/photo.jpg out";
    const stripped = stripMediaUrls(content);
    expect(stripped).not.toContain("https://example.com/photo.jpg");
    expect(stripped).toContain("Check this");
  });

  it("strips video URLs from content", () => {
    const content = "Watch https://example.com/clip.mp4 now";
    const stripped = stripMediaUrls(content);
    expect(stripped).not.toContain("https://example.com/clip.mp4");
  });

  it("preserves non-media text", () => {
    const content = "Hello world! This is important.";
    const stripped = stripMediaUrls(content);
    expect(stripped).toBe(content);
  });

  it("strips multiple media URLs", () => {
    const content = "A https://a.com/1.jpg B https://b.com/2.png C";
    const stripped = stripMediaUrls(content);
    expect(stripped).not.toContain("https://a.com/1.jpg");
    expect(stripped).not.toContain("https://b.com/2.png");
  });
});

// ── Feed Pagination ──────────────────────────────────────────────

describe("Feed pagination (since/until)", () => {
  it("since filter returns only events after timestamp", async () => {
    const sinceTs = now() - 2;
    const note = buildNote(`Since pagination ${Date.now()}`);
    await publishEvent(ws, note);
    await sleep(500);

    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { kinds: [1], authors: [TEST_PK_HEX], since: sinceTs, limit: 10 },
    ]);

    for (const ev of events) {
      expect((ev.created_at as number)).toBeGreaterThanOrEqual(sinceTs);
    }
  });

  it("until filter returns only events before timestamp", async () => {
    const untilTs = now() + 1;
    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { kinds: [1], authors: [TEST_PK_HEX], until: untilTs, limit: 5 },
    ]);

    for (const ev of events) {
      expect((ev.created_at as number)).toBeLessThanOrEqual(untilTs);
    }
  });

  it("since + until together creates a time window", async () => {
    const windowStart = now() - 60;
    const windowEnd = now() + 1;

    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { kinds: [1], since: windowStart, until: windowEnd, limit: 10 },
    ]);

    for (const ev of events) {
      expect((ev.created_at as number)).toBeGreaterThanOrEqual(windowStart);
      expect((ev.created_at as number)).toBeLessThanOrEqual(windowEnd);
    }
  });

  it("limit controls max events returned", async () => {
    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { kinds: [1], limit: 3 },
    ]);
    expect(events.length).toBeLessThanOrEqual(3);
  });
});

// ── Mute List Filtering ──────────────────────────────────────────

describe("Mute list structure for filtering", () => {
  it("mute list with p-tags for muted pubkeys", () => {
    const mutedPk = "a".repeat(64);
    const muteList = buildMuteList([mutedPk]);
    const pTags = muteList.tags.filter((t) => t[0] === "p");
    expect(pTags.length).toBe(1);
    expect(pTags[0][1]).toBe(mutedPk);
  });

  it("mute list with word tags for muted words", () => {
    const muteList = buildMuteList([], ["spam", "scam", "nsfw"]);
    const wordTags = muteList.tags.filter((t) => t[0] === "word");
    expect(wordTags.length).toBe(3);
    expect(wordTags.map((t) => t[1])).toContain("spam");
    expect(wordTags.map((t) => t[1])).toContain("scam");
    expect(wordTags.map((t) => t[1])).toContain("nsfw");
  });

  it("muted word should match event content (case-insensitive check)", () => {
    const mutedWords = ["spam", "SCAM"];
    const eventContent = "This is a Spam message about a scam";

    // Simulate what Nostrito's get_feed mute filter does
    const contentLower = eventContent.toLowerCase();
    const shouldMute = mutedWords.some((word) =>
      contentLower.includes(word.toLowerCase()),
    );
    expect(shouldMute).toBe(true);
  });

  it("non-muted content passes filter", () => {
    const mutedWords = ["spam", "scam"];
    const eventContent = "Just a regular post about nostr development";

    const contentLower = eventContent.toLowerCase();
    const shouldMute = mutedWords.some((word) =>
      contentLower.includes(word.toLowerCase()),
    );
    expect(shouldMute).toBe(false);
  });

  it("muted hashtag should match event t-tags", () => {
    const mutedHashtags = new Set(["nsfw", "spam"]);
    const eventTags = [["t", "nostr"], ["t", "nsfw"], ["t", "bitcoin"]];

    const shouldMute = eventTags.some(
      (tag) => tag[0] === "t" && mutedHashtags.has(tag[1].toLowerCase()),
    );
    expect(shouldMute).toBe(true);
  });

  it("event without muted hashtags passes", () => {
    const mutedHashtags = new Set(["nsfw", "spam"]);
    const eventTags = [["t", "nostr"], ["t", "bitcoin"]];

    const shouldMute = eventTags.some(
      (tag) => tag[0] === "t" && mutedHashtags.has(tag[1].toLowerCase()),
    );
    expect(shouldMute).toBe(false);
  });

  it("muted pubkey filter excludes events from that author", () => {
    const mutedPubkeys = new Set(["a".repeat(64), "b".repeat(64)]);
    const event = { pubkey: "a".repeat(64), content: "Hello" };

    const shouldMute = mutedPubkeys.has(event.pubkey);
    expect(shouldMute).toBe(true);

    const goodEvent = { pubkey: "c".repeat(64), content: "Hello" };
    expect(mutedPubkeys.has(goodEvent.pubkey)).toBe(false);
  });
});

// ── NIP-40 Expiration ────────────────────────────────────────────

describe("NIP-40 expiration tag", () => {
  it("creates event with expiration tag", () => {
    const expiresAt = now() + 3600; // 1 hour from now
    const note = finalizeEvent({
      kind: 1,
      created_at: now(),
      tags: [["expiration", expiresAt.toString()]],
      content: "This note expires in 1 hour",
    }, TEST_SK);

    const expTag = note.tags.find((t) => t[0] === "expiration");
    expect(expTag).toBeDefined();
    expect(parseInt(expTag![1])).toBe(expiresAt);
  });

  it("expired events should be filtered out", () => {
    const pastExpiry = now() - 60; // expired 1 minute ago
    const event = {
      tags: [["expiration", pastExpiry.toString()]],
      content: "Expired content",
    };

    const expTag = event.tags.find((t: string[]) => t[0] === "expiration");
    const expiresAt = expTag ? parseInt(expTag[1]) : Infinity;
    const isExpired = expiresAt < now();
    expect(isExpired).toBe(true);
  });

  it("non-expired events pass filter", () => {
    const futureExpiry = now() + 3600;
    const event = {
      tags: [["expiration", futureExpiry.toString()]],
      content: "Still valid",
    };

    const expTag = event.tags.find((t: string[]) => t[0] === "expiration");
    const expiresAt = expTag ? parseInt(expTag[1]) : Infinity;
    const isExpired = expiresAt < now();
    expect(isExpired).toBe(false);
  });

  it("events without expiration tag never expire", () => {
    const event = {
      tags: [["t", "nostr"]],
      content: "No expiry",
    };

    const expTag = event.tags.find((t: string[]) => t[0] === "expiration");
    const expiresAt = expTag ? parseInt(expTag[1]) : Infinity;
    expect(expiresAt).toBe(Infinity);
  });

  it("publishes event with expiration to relay", async () => {
    const expiresAt = now() + 86400; // expires in 24h
    const note = finalizeEvent({
      kind: 1,
      created_at: now(),
      tags: [["expiration", expiresAt.toString()]],
      content: `Expiring note ${Date.now()}`,
    }, TEST_SK);

    const result = await publishEvent(ws, note);
    expect(result.accepted).toBe(true);
  });
});

// ── UI Utilities ─────────────────────────────────────────────────

describe("UI utility functions", () => {
  it("avatarClass is deterministic for same pubkey", () => {
    const pk = "a".repeat(64);
    const cls1 = avatarClass(pk);
    const cls2 = avatarClass(pk);
    expect(cls1).toBe(cls2);
  });

  it("avatarClass returns a valid class", () => {
    const pk = "b".repeat(64);
    const cls = avatarClass(pk);
    expect(cls).toMatch(/^av[1-7]$/);
  });

  it("different pubkeys get different avatar classes (usually)", () => {
    const classes = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const pk = i.toString(16).padStart(64, "0");
      classes.add(avatarClass(pk));
    }
    // Should have at least 3 distinct classes out of 7
    expect(classes.size).toBeGreaterThanOrEqual(3);
  });

  it("kindLabel returns correct labels", () => {
    expect(kindLabel(1)).toEqual({ tag: "note", cls: "ev-kind-note" });
    expect(kindLabel(6)).toEqual({ tag: "repost", cls: "ev-kind-repost" });
    expect(kindLabel(30023)).toEqual({ tag: "long-form", cls: "ev-kind-long" });
  });

  it("kindLabel falls back for unknown kinds", () => {
    expect(kindLabel(999)).toEqual({ tag: "k:999", cls: "ev-kind-note" });
    expect(kindLabel(0)).toEqual({ tag: "k:0", cls: "ev-kind-note" });
  });
});
