/**
 * NIP-19 bech32 encoding/decoding tests.
 * Tests npub, note, nevent, nprofile, naddr entity parsing
 * using the app's own decodeEntity and npubToHex functions.
 */

import { describe, it, expect } from "vitest";
import { decodeEntity, npubToHex, normalizeBareEntities, extractMentionedPubkeys } from "../src/utils/mentions";
import { nip19 } from "nostr-tools";
import { TEST_PK_HEX, TEST_PK2_HEX } from "./setup";

// ── npub encoding/decoding ───────────────────────────────────────

describe("NIP-19 npub", () => {
  it("decodes a valid npub to hex pubkey", () => {
    const npub = nip19.npubEncode(TEST_PK_HEX);
    const hex = npubToHex(npub);
    expect(hex).toBe(TEST_PK_HEX);
  });

  it("decodes npub via decodeEntity", () => {
    const npub = nip19.npubEncode(TEST_PK_HEX);
    const result = decodeEntity(npub);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("npub");
    expect(result!.pubkey).toBe(TEST_PK_HEX);
  });

  it("returns null for invalid npub", () => {
    expect(npubToHex("npub1invalid")).toBeNull();
    expect(npubToHex("not-an-npub")).toBeNull();
    expect(npubToHex("")).toBeNull();
  });

  it("npub round-trips correctly", () => {
    const npub = nip19.npubEncode(TEST_PK_HEX);
    expect(npub).toMatch(/^npub1[a-z0-9]+$/);
    const decoded = npubToHex(npub);
    expect(decoded).toBe(TEST_PK_HEX);
  });
});

// ── note encoding/decoding ───────────────────────────────────────

describe("NIP-19 note", () => {
  it("decodes a note1 entity to event ID", () => {
    const eventId = "a".repeat(64);
    const note = nip19.noteEncode(eventId);
    const result = decodeEntity(note);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("note");
    expect(result!.eventId).toBe(eventId);
  });

  it("note1 starts with correct prefix", () => {
    const note = nip19.noteEncode("b".repeat(64));
    expect(note).toMatch(/^note1[a-z0-9]+$/);
  });
});

// ── nprofile encoding/decoding ───────────────────────────────────

describe("NIP-19 nprofile", () => {
  it("decodes nprofile with pubkey only", () => {
    const nprofile = nip19.nprofileEncode({ pubkey: TEST_PK_HEX });
    const result = decodeEntity(nprofile);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("nprofile");
    expect(result!.pubkey).toBe(TEST_PK_HEX);
  });

  it("decodes nprofile with pubkey and relays", () => {
    const nprofile = nip19.nprofileEncode({
      pubkey: TEST_PK_HEX,
      relays: ["wss://relay.damus.io", "wss://nos.lol"],
    });
    const result = decodeEntity(nprofile);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("nprofile");
    expect(result!.pubkey).toBe(TEST_PK_HEX);
    expect(result!.relays).toContain("wss://relay.damus.io");
    expect(result!.relays).toContain("wss://nos.lol");
  });
});

// ── nevent encoding/decoding ─────────────────────────────────────

describe("NIP-19 nevent", () => {
  it("decodes nevent with event ID", () => {
    const eventId = "c".repeat(64);
    const nevent = nip19.neventEncode({ id: eventId });
    const result = decodeEntity(nevent);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("nevent");
    expect(result!.eventId).toBe(eventId);
  });

  it("decodes nevent with event ID, author, and relays", () => {
    const eventId = "d".repeat(64);
    const nevent = nip19.neventEncode({
      id: eventId,
      author: TEST_PK_HEX,
      relays: ["wss://relay.damus.io"],
    });
    const result = decodeEntity(nevent);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("nevent");
    expect(result!.eventId).toBe(eventId);
    expect(result!.pubkey).toBe(TEST_PK_HEX);
    expect(result!.relays).toContain("wss://relay.damus.io");
  });

  it("decodes nevent with kind", () => {
    const eventId = "e".repeat(64);
    const nevent = nip19.neventEncode({
      id: eventId,
      kind: 30023,
    });
    const result = decodeEntity(nevent);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe(30023);
  });
});

// ── naddr encoding/decoding ──────────────────────────────────────

