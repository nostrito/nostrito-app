use std::collections::HashMap;
use tracing::debug;

use super::types::{CursorBand, RelayRoute, RoutingPlan};

/// Build a routing plan using a greedy cover-set algorithm.
///
/// Given a map of `pubkey -> [(relay_url, reliability_score)]`, produces a minimal
/// set of relay routes that covers all pubkeys. Relays are scored by
/// `pubkey_count * reliability_score` and greedily selected.
///
/// Pubkeys in `exclude` (e.g. muted users) are skipped.
pub fn build_routing_plan(
    pubkey_relays: &HashMap<String, Vec<(String, f64)>>,
    exclude: &[String],
) -> RoutingPlan {
    let exclude_set: std::collections::HashSet<&str> =
        exclude.iter().map(|s| s.as_str()).collect();

    // Invert the map: relay_url -> set of pubkeys that use it + reliability score
    let mut relay_pubkeys: HashMap<String, (Vec<String>, f64)> = HashMap::new();

    for (pubkey, relays) in pubkey_relays {
        if exclude_set.contains(pubkey.as_str()) {
            continue;
        }
        for (relay_url, score) in relays {
            let entry = relay_pubkeys
                .entry(relay_url.clone())
                .or_insert_with(|| (Vec::new(), *score));
            entry.0.push(pubkey.clone());
            // Average the reliability scores
            entry.1 = (entry.1 + score) / 2.0;
        }
    }

    // Greedy cover-set: pick the relay that covers the most uncovered pubkeys
    let mut covered: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut routes: Vec<RelayRoute> = Vec::new();

    loop {
        let mut best: Option<(String, Vec<String>, f64)> = None;
        let mut best_score = 0.0f64;

        for (relay_url, (pubkeys, reliability)) in &relay_pubkeys {
            let uncovered: Vec<String> = pubkeys
                .iter()
                .filter(|pk| !covered.contains(pk.as_str()))
                .cloned()
                .collect();

            if uncovered.is_empty() {
                continue;
            }

            let score = uncovered.len() as f64 * reliability;
            if score > best_score {
                best_score = score;
                best = Some((relay_url.clone(), uncovered, *reliability));
            }
        }

        match best {
            Some((relay_url, pubkeys, reliability)) => {
                for pk in &pubkeys {
                    covered.insert(pk.clone());
                }
                debug!(
                    "Scheduler: selected {} covering {} pubkeys (score={:.2})",
                    relay_url,
                    pubkeys.len(),
                    best_score
                );
                routes.push(RelayRoute {
                    relay_url,
                    pubkeys,
                    reliability_score: reliability,
                });
            }
            None => break, // All pubkeys covered or no relays left
        }
    }

    // Check for uncovered pubkeys (no relay info at all)
    let total_pubkeys: usize = pubkey_relays
        .keys()
        .filter(|pk| !exclude_set.contains(pk.as_str()))
        .count();
    let uncovered_count = total_pubkeys - covered.len();
    if uncovered_count > 0 {
        debug!(
            "Scheduler: {} pubkeys have no relay coverage",
            uncovered_count
        );
    }

    RoutingPlan { routes }
}

