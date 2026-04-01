/**
 * NIP-57 zap receipt tests — kind:9735 zap structure, tags, and verification.
 * Also tests NIP-25 reaction variants (emoji, custom, dislike).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import {
  TEST_SK,
  TEST_SK_HEX,
  TEST_PK_HEX,
  TEST_SK2,
  TEST_PK2_HEX,
  WRITE_RELAY,
  connectRelay,
  ensureConnected,
  publishEvent,
  subscribeAndCollect,
  randomSubId,
  buildNote,
  buildReaction,
  verifyEvent,
  finalizeEvent,
  now,
  sleep,
  bytesToHex,
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

// ── NIP-57 Zap Receipt Structure ─────────────────────────────────

describe("NIP-57 zap receipt (kind:9735) structure", () => {
  it("creates a valid kind:9735 zap receipt event", () => {
    // A zap receipt is created by a Lightning service, but we test the structure
    const zapReceipt = finalizeEvent({
      kind: 9735,
      created_at: now(),
      tags: [
        ["p", TEST_PK2_HEX],
        ["e", "a".repeat(64)],
        ["bolt11", "lnbc100n1..."],
        ["description", JSON.stringify({
          kind: 9734,
          content: "Zap!",
          tags: [["p", TEST_PK2_HEX], ["e", "a".repeat(64)], ["amount", "100000"]],
        })],
      ],
      content: "",
    }, TEST_SK);

    expect(zapReceipt.kind).toBe(9735);
    expect(verifyEvent(zapReceipt)).toBe(true);
  });

  it("zap receipt must reference the zapped event via e-tag", () => {
    const eventId = "b".repeat(64);
    const zapReceipt = finalizeEvent({
      kind: 9735,
      created_at: now(),
      tags: [
        ["p", TEST_PK2_HEX],
        ["e", eventId],
        ["bolt11", "lnbc200n1..."],
      ],
      content: "",
    }, TEST_SK);

    const eTag = zapReceipt.tags.find((t) => t[0] === "e");
    expect(eTag).toBeDefined();
    expect(eTag![1]).toBe(eventId);
  });

  it("zap receipt must reference the recipient via p-tag", () => {
    const zapReceipt = finalizeEvent({
      kind: 9735,
      created_at: now(),
      tags: [
        ["p", TEST_PK2_HEX],
        ["e", "c".repeat(64)],
        ["bolt11", "lnbc300n1..."],
      ],
      content: "",
    }, TEST_SK);

    const pTag = zapReceipt.tags.find((t) => t[0] === "p");
    expect(pTag).toBeDefined();
    expect(pTag![1]).toBe(TEST_PK2_HEX);
  });

  it("zap receipt includes bolt11 invoice tag", () => {
    const invoice = "lnbc500n1pj9...test";
    const zapReceipt = finalizeEvent({
      kind: 9735,
      created_at: now(),
      tags: [
        ["p", TEST_PK2_HEX],
        ["e", "d".repeat(64)],
        ["bolt11", invoice],
      ],
      content: "",
    }, TEST_SK);

    const bolt11Tag = zapReceipt.tags.find((t) => t[0] === "bolt11");
    expect(bolt11Tag).toBeDefined();
    expect(bolt11Tag![1]).toBe(invoice);
  });

  it("zap receipt includes description with original zap request", () => {
    const zapRequest = {
      kind: 9734,
      content: "Great post!",
      tags: [["p", TEST_PK2_HEX], ["e", "e".repeat(64)], ["amount", "1000000"]],
      pubkey: TEST_PK_HEX,
      created_at: now(),
    };

    const zapReceipt = finalizeEvent({
      kind: 9735,
      created_at: now(),
      tags: [
        ["p", TEST_PK2_HEX],
        ["e", "e".repeat(64)],
        ["bolt11", "lnbc1000n1..."],
        ["description", JSON.stringify(zapRequest)],
      ],
      content: "",
    }, TEST_SK);

    const descTag = zapReceipt.tags.find((t) => t[0] === "description");
    expect(descTag).toBeDefined();
    const parsed = JSON.parse(descTag![1]);
    expect(parsed.kind).toBe(9734);
    expect(parsed.content).toBe("Great post!");
  });

  it("publishes zap receipt to relay", async () => {
    const note = buildNote(`Zap me ${Date.now()}`);
    await publishEvent(ws, note);

    const zapReceipt = finalizeEvent({
      kind: 9735,
      created_at: now(),
      tags: [
        ["p", note.pubkey],
        ["e", note.id],
        ["bolt11", "lnbc100n1test..."],
      ],
      content: "",
    }, TEST_SK);

    const result = await publishEvent(ws, zapReceipt);
    expect(result.accepted).toBe(true);
  });

  it("fetches zap receipts for a note via e-tag filter", async () => {
    const note = buildNote(`Fetch zaps ${Date.now()}`);
    await publishEvent(ws, note);

    const zap = finalizeEvent({
      kind: 9735,
      created_at: now(),
      tags: [
        ["p", note.pubkey],
        ["e", note.id],
        ["bolt11", "lnbc100n1fetch..."],
      ],
      content: "",
    }, TEST_SK);
    await publishEvent(ws, zap);
    await sleep(500);

    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { kinds: [9735], "#e": [note.id], limit: 10 },
    ]);

    const found = events.find((e) => e.id === zap.id);
    expect(found).toBeDefined();
    expect(found!.kind).toBe(9735);
  });
});

// ── NIP-25 Reaction Variants ─────────────────────────────────────

describe("NIP-25 reaction variants", () => {
  it("standard like reaction uses '+' content", () => {
    const reaction = buildReaction("a".repeat(64), "b".repeat(64), "+");
    expect(reaction.content).toBe("+");
    expect(reaction.kind).toBe(7);
  });

  it("dislike reaction uses '-' content", () => {
    const reaction = buildReaction("a".repeat(64), "b".repeat(64), "-");
    expect(reaction.content).toBe("-");
  });

  it("emoji reaction uses emoji as content", () => {
    const reactions = ["🤙", "❤️", "🔥", "😂", "👀", "🫡"];
    for (const emoji of reactions) {
      const reaction = buildReaction("a".repeat(64), "b".repeat(64), emoji);
      expect(reaction.content).toBe(emoji);
    }
  });

  it("custom emoji reaction with shortcode", () => {
    // NIP-25: custom emoji reactions use :shortcode: content + emoji tag
    const reaction = finalizeEvent({
      kind: 7,
      created_at: now(),
      tags: [
        ["e", "a".repeat(64)],
        ["p", "b".repeat(64)],
        ["emoji", "custom_emoji", "https://example.com/emoji.png"],
      ],
      content: ":custom_emoji:",
    }, TEST_SK);

    expect(reaction.content).toBe(":custom_emoji:");
    const emojiTag = reaction.tags.find((t) => t[0] === "emoji");
    expect(emojiTag).toBeDefined();
    expect(emojiTag![1]).toBe("custom_emoji");
    expect(emojiTag![2]).toBe("https://example.com/emoji.png");
  });

  it("publishes emoji reactions to relay", async () => {
    const note = buildNote(`Emoji react ${Date.now()}`);
    await publishEvent(ws, note);

    const reaction = buildReaction(note.id, note.pubkey, "🔥");
    const result = await publishEvent(ws, reaction);
    expect(result.accepted).toBe(true);
  });

  it("fetches and distinguishes reaction types", async () => {
    const note = buildNote(`Reaction types ${Date.now()}`);
    await publishEvent(ws, note);

    const like = buildReaction(note.id, note.pubkey, "+");
    const fire = buildReaction(note.id, note.pubkey, "🔥");
    await publishEvent(ws, like);
    await publishEvent(ws, fire);
    await sleep(500);

    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { kinds: [7], "#e": [note.id], limit: 10 },
    ]);

    const contents = events.map((e) => e.content);
    expect(contents).toContain("+");
    expect(contents).toContain("🔥");
  });
});
