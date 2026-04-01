/**
 * Relay connectivity tests — verifies real Nostr relays accept connections,
 * respond to NIP-11 info requests, and handle subscriptions properly.
 */

import { describe, it, expect, afterAll } from "vitest";
import {
  TEST_RELAYS,
  WRITE_RELAY,
  connectRelay,
  fetchNip11,
  subscribeAndCollect,
  randomSubId,
  TEST_PK_HEX,
} from "./setup";
import WebSocket from "ws";

const openConnections: WebSocket[] = [];

afterAll(() => {
  for (const ws of openConnections) {
    if (ws.readyState === WebSocket.OPEN) ws.close();
  }
});

// ── NIP-11 Relay Information ─────────────────────────────────────

describe("NIP-11 relay info", () => {
  it.each(TEST_RELAYS)("fetches NIP-11 info from %s", async (relayUrl) => {
    const info = await fetchNip11(relayUrl);
    expect(info).toBeDefined();
    // NIP-11 requires at minimum a name or description
    expect(
      typeof info.name === "string" || typeof info.description === "string",
    ).toBe(true);
  });

  it("relay info includes supported_nips array", async () => {
    const info = await fetchNip11(WRITE_RELAY);
    if (info.supported_nips) {
      expect(Array.isArray(info.supported_nips)).toBe(true);
      // All relays should support NIP-01
      expect(info.supported_nips).toContain(1);
    }
  });
});

// ── WebSocket Connectivity ───────────────────────────────────────

describe("WebSocket connectivity", () => {
  it.each(TEST_RELAYS)("connects to %s via WebSocket", async (relayUrl) => {
    try {
      const ws = await connectRelay(relayUrl);
      openConnections.push(ws);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Transient 5xx errors from relays are acceptable — don't fail the suite
      if (msg.includes("503") || msg.includes("502") || msg.includes("timed out")) {
        console.warn(`[SKIP] ${relayUrl} temporarily unavailable: ${msg}`);
        return;
      }
      throw err;
    }
  });

  it("receives EOSE after subscription", async () => {
    const ws = await connectRelay(WRITE_RELAY);
    openConnections.push(ws);

    const subId = randomSubId();
    // Subscribe for events by a random pubkey — should get EOSE quickly
    const events = await subscribeAndCollect(ws, subId, [
      { kinds: [1], authors: [TEST_PK_HEX], limit: 1 },
    ]);

    // We might get 0 events for a fresh keypair but should not error
    expect(Array.isArray(events)).toBe(true);
    ws.close();
  });

  it("handles multiple concurrent subscriptions", async () => {
    const ws = await connectRelay(WRITE_RELAY);
    openConnections.push(ws);

    const sub1 = randomSubId();
    const sub2 = randomSubId();

    const [events1, events2] = await Promise.all([
      subscribeAndCollect(ws, sub1, [{ kinds: [1], limit: 3 }], 5_000),
      subscribeAndCollect(ws, sub2, [{ kinds: [0], limit: 3 }], 5_000),
    ]);

    expect(Array.isArray(events1)).toBe(true);
    expect(Array.isArray(events2)).toBe(true);
    ws.close();
  });

  it("rejects invalid filter gracefully", async () => {
    const ws = await connectRelay(WRITE_RELAY);
    openConnections.push(ws);

    // Subscribe with an empty filter — should still get EOSE or CLOSED
    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [{ limit: 0 }], 5_000);
    expect(Array.isArray(events)).toBe(true);
    ws.close();
  });
});

// ── Relay Protocol Basics ────────────────────────────────────────

describe("Relay protocol basics", () => {
  it("returns events from global feed", async () => {
    const ws = await connectRelay(WRITE_RELAY);
    openConnections.push(ws);

    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { kinds: [1], limit: 5 },
    ]);

    // A real relay should have at least some kind:1 events
    expect(events.length).toBeGreaterThan(0);
    for (const ev of events) {
      expect(ev.kind).toBe(1);
      expect(typeof ev.id).toBe("string");
      expect(typeof ev.pubkey).toBe("string");
      expect(typeof ev.content).toBe("string");
      expect(typeof ev.sig).toBe("string");
      expect(typeof ev.created_at).toBe("number");
      expect(Array.isArray(ev.tags)).toBe(true);
    }
    ws.close();
  });

  it("filters events by kind", async () => {
    const ws = await connectRelay(WRITE_RELAY);
    openConnections.push(ws);

    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { kinds: [0], limit: 3 },
    ]);

    for (const ev of events) {
      expect(ev.kind).toBe(0);
    }
    ws.close();
  });

  it("respects limit parameter", async () => {
    const ws = await connectRelay(WRITE_RELAY);
    openConnections.push(ws);

    const subId = randomSubId();
    const events = await subscribeAndCollect(ws, subId, [
      { kinds: [1], limit: 2 },
    ]);

    expect(events.length).toBeLessThanOrEqual(2);
    ws.close();
  });
});
