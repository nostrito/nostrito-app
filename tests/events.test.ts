/**
 * Event lifecycle tests — publish events to real relays and fetch them back.
 * Tests signing, verification, threads, and deletions.
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
  buildReply,
  buildDeletion,
  verifyEvent,
  sleep,
} from "./setup";
import { getEventHash } from "nostr-tools/pure";
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

// ── Event Signing & Verification ─────────────────────────────────

describe("Event signing and verification", () => {
  it("creates a valid signed kind:1 event", () => {
    const note = buildNote("Test note from vitest");
    expect(note.kind).toBe(1);
    expect(note.pubkey).toBe(TEST_PK_HEX);
    expect(note.content).toBe("Test note from vitest");
    expect(note.id).toBeTruthy();
    expect(note.sig).toBeTruthy();
    expect(note.created_at).toBeGreaterThan(0);
  });

  it("verifies event signature", () => {
    const note = buildNote("Signature test");
    const isValid = verifyEvent(note);
    expect(isValid).toBe(true);
  });

  it("detects tampered event via id recomputation", () => {
    const note = buildNote("Tamper test");
    // Tamper the content — the id no longer matches the hash of the serialized event
    const tampered = { ...note, content: "tampered content" };
    const expectedHash = getEventHash(tampered);
    expect(expectedHash).not.toBe(tampered.id);
  });

  it("different content produces different event ids", () => {
    const note1 = buildNote("Content A");
    const note2 = buildNote("Content B");
    expect(note1.id).not.toBe(note2.id);
  });
});

// ── Publishing Notes ─────────────────────────────────────────────

describe("Publishing kind:1 notes", () => {
  it("publishes a text note and gets OK", async () => {
    const note = buildNote(`Integration test ${Date.now()}`);
    const result = await publishEvent(ws, note);
    expect(result.accepted).toBe(true);
  });

  it("fetches back a published note by author", async () => {
    const content = `Fetch-back test ${Date.now()}`;
    const note = buildNote(content);
    await publishEvent(ws, note);

    // Give relay a moment to index
    await sleep(500);

    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { kinds: [1], authors: [TEST_PK_HEX], limit: 10 },
    ]);

    const found = events.find((e) => e.id === note.id);
    expect(found).toBeDefined();
    expect(found!.content).toBe(content);
    expect(found!.pubkey).toBe(TEST_PK_HEX);
  });

  it("fetches back a published note by ID", async () => {
    const note = buildNote(`ID fetch test ${Date.now()}`);
    await publishEvent(ws, note);
    await sleep(500);

    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { ids: [note.id] },
    ]);

    expect(events.length).toBe(1);
    expect(events[0].id).toBe(note.id);
  });

  it("publishes note with hashtag and fetches by tag", async () => {
    const tag = `testnostrito${Date.now()}`;
    const note = buildNote(`Hashtag test #${tag}`, [["t", tag]]);
    await publishEvent(ws, note);
    await sleep(500);

    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { "#t": [tag], kinds: [1], limit: 5 },
    ]);

    const found = events.find((e) => e.id === note.id);
    expect(found).toBeDefined();
  });

  it("verifies fetched event has valid signature", async () => {
    const note = buildNote(`Sig verify test ${Date.now()}`);
    await publishEvent(ws, note);
    await sleep(500);

    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { ids: [note.id] },
    ]);

    expect(events.length).toBe(1);
    // Verify the event returned from relay still has valid sig
    const isValid = verifyEvent(events[0] as Parameters<typeof verifyEvent>[0]);
    expect(isValid).toBe(true);
  });
});

// ── Threads / Replies ────────────────────────────────────────────

describe("Threads and replies", () => {
  it("publishes a reply with correct NIP-10 threading tags", async () => {
    // Publish root note
    const root = buildNote(`Root note ${Date.now()}`);
    await publishEvent(ws, root);

    // Publish reply
    const reply = buildReply(
      `Reply to root ${Date.now()}`,
      root.id,
      root.pubkey,
    );
    const result = await publishEvent(ws, reply);
    expect(result.accepted).toBe(true);

    // Verify reply tags
    const rootTag = reply.tags.find(
      (t) => t[0] === "e" && t[3] === "root",
    );
    expect(rootTag).toBeDefined();
    expect(rootTag![1]).toBe(root.id);

    const pTag = reply.tags.find((t) => t[0] === "p");
    expect(pTag).toBeDefined();
    expect(pTag![1]).toBe(root.pubkey);
  });

  it("publishes a nested reply with root and reply markers", async () => {
    const root = buildNote(`Thread root ${Date.now()}`);
    await publishEvent(ws, root);

    const reply1 = buildReply("First reply", root.id, root.pubkey);
    await publishEvent(ws, reply1);

    // Reply to the reply, with root context
    const reply2 = buildReply(
      "Nested reply",
      reply1.id,
      reply1.pubkey,
      root.id,
    );
    const result = await publishEvent(ws, reply2);
    expect(result.accepted).toBe(true);

    // Check NIP-10 markers
    const rootTag = reply2.tags.find((t) => t[0] === "e" && t[3] === "root");
    const replyTag = reply2.tags.find((t) => t[0] === "e" && t[3] === "reply");
    expect(rootTag![1]).toBe(root.id);
    expect(replyTag![1]).toBe(reply1.id);
  });

  it("fetches replies to a note using e-tag filter", async () => {
    const root = buildNote(`Fetch replies root ${Date.now()}`);
    await publishEvent(ws, root);

    const reply = buildReply(
      `Fetch replies reply ${Date.now()}`,
      root.id,
      root.pubkey,
    );
    await publishEvent(ws, reply);
    await sleep(500);

    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { kinds: [1], "#e": [root.id], limit: 10 },
    ]);

    const found = events.find((e) => e.id === reply.id);
    expect(found).toBeDefined();
  });
});

// ── Event Deletion (NIP-09) ──────────────────────────────────────

describe("Event deletion (NIP-09)", () => {
  it("publishes a kind:5 deletion event", async () => {
    const note = buildNote(`Delete me ${Date.now()}`);
    await publishEvent(ws, note);

    const deletion = buildDeletion([note.id]);
    const result = await publishEvent(ws, deletion);
    expect(result.accepted).toBe(true);

    // Verify deletion event shape
    expect(deletion.kind).toBe(5);
    expect(deletion.tags.some((t) => t[0] === "e" && t[1] === note.id)).toBe(true);
  });

  it("deletion event references the correct target", async () => {
    const note1 = buildNote("First target");
    const note2 = buildNote("Second target");
    await publishEvent(ws, note1);
    await publishEvent(ws, note2);

    const deletion = buildDeletion([note1.id, note2.id]);
    expect(deletion.tags.length).toBe(2);
    expect(deletion.tags[0][1]).toBe(note1.id);
    expect(deletion.tags[1][1]).toBe(note2.id);
  });
});

// ── Event Filtering ──────────────────────────────────────────────

describe("Event filtering", () => {
  it("filters by since timestamp", async () => {
    const beforeTs = Math.floor(Date.now() / 1000) - 2;
    const note = buildNote(`Since filter test ${Date.now()}`);
    await publishEvent(ws, note);
    await sleep(500);

    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { kinds: [1], authors: [TEST_PK_HEX], since: beforeTs, limit: 10 },
    ]);

    // All returned events should be at or after our since timestamp
    for (const ev of events) {
      expect((ev.created_at as number)).toBeGreaterThanOrEqual(beforeTs);
    }
  });

  it("filters by until timestamp", async () => {
    const untilTs = Math.floor(Date.now() / 1000) + 1;

    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { kinds: [1], until: untilTs, limit: 5 },
    ]);

    for (const ev of events) {
      expect((ev.created_at as number)).toBeLessThanOrEqual(untilTs);
    }
  });

  it("filters by multiple kinds", async () => {
    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { kinds: [1, 6], limit: 10 },
    ]);

    for (const ev of events) {
      expect([1, 6]).toContain(ev.kind);
    }
  });
});
