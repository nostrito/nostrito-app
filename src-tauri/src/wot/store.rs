use dashmap::DashMap;
use parking_lot::RwLock;
use std::sync::Arc;

use super::interner::PubkeyInterner;
use super::metrics::{LockMetrics, LockMetricsSnapshot, LockTimer};

/// Node metadata (pubkey is stored separately via interner)
#[derive(Debug, Clone)]
pub struct NodeInfo {
    #[allow(dead_code)]
    pub kind3_event_id: Option<String>,
    pub kind3_created_at: Option<i64>,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct GraphStats {
    pub node_count: usize,
    pub edge_count: usize,
    pub nodes_with_follows: usize,
}

pub struct WotGraph {
    interner: PubkeyInterner,
    pubkey_to_id: DashMap<Arc<str>, u32>,
    id_to_pubkey: RwLock<Vec<Arc<str>>>,
    follows: RwLock<Vec<Vec<u32>>>,
    followers: RwLock<Vec<Vec<u32>>>,
    node_info: RwLock<Vec<Option<NodeInfo>>>,
    lock_metrics: LockMetrics,
}

impl WotGraph {
    pub fn new() -> Self {
        Self {
            interner: PubkeyInterner::new(),
            pubkey_to_id: DashMap::new(),
            id_to_pubkey: RwLock::new(Vec::new()),
            follows: RwLock::new(Vec::new()),
            followers: RwLock::new(Vec::new()),
            node_info: RwLock::new(Vec::new()),
            lock_metrics: LockMetrics::new(),
        }
    }

    pub fn get_or_create_node(&self, pubkey: &str) -> u32 {
        if let Some(id) = self.pubkey_to_id.get(pubkey) {
            return *id;
        }

        let mut id_to_pubkey = self.id_to_pubkey.write();
        let mut follows = self.follows.write();
        let mut followers = self.followers.write();
        let mut node_info = self.node_info.write();

        if let Some(id) = self.pubkey_to_id.get(pubkey) {
            return *id;
        }

        let interned = self.interner.intern(pubkey);
        let id = id_to_pubkey.len() as u32;
        id_to_pubkey.push(interned.clone());
        follows.push(Vec::new());
        followers.push(Vec::new());
        node_info.push(None);
        self.pubkey_to_id.insert(interned, id);

        id
    }

    pub fn get_node_id(&self, pubkey: &str) -> Option<u32> {
        self.pubkey_to_id.get(pubkey).map(|r| *r)
    }

    pub fn get_node_id_and_arc(&self, pubkey: &str) -> Option<(u32, Arc<str>)> {
        self.pubkey_to_id.get(pubkey).map(|r| {
            let id = *r;
            let arc = r.key().clone();
            (id, arc)
        })
    }

    pub fn get_pubkey_arc_by_str(&self, pubkey: &str) -> Option<Arc<str>> {
        self.pubkey_to_id.get(pubkey).map(|r| r.key().clone())
    }

    #[allow(dead_code)]
    pub fn get_pubkey_arc(&self, id: u32) -> Option<Arc<str>> {
        let id_to_pubkey = self.id_to_pubkey.read();
        id_to_pubkey.get(id as usize).cloned()
    }

    pub fn update_follows(
        &self,
        pubkey: &str,
        follow_pubkeys: &[String],
        event_id: Option<String>,
        created_at: Option<i64>,
    ) -> bool {
        let node_id = self.get_or_create_node(pubkey);

        {
            let node_info = self.node_info.read();
            if let Some(Some(info)) = node_info.get(node_id as usize) {
                if let (Some(existing_ts), Some(new_ts)) = (info.kind3_created_at, created_at) {
                    if new_ts <= existing_ts {
                        return false;
                    }
                }
            }
        }

        let mut new_follow_ids: Vec<u32> = follow_pubkeys
            .iter()
            .map(|pk| self.get_or_create_node(pk))
            .collect();
        new_follow_ids.sort_unstable();
        new_follow_ids.dedup();

        let old_follow_ids: Vec<u32> = {
            let follows = self.follows.read();
            follows.get(node_id as usize).cloned().unwrap_or_default()
        };

        let to_remove: Vec<u32> = old_follow_ids
            .iter()
            .filter(|id| new_follow_ids.binary_search(id).is_err())
            .copied()
            .collect();
        let to_add: Vec<u32> = new_follow_ids
            .iter()
            .filter(|id| old_follow_ids.binary_search(id).is_err())
            .copied()
            .collect();

        {
            let _timer = LockTimer::write(&self.lock_metrics);
            let mut follows = self.follows.write();
            let mut followers = self.followers.write();

            for &old_followed_id in &to_remove {
                if let Some(follower_list) = followers.get_mut(old_followed_id as usize) {
                    if let Ok(pos) = follower_list.binary_search(&node_id) {
                        follower_list.remove(pos);
                    }
                }
            }

            if let Some(follow_list) = follows.get_mut(node_id as usize) {
                *follow_list = new_follow_ids;
            }

            for &followed_id in &to_add {
                if let Some(follower_list) = followers.get_mut(followed_id as usize) {
                    match follower_list.binary_search(&node_id) {
                        Ok(_) => {}
                        Err(pos) => follower_list.insert(pos, node_id),
                    }
                }
            }
        }

        {
            let mut node_info = self.node_info.write();
            if let Some(info_slot) = node_info.get_mut(node_id as usize) {
                *info_slot = Some(NodeInfo {
                    kind3_event_id: event_id,
                    kind3_created_at: created_at,
                });
            }
        }

        true
    }

