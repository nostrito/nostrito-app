/**
 * Interaction tests — reactions (kind:7), reposts (kind:6), and zap receipts.
 * Publishes to real relays and verifies the interaction references.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import {
  TEST_SK,
  TEST_PK_HEX,
  WRITE_RELAY,
  connectRelay,
  ensureConnected,
  publishEvent,
  subscribeAndCollect,
  randomSubId,
  buildNote,
  buildReaction,
  buildRepost,
  verifyEvent,
  sleep,
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

// ── Kind:7 Reactions ─────────────────────────────────────────────

describe("Kind:7 reactions", () => {
  it("creates a valid reaction event", () => {
    const targetId = "a".repeat(64);
    const targetPk = "b".repeat(64);
    const reaction = buildReaction(targetId, targetPk);
    expect(reaction.kind).toBe(7);
    expect(reaction.content).toBe("+");
    expect(reaction.tags).toEqual([
      ["e", targetId],
      ["p", targetPk],
    ]);
  });

  it("supports custom emoji reactions", () => {
    const reaction = buildReaction("a".repeat(64), "b".repeat(64), "🤙");
    expect(reaction.content).toBe("🤙");
  });

  it("publishes a reaction to a real note", async () => {
    // Publish a note first
    const note = buildNote(`React to me ${Date.now()}`);
    await publishEvent(ws, note);

    // Publish reaction
    const reaction = buildReaction(note.id, note.pubkey);
    const result = await publishEvent(ws, reaction);
    expect(result.accepted).toBe(true);
  });

  it("fetches reactions for a note via e-tag filter", async () => {
    const note = buildNote(`Fetch reactions ${Date.now()}`);
    await publishEvent(ws, note);

    const reaction = buildReaction(note.id, note.pubkey);
    await publishEvent(ws, reaction);
    await sleep(500);

    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { kinds: [7], "#e": [note.id], limit: 10 },
    ]);

    const found = events.find((e) => e.id === reaction.id);
    expect(found).toBeDefined();
    expect(found!.kind).toBe(7);
    expect(found!.content).toBe("+");
  });

  it("reaction correctly references target event and pubkey", async () => {
    const note = buildNote(`Ref check ${Date.now()}`);
    await publishEvent(ws, note);

    const reaction = buildReaction(note.id, note.pubkey);
    await publishEvent(ws, reaction);
    await sleep(500);

    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { ids: [reaction.id] },
    ]);

    expect(events.length).toBe(1);
    const tags = events[0].tags as string[][];
    const eTag = tags.find((t) => t[0] === "e");
    const pTag = tags.find((t) => t[0] === "p");
    expect(eTag![1]).toBe(note.id);
    expect(pTag![1]).toBe(note.pubkey);
  });

  it("can count reactions by querying kind:7 with e-tag", async () => {
    const note = buildNote(`Count reactions ${Date.now()}`);
    await publishEvent(ws, note);

    // Publish multiple reactions (same author — this is a test, not a real use case)
    const r1 = buildReaction(note.id, note.pubkey, "+");
    const r2 = buildReaction(note.id, note.pubkey, "🤙");
    await publishEvent(ws, r1);
    await publishEvent(ws, r2);
    await sleep(500);

    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { kinds: [7], "#e": [note.id], limit: 50 },
    ]);

    expect(events.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Kind:6 Reposts ───────────────────────────────────────────────

describe("Kind:6 reposts", () => {
  it("creates a valid repost event", () => {
    const targetId = "a".repeat(64);
    const targetPk = "b".repeat(64);
    const eventJson = JSON.stringify({ id: targetId, pubkey: targetPk, kind: 1, content: "hello" });
    const repost = buildRepost(targetId, targetPk, eventJson);
    expect(repost.kind).toBe(6);
    expect(repost.content).toBe(eventJson);
    expect(repost.tags).toEqual([
      ["e", targetId],
      ["p", targetPk],
    ]);
  });

  it("publishes a repost to relay", async () => {
    const note = buildNote(`Repost me ${Date.now()}`);
    await publishEvent(ws, note);

    const repost = buildRepost(note.id, note.pubkey, JSON.stringify(note));
    const result = await publishEvent(ws, repost);
    expect(result.accepted).toBe(true);
  });

  it("fetches reposts for a note via e-tag filter", async () => {
    const note = buildNote(`Fetch reposts ${Date.now()}`);
    await publishEvent(ws, note);

    const repost = buildRepost(note.id, note.pubkey, JSON.stringify(note));
    await publishEvent(ws, repost);
    await sleep(500);

    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { kinds: [6], "#e": [note.id], limit: 10 },
    ]);

    const found = events.find((e) => e.id === repost.id);
    expect(found).toBeDefined();
    expect(found!.kind).toBe(6);
  });

  it("repost content contains the original event JSON", async () => {
    const note = buildNote(`Repost content check ${Date.now()}`);
    await publishEvent(ws, note);

    const repost = buildRepost(note.id, note.pubkey, JSON.stringify(note));
    await publishEvent(ws, repost);
    await sleep(500);

    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { ids: [repost.id] },
    ]);

    expect(events.length).toBe(1);
    const embeddedEvent = JSON.parse(events[0].content as string);
    expect(embeddedEvent.id).toBe(note.id);
  });
});

// ── Mixed Interaction Queries ────────────────────────────────────

describe("Mixed interaction queries", () => {
  it("fetches both reactions and reposts for a note", async () => {
    const note = buildNote(`Mixed interactions ${Date.now()}`);
    await publishEvent(ws, note);

    const reaction = buildReaction(note.id, note.pubkey);
    const repost = buildRepost(note.id, note.pubkey, JSON.stringify(note));
    await Promise.all([
      publishEvent(ws, reaction),
      publishEvent(ws, repost),
    ]);
    await sleep(500);

    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { kinds: [7, 6], "#e": [note.id], limit: 10 },
    ]);

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain(7);
    expect(kinds).toContain(6);
  });

  it("queries own interactions (reactions by author)", async () => {
    const note = buildNote(`Own interactions ${Date.now()}`);
    await publishEvent(ws, note);

    const reaction = buildReaction(note.id, note.pubkey);
    await publishEvent(ws, reaction);
    await sleep(500);

    // Query for our own kind:7 events
    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { kinds: [7], authors: [TEST_PK_HEX], limit: 10 },
    ]);

    expect(events.length).toBeGreaterThan(0);
    for (const ev of events) {
      expect(ev.pubkey).toBe(TEST_PK_HEX);
      expect(ev.kind).toBe(7);
    }
  });
});
