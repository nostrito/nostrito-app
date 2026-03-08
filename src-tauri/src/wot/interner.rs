use dashmap::DashMap;
use std::sync::Arc;

/// Interns pubkey strings to share allocations across the graph.
/// Each unique pubkey is stored once, with Arc<str> references shared.
pub struct PubkeyInterner {
    interned: DashMap<Arc<str>, ()>,
}

impl PubkeyInterner {
    pub fn new() -> Self {
        Self {
            interned: DashMap::new(),
        }
    }

    pub fn intern(&self, s: &str) -> Arc<str> {
        if let Some(entry) = self.interned.get(s) {
            return entry.key().clone();
        }

        let arc: Arc<str> = Arc::from(s);
        self.interned.entry(arc.clone()).or_insert(());

        if let Some(entry) = self.interned.get(s) {
            entry.key().clone()
        } else {
            arc
        }
    }

    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.interned.len()
    }

    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.interned.is_empty()
    }
}

impl Default for PubkeyInterner {
    fn default() -> Self {
        Self::new()
    }
}
