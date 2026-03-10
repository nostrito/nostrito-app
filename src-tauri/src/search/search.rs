#![allow(dead_code)]
use anyhow::Result;
use nostr_sdk::prelude::*;
use std::sync::Arc;
use tracing::{debug, info, warn};

use crate::storage::db::Database;
use crate::wot::bfs::get_all_hop_distances;
use crate::wot::WotGraph;

/// Hybrid search engine: local DB + NIP-50 relay search with WoT-aware ranking.
pub struct SearchEngine {
    db: Arc<Database>,
    graph: Arc<WotGraph>,
    own_pubkey: String,
}

/// A ranked search result.
#[derive(Debug, Clone)]
pub struct SearchResult {
    pub id: String,
    pub pubkey: String,
    pub created_at: i64,
    pub kind: i64,
    pub tags: String,
    pub content: String,
    pub sig: String,
    pub wot_distance: Option<u8>,
    pub source: SearchSource,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SearchSource {
    Local,
    Relay(String),
}

/// What kind of query the user typed.
#[derive(Debug)]
enum QueryType {
    /// Plain text keyword search
    Text(String),
    /// @username search
    Username(String),
    /// npub1... bech32 pubkey
    Npub(String),
    /// 64-char hex pubkey
    HexPubkey(String),
    /// note1... bech32 event id
    NoteId(String),
    /// user@domain.com NIP-05 identifier
    Nip05(String),
}

const NIP50_RELAYS: &[&str] = &[
    "wss://relay.nostr.band",
    "wss://search.nos.today",
];

impl SearchEngine {
    pub fn new(db: Arc<Database>, graph: Arc<WotGraph>, own_pubkey: String) -> Self {
        Self { db, graph, own_pubkey }
    }

    /// Run a search query, returning ranked results.
    pub async fn search(&self, query: &str, limit: u32) -> Result<Vec<SearchResult>> {
        let query_type = Self::classify_query(query);
        debug!("Search: query={:?}, type={:?}", query, query_type);

        let mut results: Vec<SearchResult> = Vec::new();

        match &query_type {
            QueryType::Text(q) => {
                // Local DB search
                let local = self.search_local(Some(q), None, limit)?;
                results.extend(local);

                // NIP-50 relay search
                match self.search_nip50(q, limit).await {
                    Ok(relay_results) => results.extend(relay_results),
                    Err(e) => warn!("NIP-50 search failed: {}", e),
                }
            }
            QueryType::Username(name) => {
                // Search for profiles matching name
                let local = self.search_local(Some(name), None, limit)?;
                results.extend(local);
            }
            QueryType::Npub(npub) => {
                match PublicKey::from_bech32(npub) {
                    Ok(pk) => {
                        let hex = pk.to_hex();
                        let local = self.search_local(None, Some(&hex), limit)?;
                        results.extend(local);
                    }
                    Err(e) => warn!("Invalid npub: {}", e),
                }
            }
            QueryType::HexPubkey(hex) => {
                let local = self.search_local(None, Some(hex), limit)?;
                results.extend(local);
            }
            QueryType::NoteId(note) => {
                match EventId::from_bech32(note) {
                    Ok(eid) => {
                        let hex = eid.to_hex();
                        let local = self.search_by_event_id(&hex)?;
                        results.extend(local);
                    }
                    Err(e) => warn!("Invalid note ID: {}", e),
                }
            }
            QueryType::Nip05(addr) => {
                // Treat as text search for now (NIP-05 verification requires HTTP)
                let local = self.search_local(Some(addr), None, limit)?;
                results.extend(local);
            }
        }

        // Deduplicate
        self.dedup(&mut results);

        // WoT-aware ranking
        self.rank_results(&mut results);

        // Trim to limit
        results.truncate(limit as usize);

        info!("Search: query={:?}, {} results", query, results.len());
        Ok(results)
    }

    /// Classify the query string into a query type.
    fn classify_query(query: &str) -> QueryType {
        let q = query.trim();

        if q.starts_with('@') {
            return QueryType::Username(q[1..].to_string());
        }
        if q.starts_with("npub1") {
            return QueryType::Npub(q.to_string());
        }
        if q.starts_with("note1") {
            return QueryType::NoteId(q.to_string());
        }
        if q.len() == 64 && q.chars().all(|c| c.is_ascii_hexdigit()) {
            return QueryType::HexPubkey(q.to_string());
        }
        if q.contains('@') && q.contains('.') && !q.contains(' ') {
            return QueryType::Nip05(q.to_string());
        }

        QueryType::Text(q.to_string())
    }

