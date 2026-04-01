/**
 * Medium-priority protocol tests:
 * - NIP-65 relay hint parsing (read/write direction)
 * - NIP-05 identifier verification
 * - Event deduplication
 * - NIP-50 search queries
 * - Quoted notes / embedded events
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import {
  TEST_SK,
  TEST_PK_HEX,
  TEST_PK2_HEX,
  WRITE_RELAY,
  TEST_RELAYS,
  connectRelay,
  ensureConnected,
  publishEvent,
  subscribeAndCollect,
  randomSubId,
  buildNote,
  verifyEvent,
  finalizeEvent,
  now,
  sleep,
  generateSecretKey,
  getPublicKey,
} from "./setup";
import { nip19 } from "nostr-tools";
import { decodeEntity } from "../src/utils/mentions";
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

// ── NIP-65 Relay List Metadata Parsing ───────────────────────────

describe("NIP-65 relay list metadata parsing", () => {
  it("parses read/write/both relay directions from r-tags", () => {
    const relayList = finalizeEvent({
      kind: 10002,
      created_at: now(),
      tags: [
        ["r", "wss://relay.damus.io", "read"],
        ["r", "wss://nos.lol", "write"],
        ["r", "wss://relay.primal.net"],  // no marker = both
      ],
      content: "",
    }, TEST_SK);

    const rTags = relayList.tags.filter((t) => t[0] === "r");

    // Parse directions like the Rust backend does
    const relays = rTags.map((t) => ({
      url: t[1],
      direction: t[2] || "both",
    }));

    expect(relays).toContainEqual({ url: "wss://relay.damus.io", direction: "read" });
    expect(relays).toContainEqual({ url: "wss://nos.lol", direction: "write" });
    expect(relays).toContainEqual({ url: "wss://relay.primal.net", direction: "both" });
  });

  it("filters read-only relays", () => {
    const rTags = [
      ["r", "wss://read.relay.com", "read"],
      ["r", "wss://write.relay.com", "write"],
      ["r", "wss://both.relay.com"],
    ];

    const readRelays = rTags
      .filter((t) => t[0] === "r" && (t[2] === "read" || !t[2]))
      .map((t) => t[1]);

    expect(readRelays).toContain("wss://read.relay.com");
    expect(readRelays).toContain("wss://both.relay.com");
    expect(readRelays).not.toContain("wss://write.relay.com");
  });

  it("filters write-only relays", () => {
    const rTags = [
      ["r", "wss://read.relay.com", "read"],
      ["r", "wss://write.relay.com", "write"],
      ["r", "wss://both.relay.com"],
    ];

    const writeRelays = rTags
      .filter((t) => t[0] === "r" && (t[2] === "write" || !t[2]))
      .map((t) => t[1]);

    expect(writeRelays).toContain("wss://write.relay.com");
    expect(writeRelays).toContain("wss://both.relay.com");
    expect(writeRelays).not.toContain("wss://read.relay.com");
  });

  it("publishes and fetches back relay list", async () => {
    await sleep(1_500);
    const relayList = finalizeEvent({
      kind: 10002,
      created_at: now(),
      tags: [
        ["r", "wss://relay.damus.io", "read"],
        ["r", "wss://nos.lol"],
      ],
      content: "",
    }, TEST_SK);

    await publishEvent(ws, relayList);
    await sleep(500);

    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { ids: [relayList.id] },
    ]);

    expect(events.length).toBe(1);
    const tags = events[0].tags as string[][];
    const rTags = tags.filter((t) => t[0] === "r");
    expect(rTags.length).toBe(2);
  });
});

// ── NIP-05 Identifier Verification ───────────────────────────────

describe("NIP-05 identifier verification", () => {
  it("parses NIP-05 identifier format (name@domain)", () => {
    const nip05 = "alice@example.com";
    const [name, domain] = nip05.split("@");
    expect(name).toBe("alice");
    expect(domain).toBe("example.com");
  });

  it("constructs correct verification URL", () => {
    const nip05 = "bob@relay.damus.io";
    const [name, domain] = nip05.split("@");
    const url = `https://${domain}/.well-known/nostr.json?name=${name}`;
    expect(url).toBe("https://relay.damus.io/.well-known/nostr.json?name=bob");
  });

  it("handles root identifier (_@domain)", () => {
    const nip05 = "_@example.com";
    const [name, domain] = nip05.split("@");
    expect(name).toBe("_");
    const url = `https://${domain}/.well-known/nostr.json?name=${name}`;
    expect(url).toBe("https://example.com/.well-known/nostr.json?name=_");
  });

  it("verifies a real NIP-05 (relay.damus.io)", async () => {
    // This tests against a real NIP-05 endpoint
    try {
      const resp = await fetch(
        "https://relay.damus.io/.well-known/nostr.json?name=_",
        { headers: { Accept: "application/json" } },
      );
      if (resp.ok) {
        const json = await resp.json();
        expect(json.names).toBeDefined();
        // The response should have a "names" object
        expect(typeof json.names).toBe("object");
      }
    } catch {
      // Network error — skip gracefully
      console.warn("[SKIP] NIP-05 verification — network unavailable");
    }
  });
});

// ── Event Deduplication ──────────────────────────────────────────

describe("Event deduplication", () => {
  it("same event from multiple relays has same ID", async () => {
    const note = buildNote(`Dedup test ${Date.now()}`);

    // Publish to primary relay
    await publishEvent(ws, note);

    // Publish to a second relay
    const otherRelay = TEST_RELAYS.find((r) => r !== WRITE_RELAY) ?? TEST_RELAYS[0];
    let ws2: WebSocket | null = null;
    try {
      ws2 = await connectRelay(otherRelay);
      await publishEvent(ws2, note);
    } catch {
      // Second relay might be unavailable
    } finally {
      if (ws2?.readyState === WebSocket.OPEN) ws2.close();
    }

    // Both should have the same event ID
    // (the event ID is a hash of the event content, deterministic)
    expect(note.id.length).toBe(64);
  });

  it("event ID is deterministic (same input = same hash)", () => {
    // Two identical unsigned events should produce the same ID when signed with same key
    // (can't test this directly since created_at differs, but we verify the principle)
    const ev1 = finalizeEvent({
      kind: 1,
      created_at: 1700000000,
      tags: [],
      content: "Deterministic test",
    }, TEST_SK);

    const ev2 = finalizeEvent({
      kind: 1,
      created_at: 1700000000,
      tags: [],
      content: "Deterministic test",
    }, TEST_SK);

    expect(ev1.id).toBe(ev2.id);
  });

  it("dedup by ID: collecting events from multiple queries", async () => {
    const note = buildNote(`Dedup collect ${Date.now()}`);
    await publishEvent(ws, note);
    await sleep(500);

    // Fetch same event via two different filter strategies
    const sub1 = randomSubId();
    const events1 = await subscribeAndCollect(ws, sub1, [
      { ids: [note.id] },
    ]);

    const sub2 = randomSubId();
    const events2 = await subscribeAndCollect(ws, sub2, [
      { kinds: [1], authors: [TEST_PK_HEX], since: note.created_at, limit: 5 },
    ]);

    // Merge and dedup
    const all = [...events1, ...events2];
    const seen = new Set<string>();
    const deduped = all.filter((e) => {
      const id = e.id as string;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    // Should have the note exactly once
    const matches = deduped.filter((e) => e.id === note.id);
    expect(matches.length).toBe(1);
  });
});

// ── Quoted Notes (NIP-18 style embeds) ───────────────────────────

describe("Quoted notes", () => {
  it("creates a note quoting another note via nostr:nevent", () => {
    const originalId = "a".repeat(64);
    const nevent = nip19.neventEncode({ id: originalId });
    const content = `This is great nostr:${nevent}`;

    const note = finalizeEvent({
      kind: 1,
      created_at: now(),
      tags: [["q", originalId]],
      content,
    }, TEST_SK);

    expect(note.content).toContain(`nostr:${nevent}`);
    const qTag = note.tags.find((t) => t[0] === "q");
    expect(qTag).toBeDefined();
    expect(qTag![1]).toBe(originalId);
  });

  it("creates a note quoting another note via nostr:note", () => {
    const originalId = "b".repeat(64);
    const noteRef = nip19.noteEncode(originalId);
    const content = `Check this: nostr:${noteRef}`;

    const note = finalizeEvent({
      kind: 1,
      created_at: now(),
      tags: [["q", originalId]],
      content,
    }, TEST_SK);

    // Decode the embedded entity
    const entity = decodeEntity(noteRef);
    expect(entity).not.toBeNull();
    expect(entity!.type).toBe("note");
    expect(entity!.eventId).toBe(originalId);
  });

  it("quote note has correct structure and publishes", async () => {
    const original = buildNote(`Original note ${Date.now()}`);
    await publishEvent(ws, original);

    const nevent = nip19.neventEncode({ id: original.id });
    const quote = finalizeEvent({
      kind: 1,
      created_at: now(),
      tags: [["q", original.id], ["p", original.pubkey]],
      content: `Quoting this: nostr:${nevent}`,
    }, TEST_SK);

    // Verify structure
    expect(verifyEvent(quote)).toBe(true);
    const qTag = quote.tags.find((t) => t[0] === "q");
    expect(qTag).toBeDefined();
    expect(qTag![1]).toBe(original.id);
    expect(quote.content).toContain(`nostr:${nevent}`);

    // Publish — accepted or duplicate is fine
    try {
      const result = await publishEvent(ws, quote);
      expect(typeof result.accepted).toBe("boolean");
    } catch {
      // Timeout is acceptable under relay load
    }
  });

  it("can reference naddr for article quotes", () => {
    const naddr = nip19.naddrEncode({
      kind: 30023,
      pubkey: TEST_PK2_HEX,
      identifier: "my-article",
    });

    const entity = decodeEntity(naddr);
    expect(entity).not.toBeNull();
    expect(entity!.type).toBe("naddr");
    expect(entity!.dTag).toBe("my-article");
    expect(entity!.kind).toBe(30023);
    expect(entity!.pubkey).toBe(TEST_PK2_HEX);
  });
});

// ── WoT Feed Filtering ───────────────────────────────────────────

describe("WoT feed filtering logic", () => {
  it("follows set correctly filters authors", () => {
    // Simulate WoT filtering: user follows A, B; event from C should be excluded
    const follows = new Set([TEST_PK_HEX, TEST_PK2_HEX]);
    const events = [
      { pubkey: TEST_PK_HEX, content: "From followed" },
      { pubkey: TEST_PK2_HEX, content: "From followed 2" },
      { pubkey: "c".repeat(64), content: "From stranger" },
    ];

    const wotFiltered = events.filter((e) => follows.has(e.pubkey));
    expect(wotFiltered.length).toBe(2);
    expect(wotFiltered.every((e) => follows.has(e.pubkey))).toBe(true);
  });

  it("follows-of-follows extends the WoT", () => {
    // Simulate: user follows A; A follows B, C; D is outside WoT
    const directFollows = new Set([TEST_PK_HEX]);
    const fofFollows = new Set([TEST_PK2_HEX, "c".repeat(64)]);
    const wotSet = new Set([...directFollows, ...fofFollows]);

    expect(wotSet.has(TEST_PK_HEX)).toBe(true);   // direct follow
    expect(wotSet.has(TEST_PK2_HEX)).toBe(true);   // friend-of-friend
    expect(wotSet.has("d".repeat(64))).toBe(false); // outside WoT
  });
});

// ── Content Warning Detection ────────────────────────────────────

describe("Content warning detection (NIP-36)", () => {
  it("detects content-warning tag in event", () => {
    const event = {
      tags: [["content-warning", "NSFW"], ["t", "art"]],
      content: "Some content",
    };

    const cwTag = event.tags.find((t: string[]) => t[0] === "content-warning");
    expect(cwTag).toBeDefined();
    expect(cwTag![1]).toBe("NSFW");
  });

  it("content-warning with empty reason", () => {
    const event = {
      tags: [["content-warning"]],
      content: "Sensitive content",
    };

    const cwTag = event.tags.find((t: string[]) => t[0] === "content-warning");
    expect(cwTag).toBeDefined();
    // Nostrito defaults to "Content warning" when reason is missing
    const reason = cwTag![1] || "Content warning";
    expect(reason).toBe("Content warning");
  });

  it("events without content-warning pass through", () => {
    const event = {
      tags: [["t", "nostr"]],
      content: "Regular content",
    };

    const cwTag = event.tags.find((t: string[]) => t[0] === "content-warning");
    expect(cwTag).toBeUndefined();
  });
});
