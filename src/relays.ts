
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
  { id: "nos.lol", name: "nos.lol", description: "Popular free relay", defaultOn: true },
  { id: "snort", name: "snort", description: "Web client relay", defaultOn: false },
  { id: "coracle", name: "coracle", description: "Discovery-focused", defaultOn: false },
  { id: "nostr.wine", name: "nostr.wine", description: "Premium paid relay", defaultOn: true },
  { id: "relay.nostr.band", name: "nostr.band", description: "Search & discovery relay", defaultOn: true },
  { id: "yakihonne", name: "yakihonne", description: "Long-form content", defaultOn: true },
  { id: "nostr.land", name: "nostr.land", description: "Community relay", defaultOn: false },
  { id: "relay.nostr.bg", name: "nostr.bg", description: "European relay", defaultOn: false },
  { id: "relay.noswhere.com", name: "noswhere", description: "Free public relay", defaultOn: false },
  { id: "purplepag.es", name: "purplepag.es", description: "Profile discovery relay", defaultOn: false },
  { id: "wot.utxo.one", name: "wot.utxo.one", description: "WoT-filtered relay", defaultOn: false },
];

/** Maps relay alias → full wss:// URL. Mirrors resolve_relay_url() in engine.rs. */
export const RELAY_URL_MAP: Record<string, string> = {
  primal: "wss://relay.primal.net",
  damus: "wss://relay.damus.io",
  nos: "wss://relay.nos.social",
  "nos.lol": "wss://nos.lol",
  snort: "wss://relay.snort.social",
  coracle: "wss://relay.coracle.social",
  "nostr.wine": "wss://nostr.wine",
  "relay.nostr.band": "wss://relay.nostr.band",
  yakihonne: "wss://relay.yakihonne.com",
  "nostr.land": "wss://nostr.land",
  "relay.nostr.bg": "wss://relay.nostr.bg",
  "relay.noswhere.com": "wss://relay.noswhere.com",
  "purplepag.es": "wss://purplepag.es",
  "wot.utxo.one": "wss://wot.utxo.one",
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
