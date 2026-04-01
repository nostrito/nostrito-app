/**
 * Test setup: mock nsec, relay helpers, event builders.
 *
 * Uses nostr-tools to create/sign/verify events and talk to real relays.
 * The test keypair is generated fresh each run — events are ephemeral.
 */

import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from "nostr-tools/pure";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import { nip04 } from "nostr-tools";
import WebSocket from "ws";

// ── Test Keypair ─────────────────────────────────────────────────

const sk = generateSecretKey();

export const TEST_SK = sk;
export const TEST_SK_HEX = bytesToHex(sk);
export const TEST_PK_HEX = getPublicKey(sk);

// Second keypair for DMs and follow tests
const sk2 = generateSecretKey();
export const TEST_SK2 = sk2;
export const TEST_SK2_HEX = bytesToHex(sk2);
export const TEST_PK2_HEX = getPublicKey(sk2);

// ── Relay Config ─────────────────────────────────────────────────

export const TEST_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.primal.net",
  "wss://nos.lol",
];

// Use a single fast relay for write tests to avoid broadcast delays
export const WRITE_RELAY = "wss://nos.lol";

// ── Event Builders ───────────────────────────────────────────────

export type UnsignedEvent = {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
};

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

/** Build and sign a kind:1 text note */
export function buildNote(content: string, tags: string[][] = []): ReturnType<typeof finalizeEvent> {
  return finalizeEvent({
    kind: 1,
    created_at: now(),
    tags,
    content,
  }, sk);
}

/** Build and sign a kind:0 metadata event */
export function buildMetadata(profile: {
  name?: string;
  display_name?: string;
  about?: string;
  picture?: string;
  nip05?: string;
  banner?: string;
  website?: string;
  lud16?: string;
}): ReturnType<typeof finalizeEvent> {
  return finalizeEvent({
    kind: 0,
    created_at: now(),
    tags: [],
    content: JSON.stringify(profile),
  }, sk);
}

/** Build and sign a kind:3 contact list */
export function buildContactList(pubkeys: string[]): ReturnType<typeof finalizeEvent> {
  const tags = pubkeys.map((pk) => ["p", pk]);
  return finalizeEvent({
    kind: 3,
    created_at: now(),
    tags,
    content: "",
  }, sk);
}

/** Build and sign a kind:7 reaction */
export function buildReaction(eventId: string, eventPubkey: string, content = "+"): ReturnType<typeof finalizeEvent> {
  return finalizeEvent({
    kind: 7,
    created_at: now(),
    tags: [["e", eventId], ["p", eventPubkey]],
    content,
  }, sk);
}

/** Build and sign a kind:6 repost */
export function buildRepost(eventId: string, eventPubkey: string, eventJson: string): ReturnType<typeof finalizeEvent> {
  return finalizeEvent({
    kind: 6,
    created_at: now(),
    tags: [["e", eventId], ["p", eventPubkey]],
    content: eventJson,
  }, sk);
}

/** Build and sign a kind:5 deletion */
export function buildDeletion(eventIds: string[]): ReturnType<typeof finalizeEvent> {
  const tags = eventIds.map((id) => ["e", id]);
  return finalizeEvent({
    kind: 5,
    created_at: now(),
    tags,
    content: "",
  }, sk);
}

/** Build and sign a kind:1 reply */
export function buildReply(
  content: string,
  replyToId: string,
  replyToPubkey: string,
  rootId?: string,
): ReturnType<typeof finalizeEvent> {
  const tags: string[][] = [];
  if (rootId) {
    tags.push(["e", rootId, "", "root"]);
    tags.push(["e", replyToId, "", "reply"]);
  } else {
    tags.push(["e", replyToId, "", "root"]);
  }
  tags.push(["p", replyToPubkey]);
  return finalizeEvent({
    kind: 1,
    created_at: now(),
    tags,
    content,
  }, sk);
}

/** Build and sign a kind:30023 long-form article */
export function buildArticle(opts: {
  title: string;
  content: string;
  dTag: string;
  summary?: string;
  image?: string;
  hashtags?: string[];
}): ReturnType<typeof finalizeEvent> {
  const tags: string[][] = [
    ["d", opts.dTag],
    ["title", opts.title],
    ["published_at", now().toString()],
  ];
  if (opts.summary) tags.push(["summary", opts.summary]);
  if (opts.image) tags.push(["image", opts.image]);
  if (opts.hashtags) {
    for (const t of opts.hashtags) tags.push(["t", t]);
  }
  return finalizeEvent({
    kind: 30023,
    created_at: now(),
    tags,
    content: opts.content,
  }, sk);
}

/** Build and sign a NIP-04 encrypted DM (kind:4) */
export async function buildDM(
  content: string,
  recipientPubkey: string,
  senderSk: Uint8Array = sk,
): Promise<ReturnType<typeof finalizeEvent>> {
  const encrypted = await nip04.encrypt(bytesToHex(senderSk), recipientPubkey, content);
  return finalizeEvent({
    kind: 4,
    created_at: now(),
    tags: [["p", recipientPubkey]],
    content: encrypted,
  }, senderSk);
}