/// Group pubkeys by cursor band (Hot/Warm/Cold) based on their last event timestamp.
///
/// `cursors`: map of pubkey -> (last_event_ts, last_fetched_at)
/// `now`: current unix timestamp
///
/// Returns a map of CursorBand -> list of pubkeys in that band.
pub fn group_by_cursor_band(
    cursors: &[(String, i64, i64)],
    now: i64,
) -> HashMap<CursorBand, Vec<String>> {
    let mut groups: HashMap<CursorBand, Vec<String>> = HashMap::new();

    for (pubkey, last_event_ts, _last_fetched_at) in cursors {
        let age_secs = if *last_event_ts > 0 {
            Some((now - last_event_ts).max(0) as u64)
        } else {
            None
        };
        let band = CursorBand::from_age(age_secs);
        groups.entry(band).or_default().push(pubkey.clone());
    }

    groups
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cover_set_basic() {
        let mut pubkey_relays = HashMap::new();
        pubkey_relays.insert(
            "pk1".to_string(),
            vec![("relay_a".to_string(), 0.9), ("relay_b".to_string(), 0.8)],
        );
        pubkey_relays.insert(
            "pk2".to_string(),
            vec![("relay_a".to_string(), 0.9)],
        );
        pubkey_relays.insert(
            "pk3".to_string(),
            vec![("relay_b".to_string(), 0.8)],
        );

        let plan = build_routing_plan(&pubkey_relays, &[]);
        assert!(!plan.routes.is_empty());

        // All pubkeys should be covered
        let covered: std::collections::HashSet<&str> = plan
            .routes
            .iter()
            .flat_map(|r| r.pubkeys.iter().map(|s| s.as_str()))
            .collect();
        assert!(covered.contains("pk1"));
        assert!(covered.contains("pk2"));
        assert!(covered.contains("pk3"));
    }

    #[test]
    fn test_cover_set_excludes_muted() {
        let mut pubkey_relays = HashMap::new();
        pubkey_relays.insert(
            "pk1".to_string(),
            vec![("relay_a".to_string(), 0.9)],
        );
        pubkey_relays.insert(
            "muted_pk".to_string(),
            vec![("relay_a".to_string(), 0.9)],
        );

        let plan = build_routing_plan(&pubkey_relays, &["muted_pk".to_string()]);

        let covered: std::collections::HashSet<&str> = plan
            .routes
            .iter()
            .flat_map(|r| r.pubkeys.iter().map(|s| s.as_str()))
            .collect();
        assert!(covered.contains("pk1"));
        assert!(!covered.contains("muted_pk"));
    }

    #[test]
    fn test_cover_set_prefers_reliable_relay() {
        let mut pubkey_relays = HashMap::new();
        // Both relays cover pk1, but relay_good has higher reliability
        pubkey_relays.insert(
            "pk1".to_string(),
            vec![
                ("relay_good".to_string(), 0.95),
                ("relay_bad".to_string(), 0.1),
            ],
        );

        let plan = build_routing_plan(&pubkey_relays, &[]);
        assert_eq!(plan.routes.len(), 1);
        assert_eq!(plan.routes[0].relay_url, "relay_good");
    }

    #[test]
    fn test_cover_set_empty_input() {
        let plan = build_routing_plan(&HashMap::new(), &[]);
        assert!(plan.routes.is_empty());
    }

    #[test]
    fn test_cursor_banding() {
        let now = 1_700_000_000i64;
        let cursors = vec![
            ("hot_user".into(), now - 600, now - 300),       // 10 min ago → Hot
            ("warm_user".into(), now - 7200, now - 3600),    // 2 hours ago → Warm
            ("cold_user".into(), now - 172800, now - 86400), // 2 days ago → Cold
            ("no_cursor".into(), 0, 0),                       // No events → Cold
        ];

        let groups = group_by_cursor_band(&cursors, now);

        assert_eq!(groups.get(&CursorBand::Hot).map(|v| v.len()), Some(1));
        assert_eq!(groups[&CursorBand::Hot][0], "hot_user");

        assert_eq!(groups.get(&CursorBand::Warm).map(|v| v.len()), Some(1));
        assert_eq!(groups[&CursorBand::Warm][0], "warm_user");

        let cold = groups.get(&CursorBand::Cold).unwrap();
        assert_eq!(cold.len(), 2);
        assert!(cold.contains(&"cold_user".to_string()));
        assert!(cold.contains(&"no_cursor".to_string()));
    }

    #[test]
    fn test_cover_set_fallback_multiple_relays() {
        let mut pubkey_relays = HashMap::new();
        // pk1 only on relay_a, pk2 only on relay_b — needs both relays
        pubkey_relays.insert(
            "pk1".to_string(),
            vec![("relay_a".to_string(), 0.9)],
        );
        pubkey_relays.insert(
            "pk2".to_string(),
            vec![("relay_b".to_string(), 0.9)],
        );

        let plan = build_routing_plan(&pubkey_relays, &[]);
        assert_eq!(plan.routes.len(), 2);
    }
}
