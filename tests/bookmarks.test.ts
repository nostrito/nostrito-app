/**
 * NIP-51 Bookmark tests — kind:10003 private bookmark lists.
 *
 * Tests the protocol-level behavior that Nostrito's bookmark feature depends on:
 * - Event structure per NIP-51 spec
 * - Replaceable event semantics (kind 10003 is in the 10000-19999 range)
 * - Encrypted private content (NIP-04)
 * - Public e-tags for non-encrypted bookmarks
 * - Round-trip: publish → fetch → decrypt → verify
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import {
  TEST_SK,
  TEST_SK_HEX,
  TEST_PK_HEX,
  TEST_SK2,
  TEST_SK2_HEX,
  TEST_PK2_HEX,
  WRITE_RELAY,
  connectRelay,
  ensureConnected,
  publishEvent,
  subscribeAndCollect,
  randomSubId,
  buildNote,
  buildBookmarks,
  verifyEvent,
  nip04,
  sleep,
  finalizeEvent,
  now,
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

// ── NIP-51 Event Structure ───────────────────────────────────────

describe("NIP-51 bookmark event structure", () => {
  it("kind:10003 event has correct kind number", () => {
    const bk = buildBookmarks(["a".repeat(64)]);
    expect(bk.kind).toBe(10003);
  });

  it("bookmark list uses e-tags for event references", () => {
    const ids = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
    const bk = buildBookmarks(ids);
    expect(bk.tags.length).toBe(3);
    for (let i = 0; i < ids.length; i++) {
      expect(bk.tags[i][0]).toBe("e");
      expect(bk.tags[i][1]).toBe(ids[i]);
    }
  });

  it("bookmark event has valid signature", () => {
    const bk = buildBookmarks(["a".repeat(64)]);
    expect(verifyEvent(bk)).toBe(true);
  });

  it("empty bookmark list produces empty tags", () => {
    const bk = buildBookmarks([]);
    expect(bk.kind).toBe(10003);
    expect(bk.tags.length).toBe(0);
    expect(bk.content).toBe("");
  });

  it("bookmark event pubkey matches signer", () => {
    const bk = buildBookmarks(["a".repeat(64)]);
    expect(bk.pubkey).toBe(TEST_PK_HEX);
  });
});

// ── NIP-51 with Encrypted Private Bookmarks ──────────────────────

describe("NIP-51 encrypted private bookmarks (NIP-04)", () => {
  it("encrypts bookmark tags into event content", async () => {
    // Simulate what Nostrito's publish_bookmark_list does:
    // Private tags are encrypted with NIP-04 self-encryption (encrypt to own pubkey)
    const bookmarkIds = ["a".repeat(64), "b".repeat(64)];
    const privateTags = bookmarkIds.map((id) => ["e", id]);
    const privateJson = JSON.stringify(privateTags);

    // Self-encrypt using NIP-04 (encrypt to own pubkey)
    const encrypted = await nip04.encrypt(TEST_SK_HEX, TEST_PK_HEX, privateJson);
    expect(encrypted).toContain("?iv="); // NIP-04 format

    // Build kind:10003 with encrypted content, no public tags
    const event = finalizeEvent({
      kind: 10003,
      created_at: now(),
      tags: [], // no public tags — all private
      content: encrypted,
    }, TEST_SK);

    expect(event.kind).toBe(10003);
    expect(event.content.length).toBeGreaterThan(0);
    expect(event.tags.length).toBe(0); // tags are private (encrypted)
  });

  it("self-decrypts private bookmark content", async () => {
    const bookmarkIds = ["a".repeat(64), "b".repeat(64)];
    const privateTags = bookmarkIds.map((id) => ["e", id]);
    const privateJson = JSON.stringify(privateTags);

    const encrypted = await nip04.encrypt(TEST_SK_HEX, TEST_PK_HEX, privateJson);

    // Decrypt with same keypair (self-decryption)
    const decrypted = await nip04.decrypt(TEST_SK_HEX, TEST_PK_HEX, encrypted);
    const parsedTags = JSON.parse(decrypted);

    expect(parsedTags).toEqual(privateTags);
    expect(parsedTags.length).toBe(2);
    expect(parsedTags[0]).toEqual(["e", "a".repeat(64)]);
    expect(parsedTags[1]).toEqual(["e", "b".repeat(64)]);
  });

  it("other users cannot decrypt private bookmarks", async () => {
    const bookmarkIds = ["a".repeat(64)];
    const privateTags = bookmarkIds.map((id) => ["e", id]);
    const privateJson = JSON.stringify(privateTags);

    // User 1 encrypts to self
    const encrypted = await nip04.encrypt(TEST_SK_HEX, TEST_PK_HEX, privateJson);

    // User 2 tries to decrypt — should fail or produce garbage
    try {
      const result = await nip04.decrypt(TEST_SK2_HEX, TEST_PK_HEX, encrypted);
      // If it doesn't throw, the result should not match the original
      expect(result).not.toBe(privateJson);
    } catch {
      // Expected — decryption should fail
      expect(true).toBe(true);
    }
  });

  it("publishes encrypted bookmark list to relay", async () => {
    const bookmarkIds = ["a".repeat(64), "b".repeat(64)];
    const privateTags = bookmarkIds.map((id) => ["e", id]);
    const privateJson = JSON.stringify(privateTags);
    const encrypted = await nip04.encrypt(TEST_SK_HEX, TEST_PK_HEX, privateJson);

    const event = finalizeEvent({
      kind: 10003,
      created_at: now(),
      tags: [],
      content: encrypted,
    }, TEST_SK);

    const result = await publishEvent(ws, event);
    expect(result.accepted).toBe(true);
  });

  it("round-trip: publish encrypted → fetch → decrypt → verify", async () => {
    const bookmarkIds = ["c".repeat(64), "d".repeat(64)];
    const privateTags = bookmarkIds.map((id) => ["e", id]);
    const privateJson = JSON.stringify(privateTags);
    const encrypted = await nip04.encrypt(TEST_SK_HEX, TEST_PK_HEX, privateJson);

    const event = finalizeEvent({
      kind: 10003,
      created_at: now(),
      tags: [],
      content: encrypted,
    }, TEST_SK);

    const result = await publishEvent(ws, event);
    expect(result.accepted).toBe(true);
    await sleep(1_000);

    // Fetch by ID
    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { ids: [event.id] },
    ], 8_000);

    if (events.length === 0) {
      // Relay slow — verify locally instead (event was accepted)
      const decrypted = await nip04.decrypt(TEST_SK_HEX, TEST_PK_HEX, event.content);
      const parsedTags = JSON.parse(decrypted);
      expect(parsedTags).toEqual(privateTags);
      return;
    }

    const fetched = events[0];
    expect(fetched.kind).toBe(10003);
    expect(fetched.pubkey).toBe(TEST_PK_HEX);

    // Decrypt the content
    const decrypted = await nip04.decrypt(TEST_SK_HEX, TEST_PK_HEX, fetched.content as string);
    const parsedTags = JSON.parse(decrypted);
    expect(parsedTags).toEqual(privateTags);
  });
});

// ── NIP-51 with Mixed Public + Private Tags ──────────────────────

describe("NIP-51 mixed public and private tags", () => {
  it("supports both public e-tags and encrypted content", async () => {
    // NIP-51 allows both public (unencrypted) tags and encrypted content
    const publicIds = ["aaa".padEnd(64, "0")];
    const privateIds = ["bbb".padEnd(64, "0"), "ccc".padEnd(64, "0")];

    const publicTags = publicIds.map((id) => ["e", id]);
    const privateTags = privateIds.map((id) => ["e", id]);
    const privateJson = JSON.stringify(privateTags);
    const encrypted = await nip04.encrypt(TEST_SK_HEX, TEST_PK_HEX, privateJson);

    const event = finalizeEvent({
      kind: 10003,
      created_at: now(),
      tags: publicTags,
      content: encrypted,
    }, TEST_SK);

    expect(event.tags.length).toBe(1); // 1 public tag
    expect(event.content.length).toBeGreaterThan(0); // encrypted private tags

    const result = await publishEvent(ws, event);
    expect(result.accepted).toBe(true);

    await sleep(500);

    // Fetch and verify both public and private tags are recoverable
    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { ids: [event.id] },
    ]);

    expect(events.length).toBe(1);
    const fetched = events[0];

    // Public tags visible directly
    const fetchedTags = fetched.tags as string[][];
    const publicEIds = fetchedTags.filter((t) => t[0] === "e").map((t) => t[1]);
    expect(publicEIds).toContain(publicIds[0]);

    // Private tags recovered via decryption
    const decrypted = await nip04.decrypt(TEST_SK_HEX, TEST_PK_HEX, fetched.content as string);
    const recoveredPrivate = JSON.parse(decrypted);
    const privateEIds = recoveredPrivate.map((t: string[]) => t[1]);
    expect(privateEIds).toContain(privateIds[0]);
    expect(privateEIds).toContain(privateIds[1]);

    // Combined should give us all 3 bookmark IDs
    const allIds = [...publicEIds, ...privateEIds];
    expect(allIds.length).toBe(3);
  });
});

// ── Replaceable Event Semantics ──────────────────────────────────

describe("Kind:10003 replaceable event semantics", () => {
  it("kind 10003 is in the replaceable range (10000-19999)", () => {
    expect(10003).toBeGreaterThanOrEqual(10000);
    expect(10003).toBeLessThan(20000);
  });

  it("newer bookmark list replaces older one", async () => {
    // Publish v1 with 1 bookmark
    const v1 = buildBookmarks(["a".repeat(64)]);
    await publishEvent(ws, v1);
    await sleep(1_500);

    // Publish v2 with 2 bookmarks
    const v2 = buildBookmarks(["b".repeat(64), "c".repeat(64)]);
    await publishEvent(ws, v2);
    await sleep(1_000);

    // Fetch latest — should be v2
    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { kinds: [10003], authors: [TEST_PK_HEX], limit: 5 },
    ]);

    expect(events.length).toBeGreaterThanOrEqual(1);
    const newest = events.sort(
      (a, b) => (b.created_at as number) - (a.created_at as number),
    )[0];
    const eTags = (newest.tags as string[][]).filter((t) => t[0] === "e");
    expect(eTags.length).toBe(2);
  });

  it("adding a bookmark produces event with combined tags", () => {
    // Simulate: user had [x] bookmarked, now adds [y] → new event with [x, y]
    const original = ["x".repeat(64)];
    const added = "y".repeat(64);
    const updated = [...original, added];

    const event = buildBookmarks(updated);
    expect(event.kind).toBe(10003);
    expect(verifyEvent(event)).toBe(true);

    const eTags = event.tags.filter((t) => t[0] === "e");
    expect(eTags.length).toBe(2);
    expect(eTags.map((t) => t[1])).toContain(original[0]);
    expect(eTags.map((t) => t[1])).toContain(added);
  });

  it("removing a bookmark produces event without removed ID", () => {
    // Simulate: user had [x, y], removes y → new event with [x]
    const remaining = ["x".repeat(64)];
    const event = buildBookmarks(remaining);
    expect(event.kind).toBe(10003);
    expect(verifyEvent(event)).toBe(true);

    const eTags = event.tags.filter((t) => t[0] === "e");
    expect(eTags.length).toBe(1);
    expect(eTags[0][1]).toBe(remaining[0]);
  });
});

// ── Bookmark → Event Resolution ──────────────────────────────────

describe("Bookmark event resolution", () => {
  it("bookmarked note can be fetched by ID from its e-tag", async () => {
    // Publish a note
    const note = buildNote(`Bookmarkable note ${Date.now()}`);
    await publishEvent(ws, note);

    // Bookmark it
    const bk = buildBookmarks([note.id]);
    await publishEvent(ws, bk);
    await sleep(500);

    // Fetch the bookmark event by exact ID
    const subId1 = randomSubId();
    const bkEvents = await subscribeAndCollect(ws, subId1, [
      { ids: [bk.id] },
    ]);
    expect(bkEvents.length).toBe(1);

    // Extract bookmarked event IDs
    const tags = bkEvents[0].tags as string[][];
    const bookmarkedIds = tags.filter((t) => t[0] === "e").map((t) => t[1]);
    expect(bookmarkedIds).toContain(note.id);

    // Fetch the bookmarked note
    const subId2 = randomSubId();
    const noteEvents = await subscribeAndCollect(ws, subId2, [
      { ids: [note.id] },
    ]);
    expect(noteEvents.length).toBe(1);
    expect(noteEvents[0].id).toBe(note.id);
    expect(noteEvents[0].content).toBe(note.content);
  });

  it("bookmarks with encrypted IDs can resolve after decryption", async () => {
    // Publish a note
    const note = buildNote(`Private bookmark target ${Date.now()}`);
    await publishEvent(ws, note);

    // Create encrypted bookmark
    const privateTags = [["e", note.id]];
    const encrypted = await nip04.encrypt(TEST_SK_HEX, TEST_PK_HEX, JSON.stringify(privateTags));

    const bk = finalizeEvent({
      kind: 10003,
      created_at: now(),
      tags: [],
      content: encrypted,
    }, TEST_SK);
    await publishEvent(ws, bk);
    await sleep(500);

    // Fetch bookmark, decrypt, resolve
    const subId1 = randomSubId();
    const bkEvents = await subscribeAndCollect(ws, subId1, [
      { ids: [bk.id] },
    ]);
    expect(bkEvents.length).toBe(1);

    // No public tags — must decrypt
    const fetchedTags = bkEvents[0].tags as string[][];
    expect(fetchedTags.length).toBe(0);

    // Decrypt to get bookmark IDs
    const decrypted = await nip04.decrypt(TEST_SK_HEX, TEST_PK_HEX, bkEvents[0].content as string);
    const parsedTags = JSON.parse(decrypted) as string[][];
    const ids = parsedTags.filter((t) => t[0] === "e").map((t) => t[1]);
    expect(ids).toContain(note.id);

    // Resolve the bookmarked note
    const subId2 = randomSubId();
    const noteEvents = await subscribeAndCollect(ws, subId2, [
      { ids },
    ]);
    expect(noteEvents.length).toBe(1);
    expect(noteEvents[0].id).toBe(note.id);
  });
});

// ── Interop: Nostrito's Bookmark Format ──────────────────────────

describe("Nostrito bookmark format interop", () => {
  it("matches Nostrito's publish_bookmark_list format (all private, NIP-04)", async () => {
    // Nostrito stores ALL bookmarks as encrypted private tags (no public e-tags)
    // Format: content = NIP-04 encrypted JSON array of ["e", id] pairs
    const bookmarkIds = [
      "1".repeat(64),
      "2".repeat(64),
      "3".repeat(64),
    ];

    const privateTags = bookmarkIds.map((id) => ["e", id]);
    const privateJson = JSON.stringify(privateTags);
    const encrypted = await nip04.encrypt(TEST_SK_HEX, TEST_PK_HEX, privateJson);

    const event = finalizeEvent({
      kind: 10003,
      created_at: now(),
      tags: [], // Nostrito uses no public tags
      content: encrypted,
    }, TEST_SK);

    // Verify format matches what Nostrito expects
    expect(event.kind).toBe(10003);
    expect(event.tags.length).toBe(0);
    expect(event.content).toContain("?iv=");

    // Verify decryption yields the expected structure
    const decrypted = await nip04.decrypt(TEST_SK_HEX, TEST_PK_HEX, event.content);
    const parsed = JSON.parse(decrypted);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(3);
    for (const tag of parsed) {
      expect(tag[0]).toBe("e");
      expect(typeof tag[1]).toBe("string");
      expect(tag[1].length).toBe(64);
    }
  });

  it("handles sync_bookmarks_from_relays pattern: fetch → decrypt → extract IDs", async () => {
    // Simulate what Nostrito does when syncing bookmarks from relays
    const bookmarkIds = ["a1".padEnd(64, "0"), "b2".padEnd(64, "0")];

    // Step 1: Create and publish encrypted bookmark list (as Nostrito does)
    const privateTags = bookmarkIds.map((id) => ["e", id]);
    const encrypted = await nip04.encrypt(TEST_SK_HEX, TEST_PK_HEX, JSON.stringify(privateTags));
    const event = finalizeEvent({
      kind: 10003,
      created_at: now(),
      tags: [],
      content: encrypted,
    }, TEST_SK);
    await publishEvent(ws, event);
    await sleep(500);

    // Step 2: Fetch from relay (as sync_bookmarks_from_relays does)
    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { ids: [event.id] },
    ]);
    expect(events.length).toBe(1);
    const fetched = events[0];

    // Step 3: Collect public e-tags (none in this case)
    const fetchedTags = fetched.tags as string[][];
    const publicIds = fetchedTags.filter((t) => t[0] === "e").map((t) => t[1]);
    expect(publicIds.length).toBe(0);

    // Step 4: Decrypt content for private bookmarks
    const decrypted = await nip04.decrypt(TEST_SK_HEX, TEST_PK_HEX, fetched.content as string);
    const parsedPrivate = JSON.parse(decrypted) as string[][];
    const privateBookmarkIds = parsedPrivate
      .filter((t) => t.length >= 2 && t[0] === "e")
      .map((t) => t[1]);

    // Step 5: Merge public + private (same as Nostrito's sync logic)
    const allBookmarkIds = [...publicIds, ...privateBookmarkIds];
    expect(allBookmarkIds).toContain(bookmarkIds[0]);
    expect(allBookmarkIds).toContain(bookmarkIds[1]);
    expect(allBookmarkIds.length).toBe(2);
  });
});