    #[allow(dead_code)]
    pub fn get_follows(&self, pubkey: &str) -> Option<Vec<String>> {
        let node_id = self.get_node_id(pubkey)?;
        let follows = self.follows.read();
        let id_to_pubkey = self.id_to_pubkey.read();

        follows.get(node_id as usize).map(|follow_list| {
            follow_list
                .iter()
                .filter_map(|&id| id_to_pubkey.get(id as usize).map(|arc| arc.to_string()))
                .collect()
        })
    }

    #[allow(dead_code)]
    pub fn get_followers(&self, pubkey: &str) -> Option<Vec<String>> {
        let node_id = self.get_node_id(pubkey)?;
        let followers = self.followers.read();
        let id_to_pubkey = self.id_to_pubkey.read();

        followers.get(node_id as usize).map(|follower_list| {
            follower_list
                .iter()
                .filter_map(|&id| id_to_pubkey.get(id as usize).map(|arc| arc.to_string()))
                .collect()
        })
    }

    /// Get suggested follows: friends-of-friends ranked by mutual follow count.
    /// Returns vec of (pubkey, mutual_count) for pubkeys at distance 2 the user doesn't already follow.
    pub fn get_suggested_follows(&self, own_pubkey: &str, limit: usize) -> Vec<(String, usize)> {
        let own_id = match self.get_node_id(own_pubkey) {
            Some(id) => id as usize,
            None => return vec![],
        };

        let follows_guard = self.follows.read();
        let id_to_pubkey = self.id_to_pubkey.read();

        // Get own direct follows
        let own_follows: std::collections::HashSet<u32> = follows_guard
            .get(own_id)
            .map(|list| list.iter().cloned().collect())
            .unwrap_or_default();

        if own_follows.is_empty() {
            return vec![];
        }

        // Score friends-of-friends by how many of our follows also follow them
        let mut scores: std::collections::HashMap<u32, usize> = std::collections::HashMap::new();
        for &follow_id in &own_follows {
            if let Some(fof_list) = follows_guard.get(follow_id as usize) {
                for &fof in fof_list {
                    if fof != own_id as u32 && !own_follows.contains(&fof) {
                        *scores.entry(fof).or_insert(0) += 1;
                    }
                }
            }
        }

        // Sort by score descending, take top N
        let mut sorted: Vec<_> = scores.into_iter().collect();
        sorted.sort_by(|a, b| b.1.cmp(&a.1));
        sorted.truncate(limit);

        sorted
            .into_iter()
            .filter_map(|(id, score)| {
                id_to_pubkey.get(id as usize).map(|pk| (pk.to_string(), score))
            })
            .collect()
    }

    /// Return all pubkeys in the WoT graph.
    pub fn get_all_pubkeys(&self) -> Vec<String> {
        let id_to_pubkey = self.id_to_pubkey.read();
        id_to_pubkey.iter().map(|arc| arc.to_string()).collect()
    }

    pub fn with_adjacency<F, R>(&self, f: F) -> R
    where
        F: FnOnce(&[Vec<u32>], &[Vec<u32>]) -> R,
    {
        let _timer = LockTimer::read(&self.lock_metrics);
        let follows = self.follows.read();
        let followers = self.followers.read();
        f(&follows, &followers)
    }

    pub fn resolve_pubkeys_arc(&self, ids: &[u32]) -> Vec<Arc<str>> {
        let id_to_pubkey = self.id_to_pubkey.read();
        ids.iter()
            .filter_map(|&id| id_to_pubkey.get(id as usize).cloned())
            .collect()
    }

    pub fn stats(&self) -> GraphStats {
        let follows = self.follows.read();
        let id_to_pubkey = self.id_to_pubkey.read();

        let node_count = id_to_pubkey.len();
        let edge_count: usize = follows.iter().map(|list| list.len()).sum();
        let nodes_with_follows = follows.iter().filter(|list| !list.is_empty()).count();

        GraphStats {
            node_count,
            edge_count,
            nodes_with_follows,
        }
    }

    #[allow(dead_code)]
    pub fn lock_metrics(&self) -> LockMetricsSnapshot {
        self.lock_metrics.snapshot()
    }

    /// Return all known pubkeys in the graph (hex strings).
    pub fn all_pubkeys(&self) -> Vec<String> {
        let id_to_pubkey = self.id_to_pubkey.read();
        id_to_pubkey.iter().map(|arc| arc.to_string()).collect()
    }

    /// Clear all graph data (used on app reset)
    pub fn clear(&self) {
        self.pubkey_to_id.clear();
        *self.id_to_pubkey.write() = Vec::new();
        *self.follows.write() = Vec::new();
        *self.followers.write() = Vec::new();
        *self.node_info.write() = Vec::new();
    }
}

impl Default for WotGraph {
    fn default() -> Self {
        Self::new()
    }
}