    /// Search local database.
    fn search_local(
        &self,
        keyword: Option<&str>,
        author: Option<&str>,
        limit: u32,
    ) -> Result<Vec<SearchResult>> {
        let events = self.db.search_events(keyword, author, limit)?;
        Ok(events
            .into_iter()
            .map(|(id, pubkey, created_at, kind, tags, content, sig)| SearchResult {
                id,
                pubkey,
                created_at,
                kind,
                tags,
                content,
                sig,
                wot_distance: None,
                source: SearchSource::Local,
            })
            .collect())
    }

    /// Search by specific event ID.
    fn search_by_event_id(&self, event_id: &str) -> Result<Vec<SearchResult>> {
        let events = self.db.query_events(
            Some(&[event_id.to_string()]),
            None,
            None,
            None,
            None,
            1,
        )?;
        Ok(events
            .into_iter()
            .map(|(id, pubkey, created_at, kind, tags, content, sig)| SearchResult {
                id,
                pubkey,
                created_at,
                kind,
                tags,
                content,
                sig,
                wot_distance: None,
                source: SearchSource::Local,
            })
            .collect())
    }

    /// NIP-50 search: query relay.nostr.band and similar.
    async fn search_nip50(&self, query: &str, limit: u32) -> Result<Vec<SearchResult>> {
        let mut all_results = Vec::new();

        for relay_url in NIP50_RELAYS {
            match self.query_nip50_relay(relay_url, query, limit).await {
                Ok(mut results) => {
                    all_results.append(&mut results);
                }
                Err(e) => {
                    debug!("NIP-50 search on {} failed: {}", relay_url, e);
                }
            }
        }

        Ok(all_results)
    }

    /// Query a single NIP-50 relay.
    async fn query_nip50_relay(
        &self,
        relay_url: &str,
        query: &str,
        limit: u32,
    ) -> Result<Vec<SearchResult>> {
        let client = Client::default();
        client.add_relay(relay_url).await?;
        client.connect().await;

        // Brief pause for connection
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;

        let filter = Filter::new()
            .kinds(vec![Kind::TextNote, Kind::LongFormTextNote])
            .search(query)
            .limit(limit as usize);

        let mut notifications = client.notifications();
        let _sub = client.subscribe(vec![filter], None).await?;

        let mut events: Vec<Event> = Vec::new();
        let deadline = tokio::time::sleep(std::time::Duration::from_secs(10));
        tokio::pin!(deadline);

        loop {
            tokio::select! {
                result = notifications.recv() => {
                    match result {
                        Ok(RelayPoolNotification::Event { event, .. }) => {
                            events.push(*event);
                        }
                        Ok(RelayPoolNotification::Message { message, .. }) => {
                            if matches!(&message, RelayMessage::EndOfStoredEvents(_)) {
                                break;
                            }
                        }
                        Ok(_) => {}
                        Err(_) => break,
                    }
                }
                _ = &mut deadline => break,
            }
        }

        client.disconnect().await.ok();

        let relay_source = SearchSource::Relay(relay_url.to_string());
        let results: Vec<SearchResult> = events
            .into_iter()
            .map(|event| {
                let tags_json = serde_json::to_string(
                    &event
                        .tags
                        .iter()
                        .map(|t| {
                            t.as_slice()
                                .iter()
                                .map(|s| s.to_string())
                                .collect::<Vec<String>>()
                        })
                        .collect::<Vec<Vec<String>>>(),
                )
                .unwrap_or_else(|_| "[]".to_string());

                // Store in local DB with source='search'
                self.db
                    .store_event(
                        &event.id.to_hex(),
                        &event.pubkey.to_hex(),
                        event.created_at.as_u64() as i64,
                        event.kind.as_u16() as u32,
                        &tags_json,
                        &event.content.to_string(),
                        &event.sig.to_string(),
                    )
                    .ok();

                SearchResult {
                    id: event.id.to_hex(),
                    pubkey: event.pubkey.to_hex(),
                    created_at: event.created_at.as_u64() as i64,
                    kind: event.kind.as_u16() as i64,
                    tags: tags_json,
                    content: event.content.to_string(),
                    sig: event.sig.to_string(),
                    wot_distance: None,
                    source: relay_source.clone(),
                }
            })
            .collect();

        Ok(results)
    }

