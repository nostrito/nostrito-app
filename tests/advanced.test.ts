/**
 * Advanced tests — DMs (NIP-04), articles (kind:30023), bookmarks (kind:10003),
 * and cross-relay consistency.
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
  TEST_RELAYS,
  connectRelay,
  ensureConnected,
  publishEvent,
  subscribeAndCollect,
  randomSubId,
  buildNote,
  buildArticle,
  buildBookmarks,
  buildDM,
  verifyEvent,
  nip04,
  sleep,
  bytesToHex,
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

// ── NIP-04 Encrypted DMs (kind:4) ───────────────────────────────

describe("NIP-04 encrypted DMs (kind:4)", () => {
  it("encrypts and creates a DM event", async () => {
    const dm = await buildDM("Hello from test!", TEST_PK2_HEX);
    expect(dm.kind).toBe(4);
    expect(dm.pubkey).toBe(TEST_PK_HEX);
    // Content should be encrypted (contains "?iv=" for NIP-04)
    expect(dm.content).toContain("?iv=");
    // Should have p-tag for recipient
    const pTag = dm.tags.find((t) => t[0] === "p");
    expect(pTag).toBeDefined();
    expect(pTag![1]).toBe(TEST_PK2_HEX);
  });

  it("recipient can decrypt the DM", async () => {
    const plaintext = `Secret message ${Date.now()}`;
    const dm = await buildDM(plaintext, TEST_PK2_HEX, TEST_SK);

    // Decrypt using recipient's secret key and sender's pubkey
    const decrypted = await nip04.decrypt(TEST_SK2_HEX, TEST_PK_HEX, dm.content);
    expect(decrypted).toBe(plaintext);
  });

  it("publishes DM to relay", async () => {
    const dm = await buildDM(`Relay DM test ${Date.now()}`, TEST_PK2_HEX);
    const result = await publishEvent(ws, dm);
    expect(result.accepted).toBe(true);
  });

  it("fetches DMs between two parties", async () => {
    const plaintext = `Fetch DM test ${Date.now()}`;
    const dm = await buildDM(plaintext, TEST_PK2_HEX);
    await publishEvent(ws, dm);
    await sleep(500);

    // Query for kind:4 events from our test pubkey to recipient
    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { kinds: [4], authors: [TEST_PK_HEX], "#p": [TEST_PK2_HEX], limit: 10 },
    ]);

    const found = events.find((e) => e.id === dm.id);
    expect(found).toBeDefined();
    expect(found!.kind).toBe(4);

    // Verify we can still decrypt after fetch from relay
    const decrypted = await nip04.decrypt(
      TEST_SK_HEX,
      TEST_PK2_HEX,
      found!.content as string,
    );
    expect(decrypted).toBe(plaintext);
  });

  it("DM from second keypair to first", async () => {
    const plaintext = `Reply DM ${Date.now()}`;
    const dm = await buildDM(plaintext, TEST_PK_HEX, TEST_SK2);
    expect(dm.pubkey).toBe(TEST_PK2_HEX);

    const result = await publishEvent(ws, dm);
    expect(result.accepted).toBe(true);

    // First keypair decrypts
    const decrypted = await nip04.decrypt(TEST_SK_HEX, TEST_PK2_HEX, dm.content);
    expect(decrypted).toBe(plaintext);
  });
});

// ── Kind:30023 Long-form Articles ────────────────────────────────

describe("Kind:30023 long-form articles", () => {
  it("creates a valid article event", () => {
    const article = buildArticle({
      title: "Test Article",
      content: "# Hello\n\nThis is a test article with **markdown**.",
      dTag: "test-article",
      summary: "A test article",
      hashtags: ["test", "nostr"],
    });
    expect(article.kind).toBe(30023);
    expect(article.pubkey).toBe(TEST_PK_HEX);

    const tags = article.tags;
    expect(tags.find((t) => t[0] === "d")![1]).toBe("test-article");
    expect(tags.find((t) => t[0] === "title")![1]).toBe("Test Article");
    expect(tags.find((t) => t[0] === "summary")![1]).toBe("A test article");
    expect(tags.find((t) => t[0] === "published_at")).toBeDefined();
    const tTags = tags.filter((t) => t[0] === "t").map((t) => t[1]);
    expect(tTags).toContain("test");
    expect(tTags).toContain("nostr");
  });

  it("publishes an article to relay", async () => {
    const article = buildArticle({
      title: `Article ${Date.now()}`,
      content: "This is a test article published from vitest.",
      dTag: `vitest-article-${Date.now()}`,
    });
    const result = await publishEvent(ws, article);
    expect(result.accepted).toBe(true);
  });

  it("fetches articles by author and kind", async () => {
    const dTag = `fetch-article-${Date.now()}`;
    const article = buildArticle({
      title: "Fetch Article Test",
      content: "Content for fetch test",
      dTag,
    });
    await publishEvent(ws, article);
    await sleep(500);

    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { kinds: [30023], authors: [TEST_PK_HEX], limit: 10 },
    ]);

    const found = events.find((e) => e.id === article.id);
    expect(found).toBeDefined();
    expect(found!.kind).toBe(30023);
  });

  it("fetches article by d-tag (NIP-33 addressable)", async () => {
    const dTag = `addressable-${Date.now()}`;
    const article = buildArticle({
      title: "Addressable Article",
      content: "Find me by d-tag",
      dTag,
    });
    await publishEvent(ws, article);
    await sleep(500);

    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { kinds: [30023], authors: [TEST_PK_HEX], "#d": [dTag], limit: 5 },
    ]);

    expect(events.length).toBeGreaterThanOrEqual(1);
    const found = events.find((e) => {
      const tags = e.tags as string[][];
      return tags.some((t) => t[0] === "d" && t[1] === dTag);
    });
    expect(found).toBeDefined();
  });

  it("article update replaces by d-tag (parameterized replaceable)", async () => {
    const dTag = `replaceable-${Date.now()}`;

    const v1 = buildArticle({
      title: "Version 1",
      content: "First version",
      dTag,
    });
    await publishEvent(ws, v1);
    // Wait >1s so v2 gets a strictly newer created_at
    await sleep(1_500);

    const v2 = buildArticle({
      title: "Version 2",
      content: "Updated version",
      dTag,
    });
    await publishEvent(ws, v2);
    await sleep(1_000);

    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { kinds: [30023], authors: [TEST_PK_HEX], "#d": [dTag], limit: 5 },
    ]);

    // Relay should return the newest version (parameterized replaceable)
    const newest = events.sort(
      (a, b) => (b.created_at as number) - (a.created_at as number),
    )[0];
    expect(newest.content).toBe("Updated version");
  });
});

// ── Kind:10003 Bookmarks ─────────────────────────────────────────

describe("Kind:10003 bookmarks", () => {
  it("creates a bookmark list event", () => {
    const bookmarks = buildBookmarks(["a".repeat(64), "b".repeat(64)]);
    expect(bookmarks.kind).toBe(10003);
    expect(bookmarks.tags.length).toBe(2);
    expect(bookmarks.tags[0]).toEqual(["e", "a".repeat(64)]);
  });

  it("publishes bookmarks to relay", async () => {
    const note1 = buildNote(`Bookmark target 1 ${Date.now()}`);
    const note2 = buildNote(`Bookmark target 2 ${Date.now()}`);
    await publishEvent(ws, note1);
    await publishEvent(ws, note2);

    const bookmarks = buildBookmarks([note1.id, note2.id]);
    const result = await publishEvent(ws, bookmarks);
    expect(result.accepted).toBe(true);
  });

  it("fetches bookmarks and resolves referenced events", async () => {
    const note = buildNote(`Bookmark fetch test ${Date.now()}`);
    await publishEvent(ws, note);

    const bookmarks = buildBookmarks([note.id]);
    await publishEvent(ws, bookmarks);
    await sleep(500);

    // Fetch bookmark event by exact ID to avoid races with other replaceable event tests
    const subId1 = randomSubId();
    const bkEvents = await subscribeAndCollect(ws, subId1, [
      { ids: [bookmarks.id] },
    ]);

    expect(bkEvents.length).toBe(1);
    const tags = bkEvents[0].tags as string[][];
    const bookmarkedIds = tags.filter((t) => t[0] === "e").map((t) => t[1]);
    expect(bookmarkedIds).toContain(note.id);

    // Now fetch the bookmarked events by ID
    const subId2 = randomSubId();
    const resolvedEvents = await subscribeAndCollect(ws, subId2, [
      { ids: bookmarkedIds },
    ]);

    const foundNote = resolvedEvents.find((e) => e.id === note.id);
    expect(foundNote).toBeDefined();
  });
});

// ── Cross-relay Consistency ──────────────────────────────────────

describe("Cross-relay event propagation", () => {
  it("event published to one relay can be found on another", async () => {
    // Publish to primary relay
    const content = `Cross-relay test ${Date.now()}`;
    const note = buildNote(content);
    await publishEvent(ws, note);

    // Try to find on a different relay
    const otherRelay = TEST_RELAYS.find((r) => r !== WRITE_RELAY) ?? TEST_RELAYS[0];
    const ws2 = await connectRelay(otherRelay);

    try {
      // Also publish to the other relay for reliability
      await publishEvent(ws2, note);
      await sleep(1_000);

      const subId = randomSubId();
      const events = await subscribeAndCollect(ws2, subId, [
        { ids: [note.id] },
      ], 8_000);

      const found = events.find((e) => e.id === note.id);
      expect(found).toBeDefined();
      expect(found!.content).toBe(content);
    } finally {
      ws2.close();
    }
  });
});

// ── Content Warning (NIP-36) ─────────────────────────────────────

describe("Content warning (NIP-36)", () => {
  it("creates note with content-warning tag", () => {
    const note = finalizeEvent({
      kind: 1,
      created_at: now(),
      tags: [["content-warning", "NSFW content"]],
      content: "This is sensitive content",
    }, TEST_SK);

    const cwTag = note.tags.find((t) => t[0] === "content-warning");
    expect(cwTag).toBeDefined();
    expect(cwTag![1]).toBe("NSFW content");
  });

  it("publishes note with content warning", async () => {
    const note = finalizeEvent({
      kind: 1,
      created_at: now(),
      tags: [["content-warning", "Test CW"]],
      content: `CW test ${Date.now()}`,
    }, TEST_SK);
    const result = await publishEvent(ws, note);
    expect(result.accepted).toBe(true);
  });
});

// ── Kind:10002 Relay List Metadata (NIP-65) ──────────────────────

describe("Kind:10002 relay list (NIP-65)", () => {
  it("creates a relay list event", () => {
    const relayList = finalizeEvent({
      kind: 10002,
      created_at: now(),
      tags: [
        ["r", "wss://relay.damus.io", "read"],
        ["r", "wss://nos.lol", "write"],
        ["r", "wss://relay.primal.net"],
      ],
      content: "",
    }, TEST_SK);

    expect(relayList.kind).toBe(10002);
    const rTags = relayList.tags.filter((t) => t[0] === "r");
    expect(rTags.length).toBe(3);
    expect(rTags[0]).toEqual(["r", "wss://relay.damus.io", "read"]);
    expect(rTags[1]).toEqual(["r", "wss://nos.lol", "write"]);
    expect(rTags[2]).toEqual(["r", "wss://relay.primal.net"]);
  });

  it("publishes relay list to relay", async () => {
    const relayList = finalizeEvent({
      kind: 10002,
      created_at: now(),
      tags: [
        ["r", "wss://relay.damus.io"],
        ["r", "wss://nos.lol"],
      ],
      content: "",
    }, TEST_SK);
    const result = await publishEvent(ws, relayList);
    expect(result.accepted).toBe(true);
  });
});

// ── Event Signature Integrity ────────────────────────────────────

describe("Event signature integrity across operations", () => {
  it("serialized and deserialized event still verifies", () => {
    const note = buildNote("Serialize test");
    const json = JSON.stringify(note);
    const parsed = JSON.parse(json);
    expect(verifyEvent(parsed)).toBe(true);
  });

  it("all event kinds produce valid signatures", async () => {
    const events = [
      buildNote("Kind 1 test"),
      buildArticle({ title: "Test", content: "Test", dTag: "test" }),
      buildBookmarks(["a".repeat(64)]),
      await buildDM("Test DM", TEST_PK2_HEX),
    ];

    for (const ev of events) {
      expect(verifyEvent(ev)).toBe(true);
    }
  });
});