describe("NIP-19 naddr", () => {
  it("decodes naddr with kind, pubkey, and d-tag", () => {
    const naddr = nip19.naddrEncode({
      kind: 30023,
      pubkey: TEST_PK_HEX,
      identifier: "my-article",
    });
    const result = decodeEntity(naddr);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("naddr");
    expect(result!.kind).toBe(30023);
    expect(result!.pubkey).toBe(TEST_PK_HEX);
    expect(result!.dTag).toBe("my-article");
  });

  it("decodes naddr with relays", () => {
    const naddr = nip19.naddrEncode({
      kind: 30023,
      pubkey: TEST_PK_HEX,
      identifier: "test",
      relays: ["wss://nos.lol"],
    });
    const result = decodeEntity(naddr);
    expect(result).not.toBeNull();
    expect(result!.relays).toContain("wss://nos.lol");
  });
});

// ── Bare entity normalization ────────────────────────────────────

describe("Bare entity normalization", () => {
  it("adds nostr: prefix to bare npub", () => {
    const npub = nip19.npubEncode(TEST_PK_HEX);
    const content = `Check out ${npub} for more`;
    const normalized = normalizeBareEntities(content);
    expect(normalized).toContain(`nostr:${npub}`);
  });

  it("adds nostr: prefix to bare note1", () => {
    const note = nip19.noteEncode("f".repeat(64));
    const content = `See this ${note}`;
    const normalized = normalizeBareEntities(content);
    expect(normalized).toContain(`nostr:${note}`);
  });

  it("does not double-prefix already prefixed entities", () => {
    const npub = nip19.npubEncode(TEST_PK_HEX);
    const content = `Hi nostr:${npub}`;
    const normalized = normalizeBareEntities(content);
    // Should still have exactly one nostr: prefix
    expect(normalized).toBe(content);
  });

  it("handles @-prefixed mentions", () => {
    const npub = nip19.npubEncode(TEST_PK_HEX);
    const content = `Hello @${npub}!`;
    const normalized = normalizeBareEntities(content);
    expect(normalized).toContain(`nostr:${npub}`);
  });

  it("does not match inside URLs", () => {
    const content = "https://example.com/npub1abcdefghijklmnopqrstuvwxyz";
    const normalized = normalizeBareEntities(content);
    // URL should not be modified (has / before npub)
    expect(normalized).toBe(content);
  });
});

// ── Pubkey extraction from content ───────────────────────────────

describe("Extract mentioned pubkeys from content", () => {
  it("extracts pubkey from nostr:npub mention", () => {
    const npub = nip19.npubEncode(TEST_PK_HEX);
    const content = `Hey nostr:${npub} what's up?`;
    const pks = extractMentionedPubkeys(content);
    expect(pks).toContain(TEST_PK_HEX);
  });

  it("extracts pubkey from nostr:nprofile mention", () => {
    const nprofile = nip19.nprofileEncode({ pubkey: TEST_PK2_HEX });
    const content = `Check nostr:${nprofile}`;
    const pks = extractMentionedPubkeys(content);
    expect(pks).toContain(TEST_PK2_HEX);
  });

  it("extracts multiple pubkeys from content", () => {
    const npub1 = nip19.npubEncode(TEST_PK_HEX);
    const npub2 = nip19.npubEncode(TEST_PK2_HEX);
    const content = `nostr:${npub1} and nostr:${npub2} are cool`;
    const pks = extractMentionedPubkeys(content);
    expect(pks).toContain(TEST_PK_HEX);
    expect(pks).toContain(TEST_PK2_HEX);
  });

  it("extracts pubkeys from bare mentions (no nostr: prefix)", () => {
    const npub = nip19.npubEncode(TEST_PK_HEX);
    const content = `Hey ${npub} check this out`;
    const pks = extractMentionedPubkeys(content);
    expect(pks).toContain(TEST_PK_HEX);
  });

  it("returns empty array for content with no mentions", () => {
    const pks = extractMentionedPubkeys("Just a regular note with no mentions");
    expect(pks).toEqual([]);
  });

  it("does not extract event IDs as pubkeys", () => {
    const note = nip19.noteEncode("a".repeat(64));
    const content = `See nostr:${note}`;
    const pks = extractMentionedPubkeys(content);
    expect(pks).toEqual([]);
  });
});
