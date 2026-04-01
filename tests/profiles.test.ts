/**
 * Profile and contacts tests — kind:0 metadata and kind:3 contact lists.
 * Publishes to real relays and verifies fetch-back.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
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
  buildMetadata,
  buildContactList,
  buildMuteList,
  verifyEvent,
  sleep,
  generateSecretKey,
  getPublicKey,
  bytesToHex,
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

// ── Kind:0 Metadata ──────────────────────────────────────────────

describe("Kind:0 profile metadata", () => {
  it("creates a valid metadata event", () => {
    const meta = buildMetadata({
      name: "nostrito-test",
      display_name: "Nostrito Test User",
      about: "Integration test account",
    });
    expect(meta.kind).toBe(0);
    expect(meta.pubkey).toBe(TEST_PK_HEX);

    const parsed = JSON.parse(meta.content);
    expect(parsed.name).toBe("nostrito-test");
    expect(parsed.display_name).toBe("Nostrito Test User");
    expect(parsed.about).toBe("Integration test account");
  });

  it("publishes metadata to relay", async () => {
    const meta = buildMetadata({
      name: `test-${Date.now()}`,
      about: "Published from vitest",
    });
    const result = await publishEvent(ws, meta);
    expect(result.accepted).toBe(true);
  });

  it("fetches back published metadata by author", async () => {
    // Wait so the new event has a strictly newer created_at than previous kind:0
    await sleep(1_500);
    const name = `profile-fetch-${Date.now()}`;
    const meta = buildMetadata({ name, about: "Fetch test" });
    await publishEvent(ws, meta);
    await sleep(1_000);

    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { kinds: [0], authors: [TEST_PK_HEX], limit: 5 },
    ]);

    expect(events.length).toBeGreaterThanOrEqual(1);
    // Most recent kind:0 should be ours
    const latest = events.sort(
      (a, b) => (b.created_at as number) - (a.created_at as number),
    )[0];
    const parsed = JSON.parse(latest.content as string);
    expect(parsed.name).toBe(name);
  });

  it("metadata is a replaceable event (newest wins)", async () => {
    const meta1 = buildMetadata({ name: "first-name" });
    await publishEvent(ws, meta1);
    await sleep(1_500);

    const meta2 = buildMetadata({ name: "second-name" });
    await publishEvent(ws, meta2);
    await sleep(1_000);

    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { kinds: [0], authors: [TEST_PK_HEX], limit: 5 },
    ]);

    // Relay may return only the latest (replaceable event behavior)
    // or both; either way, the newest should have "second-name"
    const newest = events.sort(
      (a, b) => (b.created_at as number) - (a.created_at as number),
    )[0];
    const parsed = JSON.parse(newest.content as string);
    expect(parsed.name).toBe("second-name");
  });

  it("metadata with full profile fields", () => {
    const meta = buildMetadata({
      name: "alice",
      display_name: "Alice Wonderland",
      about: "Down the rabbit hole",
      picture: "https://example.com/alice.jpg",
      nip05: "alice@example.com",
      banner: "https://example.com/banner.jpg",
      website: "https://alice.example.com",
      lud16: "alice@getalby.com",
    });

    const parsed = JSON.parse(meta.content);
    expect(parsed.name).toBe("alice");
    expect(parsed.display_name).toBe("Alice Wonderland");
    expect(parsed.about).toBe("Down the rabbit hole");
    expect(parsed.picture).toBe("https://example.com/alice.jpg");
    expect(parsed.nip05).toBe("alice@example.com");
    expect(parsed.banner).toBe("https://example.com/banner.jpg");
    expect(parsed.website).toBe("https://alice.example.com");
    expect(parsed.lud16).toBe("alice@getalby.com");
  });
});

// ── Kind:3 Contact List ──────────────────────────────────────────

describe("Kind:3 contact list", () => {
  it("creates a contact list with p-tags", () => {
    const fakeFollows = [
      "a".repeat(64),
      "b".repeat(64),
      "c".repeat(64),
    ];
    const cl = buildContactList(fakeFollows);
    expect(cl.kind).toBe(3);
    expect(cl.tags.length).toBe(3);
    for (let i = 0; i < fakeFollows.length; i++) {
      expect(cl.tags[i][0]).toBe("p");
      expect(cl.tags[i][1]).toBe(fakeFollows[i]);
    }
  });

  it("publishes contact list to relay", async () => {
    const cl = buildContactList([TEST_PK2_HEX]);
    const result = await publishEvent(ws, cl);
    expect(result.accepted).toBe(true);
  });

  it("contact list is replaceable (only latest kept)", async () => {
    const cl1 = buildContactList(["a".repeat(64)]);
    await publishEvent(ws, cl1);
    // Wait >1s so the next event gets a strictly newer created_at
    await sleep(1_500);

    const cl2 = buildContactList(["b".repeat(64), "c".repeat(64)]);
    await publishEvent(ws, cl2);
    await sleep(1_000);

    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { kinds: [3], authors: [TEST_PK_HEX], limit: 5 },
    ]);

    // Newest should have 2 follows (b, c), not 1 (a)
    const newest = events.sort(
      (a, b) => (b.created_at as number) - (a.created_at as number),
    )[0];
    const pTags = (newest.tags as string[][]).filter((t) => t[0] === "p");
    expect(pTags.length).toBe(2);
  });

  it("can discover followers by querying p-tag filter", async () => {
    // Publish a contact list with a unique follow target
    await sleep(1_500);
    const targetPk = getPublicKey(generateSecretKey());
    const cl = buildContactList([targetPk]);
    await publishEvent(ws, cl);
    await sleep(1_000);

    // Query: find kind:3 events that mention targetPk in a p-tag
    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { kinds: [3], "#p": [targetPk], limit: 10 },
    ]);

    // Our test account should show up as following targetPk
    const found = events.find((e) => e.pubkey === TEST_PK_HEX);
    expect(found).toBeDefined();
  });

  it("fetches most recent contact list by author", async () => {
    // This test runs last to avoid races — previous tests publish replaceable kind:3 events
    await sleep(1_500);
    const follow = getPublicKey(generateSecretKey());
    const cl = buildContactList([follow, TEST_PK2_HEX]);
    await publishEvent(ws, cl);
    await sleep(1_000);

    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { kinds: [3], authors: [TEST_PK_HEX], limit: 5 },
    ]);

    expect(events.length).toBeGreaterThanOrEqual(1);
    const latest = events.sort(
      (a, b) => (b.created_at as number) - (a.created_at as number),
    )[0];
    const tags = latest.tags as string[][];
    const followedPks = tags.filter((t) => t[0] === "p").map((t) => t[1]);
    expect(followedPks).toContain(follow);
    expect(followedPks).toContain(TEST_PK2_HEX);
  });
});

// ── Kind:10000 Mute List ─────────────────────────────────────────

describe("Kind:10000 mute list", () => {
  it("creates a mute list with pubkeys and words", () => {
    const muted = buildMuteList(
      ["a".repeat(64), "b".repeat(64)],
      ["spam", "scam"],
    );
    expect(muted.kind).toBe(10000);
    const pTags = muted.tags.filter((t) => t[0] === "p");
    const wordTags = muted.tags.filter((t) => t[0] === "word");
    expect(pTags.length).toBe(2);
    expect(wordTags.length).toBe(2);
    expect(wordTags[0][1]).toBe("spam");
  });

  it("publishes mute list to relay", async () => {
    const muted = buildMuteList([TEST_PK2_HEX], ["testword"]);
    const result = await publishEvent(ws, muted);
    expect(result.accepted).toBe(true);
  });

  it("mute list is replaceable", async () => {
    const m1 = buildMuteList(["a".repeat(64)]);
    await publishEvent(ws, m1);
    await sleep(1_500);

    const m2 = buildMuteList(["b".repeat(64), "c".repeat(64)]);
    await publishEvent(ws, m2);
    await sleep(1_000);

    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { kinds: [10000], authors: [TEST_PK_HEX], limit: 5 },
    ]);

    const newest = events.sort(
      (a, b) => (b.created_at as number) - (a.created_at as number),
    )[0];
    const pTags = (newest.tags as string[][]).filter((t) => t[0] === "p");
    expect(pTags.length).toBe(2);
  });
});