    /// Deduplicate results by event ID.
    fn dedup(&self, results: &mut Vec<SearchResult>) {
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        results.retain(|r| seen.insert(r.id.clone()));
    }

    /// Rank results with WoT distance as a signal.
    fn rank_results(&self, results: &mut Vec<SearchResult>) {
        // Compute hop distances for all result authors
        let distances = get_all_hop_distances(&self.graph, &self.own_pubkey, 3);

        for result in results.iter_mut() {
            // Look up WoT distance
            for (key, dist) in &distances {
                if key.as_ref() == result.pubkey {
                    result.wot_distance = Some(*dist);
                    break;
                }
            }
        }

        // Sort: own events first, then by WoT distance (closer = better), then by recency
        results.sort_by(|a, b| {
            // Own events first
            let a_own = a.pubkey == self.own_pubkey;
            let b_own = b.pubkey == self.own_pubkey;
            if a_own != b_own {
                return b_own.cmp(&a_own);
            }

            // Lower WoT distance = higher rank
            let a_dist = a.wot_distance.unwrap_or(255);
            let b_dist = b.wot_distance.unwrap_or(255);
            if a_dist != b_dist {
                return a_dist.cmp(&b_dist);
            }

            // More recent = higher rank
            b.created_at.cmp(&a.created_at)
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_query_text() {
        match SearchEngine::classify_query("hello world") {
            QueryType::Text(s) => assert_eq!(s, "hello world"),
            _ => panic!("Expected Text"),
        }
    }

    #[test]
    fn test_classify_query_username() {
        match SearchEngine::classify_query("@alice") {
            QueryType::Username(s) => assert_eq!(s, "alice"),
            _ => panic!("Expected Username"),
        }
    }

    #[test]
    fn test_classify_query_npub() {
        match SearchEngine::classify_query("npub1abc123") {
            QueryType::Npub(s) => assert_eq!(s, "npub1abc123"),
            _ => panic!("Expected Npub"),
        }
    }

    #[test]
    fn test_classify_query_hex() {
        let hex = "a".repeat(64);
        match SearchEngine::classify_query(&hex) {
            QueryType::HexPubkey(s) => assert_eq!(s, hex),
            _ => panic!("Expected HexPubkey"),
        }
    }

    #[test]
    fn test_classify_query_note() {
        match SearchEngine::classify_query("note1abc123") {
            QueryType::NoteId(s) => assert_eq!(s, "note1abc123"),
            _ => panic!("Expected NoteId"),
        }
    }

    #[test]
    fn test_classify_query_nip05() {
        match SearchEngine::classify_query("user@example.com") {
            QueryType::Nip05(s) => assert_eq!(s, "user@example.com"),
            _ => panic!("Expected Nip05"),
        }
    }

    #[test]
    fn test_dedup() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let db = Arc::new(Database::open(tmp.path()).unwrap());
        let graph = Arc::new(WotGraph::new());
        let engine = SearchEngine::new(db, graph, "abc".to_string());

        let mut results = vec![
            SearchResult {
                id: "aaa".into(),
                pubkey: "pk1".into(),
                created_at: 100,
                kind: 1,
                tags: "[]".into(),
                content: "hello".into(),
                sig: "sig".into(),
                wot_distance: None,
                source: SearchSource::Local,
            },
            SearchResult {
                id: "aaa".into(),
                pubkey: "pk1".into(),
                created_at: 100,
                kind: 1,
                tags: "[]".into(),
                content: "hello".into(),
                sig: "sig".into(),
                wot_distance: None,
                source: SearchSource::Relay("wss://test".into()),
            },
            SearchResult {
                id: "bbb".into(),
                pubkey: "pk2".into(),
                created_at: 200,
                kind: 1,
                tags: "[]".into(),
                content: "world".into(),
                sig: "sig".into(),
                wot_distance: None,
                source: SearchSource::Local,
            },
        ];

        engine.dedup(&mut results);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].id, "aaa");
        assert_eq!(results[1].id, "bbb");
    }
}