/** Build and sign a kind:10003 bookmark list */
export function buildBookmarks(eventIds: string[]): ReturnType<typeof finalizeEvent> {
  const tags = eventIds.map((id) => ["e", id]);
  return finalizeEvent({
    kind: 10003,
    created_at: now(),
    tags,
    content: "",
  }, sk);
}

/** Build and sign a kind:10000 mute list */
export function buildMuteList(pubkeys: string[], words: string[] = []): ReturnType<typeof finalizeEvent> {
  const tags: string[][] = [
    ...pubkeys.map((pk) => ["p", pk] as string[]),
    ...words.map((w) => ["word", w] as string[]),
  ];
  return finalizeEvent({
    kind: 10000,
    created_at: now(),
    tags,
    content: "",
  }, sk);
}

// ── Relay WebSocket Helpers ──────────────────────────────────────

export interface RelayMessage {
  type: "EVENT" | "EOSE" | "OK" | "NOTICE" | "CLOSED" | "AUTH";
  subscriptionId?: string;
  event?: Record<string, unknown>;
  eventId?: string;
  accepted?: boolean;
  message?: string;
}

function parseRelayMessage(data: string): RelayMessage {
  const parsed = JSON.parse(data);
  if (parsed[0] === "EVENT") {
    return { type: "EVENT", subscriptionId: parsed[1], event: parsed[2] };
  } else if (parsed[0] === "EOSE") {
    return { type: "EOSE", subscriptionId: parsed[1] };
  } else if (parsed[0] === "OK") {
    return { type: "OK", eventId: parsed[1], accepted: parsed[2], message: parsed[3] };
  } else if (parsed[0] === "NOTICE") {
    return { type: "NOTICE", message: parsed[1] };
  } else if (parsed[0] === "CLOSED") {
    return { type: "CLOSED", subscriptionId: parsed[1], message: parsed[2] };
  } else if (parsed[0] === "AUTH") {
    return { type: "AUTH", message: parsed[1] };
  }
  return { type: "NOTICE", message: `Unknown: ${data}` };
}

/** Open a WebSocket connection to a relay. Resolves when OPEN. */
export function connectRelay(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Connection to ${url} timed out`));
    }, 10_000);
    ws.on("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Try to connect to any of the given relays, return the first that succeeds. */
export async function connectAnyRelay(urls: string[] = TEST_RELAYS): Promise<WebSocket> {
  for (const url of urls) {
    try {
      return await connectRelay(url);
    } catch {
      continue;
    }
  }
  throw new Error("All relays failed to connect");
}

/** Ensure a WebSocket is open; reconnect if closed. */
export async function ensureConnected(ws: WebSocket | null, url: string): Promise<WebSocket> {
  if (ws && ws.readyState === WebSocket.OPEN) return ws;
  return connectRelay(url);
}

/** Publish an event to a relay and wait for the OK response. */
export function publishEvent(
  ws: WebSocket,
  event: ReturnType<typeof finalizeEvent>,
): Promise<{ accepted: boolean; message?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Publish timed out")), 15_000);

    const handler = (data: WebSocket.Data) => {
      const msg = parseRelayMessage(data.toString());
      if (msg.type === "OK" && msg.eventId === event.id) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve({ accepted: msg.accepted ?? false, message: msg.message });
      }
    };

    ws.on("message", handler);
    ws.send(JSON.stringify(["EVENT", event]));
  });
}

/** Subscribe to events matching a filter and collect results until EOSE. */
export function subscribeAndCollect(
  ws: WebSocket,
  subId: string,
  filters: Record<string, unknown>[],
  timeoutMs = 10_000,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const events: Record<string, unknown>[] = [];
    const timer = setTimeout(() => {
      ws.off("message", handler);
      // Close the subscription
      ws.send(JSON.stringify(["CLOSE", subId]));
      resolve(events); // resolve with what we have
    }, timeoutMs);

    const handler = (data: WebSocket.Data) => {
      const msg = parseRelayMessage(data.toString());
      if (msg.subscriptionId !== subId) return;

      if (msg.type === "EVENT" && msg.event) {
        events.push(msg.event);
      } else if (msg.type === "EOSE") {
        clearTimeout(timer);
        ws.off("message", handler);
        ws.send(JSON.stringify(["CLOSE", subId]));
        resolve(events);
      }
    };

    ws.on("message", handler);
    ws.send(JSON.stringify(["REQ", subId, ...filters]));
  });
}

/** Fetch NIP-11 relay info document. */
export async function fetchNip11(relayUrl: string): Promise<Record<string, unknown>> {
  const httpUrl = relayUrl.replace("wss://", "https://").replace("ws://", "http://");
  const resp = await fetch(httpUrl, {
    headers: { Accept: "application/nostr+json" },
  });
  if (!resp.ok) throw new Error(`NIP-11 fetch failed: ${resp.status}`);
  return resp.json();
}

/** Generate a random subscription ID */
export function randomSubId(): string {
  return "test-" + Math.random().toString(36).slice(2, 10);
}

/** Utility: wait ms */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Re-export verification
export { verifyEvent, finalizeEvent, getPublicKey, generateSecretKey, nip04 };
export { bytesToHex, hexToBytes };
