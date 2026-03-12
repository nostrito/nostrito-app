
/** Shared relay definitions used by wizard and settings. */

export interface RelayOption {
  id: string;
  name: string;
  description: string;
  defaultOn: boolean;
}

export const RELAYS: RelayOption[] = [
  { id: "primal", name: "primal", description: "Fast global relay", defaultOn: true },
  { id: "damus", name: "damus", description: "iOS community hub", defaultOn: true },
  { id: "nos", name: "nos", description: "Curated social relay", defaultOn: false },
  { id: "snort", name: "snort", description: "Web client relay", defaultOn: false },
  { id: "coracle", name: "coracle", description: "Discovery-focused", defaultOn: false },
  { id: "nostr.wine", name: "nostr.wine", description: "Premium paid relay", defaultOn: true },
  { id: "amethyst", name: "amethyst", description: "Android community", defaultOn: false },
  { id: "yakihonne", name: "yakihonne", description: "Long-form content", defaultOn: true },
];

/** Maps relay alias → full wss:// URL. Mirrors resolve_relay_url() in engine.rs. */
export const RELAY_URL_MAP: Record<string, string> = {
  primal: "wss://relay.primal.net",
  damus: "wss://relay.damus.io",
  nos: "wss://relay.nos.social",
  snort: "wss://relay.snort.social",
  coracle: "wss://relay.coracle.social",
  "nostr.wine": "wss://nostr.wine",
  amethyst: "wss://nostr.band",
  yakihonne: "wss://relay.yakihonne.com",
};

/** Reverse map: wss:// URL → alias. */
const URL_TO_ALIAS: Record<string, string> = Object.fromEntries(
  Object.entries(RELAY_URL_MAP).map(([alias, url]) => [url, alias])
);

/** Convert alias to wss:// URL. Returns the alias itself if unknown. */
export function resolveRelayUrl(alias: string): string {
  return RELAY_URL_MAP[alias] ?? alias;
}

/** Convert wss:// URL back to alias. Returns null if no match. */
export function urlToAlias(url: string): string | null {
  return URL_TO_ALIAS[url] ?? null;
}
