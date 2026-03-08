use super::WotGraph;
use rustc_hash::{FxHashMap, FxHashSet};
use std::cell::RefCell;
use std::sync::Arc;

const VISITED_CAPACITY: usize = 8192;
const FRONTIER_CAPACITY: usize = 1024;
const MEETING_NODES_CAPACITY: usize = 64;
const BRIDGE_CAPACITY: usize = 64;

struct BfsState {
    fwd_visited: FxHashMap<u32, (u32, u64)>,
    fwd_current: Vec<u32>,
    fwd_next: Vec<u32>,
    bwd_visited: FxHashMap<u32, (u32, u64)>,
    bwd_current: Vec<u32>,
    bwd_next: Vec<u32>,
    meeting_nodes: Vec<(u32, u64, u64)>,
    bridge_set: FxHashSet<u32>,
    bridge_ids: Vec<u32>,
}

impl BfsState {
    fn new() -> Self {
        Self {
            fwd_visited: FxHashMap::with_capacity_and_hasher(VISITED_CAPACITY, Default::default()),
            fwd_current: Vec::with_capacity(FRONTIER_CAPACITY),
            fwd_next: Vec::with_capacity(FRONTIER_CAPACITY),
            bwd_visited: FxHashMap::with_capacity_and_hasher(VISITED_CAPACITY, Default::default()),
            bwd_current: Vec::with_capacity(FRONTIER_CAPACITY),
            bwd_next: Vec::with_capacity(FRONTIER_CAPACITY),
            meeting_nodes: Vec::with_capacity(MEETING_NODES_CAPACITY),
            bridge_set: FxHashSet::with_capacity_and_hasher(BRIDGE_CAPACITY, Default::default()),
            bridge_ids: Vec::with_capacity(BRIDGE_CAPACITY),
        }
    }

    fn clear(&mut self) {
        self.fwd_visited.clear();
        self.fwd_current.clear();
        self.fwd_next.clear();
        self.bwd_visited.clear();
        self.bwd_current.clear();
        self.bwd_next.clear();
        self.meeting_nodes.clear();
        self.bridge_set.clear();
        self.bridge_ids.clear();
    }
}

thread_local! {
    static BFS_STATE: RefCell<BfsState> = RefCell::new(BfsState::new());
}

#[derive(Debug, Clone)]
pub struct DistanceQuery {
    pub from: Arc<str>,
    pub to: Arc<str>,
    pub max_hops: u8,
    pub include_bridges: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DistanceResult {
    pub from: Arc<str>,
    pub to: Arc<str>,
    pub hops: Option<u32>,
    pub path_count: u64,
    pub mutual_follow: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bridges: Option<Vec<Arc<str>>>,
}

impl DistanceResult {
    pub fn not_found(from: Arc<str>, to: Arc<str>) -> Self {
        Self {
            from,
            to,
            hops: None,
            path_count: 0,
            mutual_follow: false,
            bridges: None,
        }
    }

    pub fn same_node(pubkey: Arc<str>) -> Self {
        Self {
            from: Arc::clone(&pubkey),
            to: pubkey,
            hops: Some(0),
            path_count: 1,
            mutual_follow: false,
            bridges: None,
        }
    }
}

pub fn compute_distance(graph: &WotGraph, query: &DistanceQuery) -> DistanceResult {
    if query.from == query.to {
        let pubkey_arc = graph
            .get_pubkey_arc_by_str(&query.from)
            .unwrap_or_else(|| Arc::clone(&query.from));
        return DistanceResult::same_node(pubkey_arc);
    }

    let (from_id, from_arc) = match graph.get_node_id_and_arc(&query.from) {
        Some(pair) => pair,
        None => return DistanceResult::not_found(Arc::clone(&query.from), Arc::clone(&query.to)),
    };

    let (to_id, to_arc) = match graph.get_node_id_and_arc(&query.to) {
        Some(pair) => pair,
        None => return DistanceResult::not_found(Arc::clone(&from_arc), Arc::clone(&query.to)),
    };

    graph.with_adjacency(|follows, followers| {
        let is_direct = |from: u32, to: u32| -> bool {
            follows
                .get(from as usize)
                .map(|list| list.binary_search(&to).is_ok())
                .unwrap_or(false)
        };

        let mutual_follow = is_direct(from_id, to_id) && is_direct(to_id, from_id);

        if is_direct(from_id, to_id) {
            return DistanceResult {
                from: Arc::clone(&from_arc),
                to: Arc::clone(&to_arc),
                hops: Some(1),
                path_count: 1,
                mutual_follow,
                bridges: if query.include_bridges {
                    Some(vec![])
                } else {
                    None
                },
            };
        }

        BFS_STATE.with(|state| {
            let mut state = state.borrow_mut();
            state.clear();
            bidirectional_bfs(
                &mut state,
                follows,
                followers,
                from_id,
                to_id,
                query.max_hops,
                query.include_bridges,
                mutual_follow,
                Arc::clone(&from_arc),
                Arc::clone(&to_arc),
                graph,
            )
        })
    })
}

#[allow(clippy::too_many_arguments)]
fn bidirectional_bfs(
    state: &mut BfsState,
    follows: &[Vec<u32>],
    followers: &[Vec<u32>],
    from_id: u32,
    to_id: u32,
    max_hops: u8,
    include_bridges: bool,
    mutual_follow: bool,
    from_arc: Arc<str>,
    to_arc: Arc<str>,
    graph: &WotGraph,
) -> DistanceResult {
    state.fwd_visited.insert(from_id, (0, 1));
    state.fwd_current.push(from_id);
    state.bwd_visited.insert(to_id, (0, 1));
    state.bwd_current.push(to_id);

    let mut fwd_dist = 0u32;
    let mut bwd_dist = 0u32;
    let mut best_distance: Option<u32> = None;

    'outer: while !state.fwd_current.is_empty() || !state.bwd_current.is_empty() {
        let current_min_possible = fwd_dist + bwd_dist;
        if let Some(best) = best_distance {
            if current_min_possible >= best {
                break;
            }
        }
        if current_min_possible as u8 > max_hops {
            break;
        }

        let expand_forward = if state.fwd_current.is_empty() {
            false
        } else if state.bwd_current.is_empty() {
            true
        } else {
            state.fwd_current.len() <= state.bwd_current.len()
        };

        if expand_forward {
            fwd_dist += 1;
            for i in 0..state.fwd_current.len() {
                let node = state.fwd_current[i];
                let (_, node_paths) = state.fwd_visited[&node];

                for &neighbor in &follows[node as usize] {
                    if let Some(&(bwd_d, bwd_paths)) = state.bwd_visited.get(&neighbor) {
                        let total_dist = fwd_dist + bwd_d;
                        if best_distance.is_none() || total_dist < best_distance.unwrap() {
                            best_distance = Some(total_dist);
                            state.meeting_nodes.clear();
                        }
                        if best_distance == Some(total_dist) {
                            state.meeting_nodes.push((neighbor, node_paths, bwd_paths));
                        }
                        if !include_bridges {
                            break 'outer;
                        }
                    }

                    match state.fwd_visited.entry(neighbor) {
                        std::collections::hash_map::Entry::Vacant(e) => {
                            e.insert((fwd_dist, node_paths));
                            state.fwd_next.push(neighbor);
                        }
                        std::collections::hash_map::Entry::Occupied(mut e) => {
                            let (existing_dist, existing_paths) = e.get_mut();
                            if *existing_dist == fwd_dist {
                                *existing_paths += node_paths;
                            }
                        }
                    }
                }
            }
            state.fwd_current.clear();
            std::mem::swap(&mut state.fwd_current, &mut state.fwd_next);
        } else {
            bwd_dist += 1;
            for i in 0..state.bwd_current.len() {
                let node = state.bwd_current[i];
                let (_, node_paths) = state.bwd_visited[&node];

                for &neighbor in &followers[node as usize] {
                    if let Some(&(fwd_d, fwd_paths)) = state.fwd_visited.get(&neighbor) {
                        let total_dist = fwd_d + bwd_dist;
                        if best_distance.is_none() || total_dist < best_distance.unwrap() {
                            best_distance = Some(total_dist);
                            state.meeting_nodes.clear();
                        }
                        if best_distance == Some(total_dist) {
                            state.meeting_nodes.push((neighbor, fwd_paths, node_paths));
                        }
                        if !include_bridges {
                            break 'outer;
                        }
                    }

                    match state.bwd_visited.entry(neighbor) {
                        std::collections::hash_map::Entry::Vacant(e) => {
                            e.insert((bwd_dist, node_paths));
                            state.bwd_next.push(neighbor);
                        }
                        std::collections::hash_map::Entry::Occupied(mut e) => {
                            let (existing_dist, existing_paths) = e.get_mut();
                            if *existing_dist == bwd_dist {
                                *existing_paths += node_paths;
                            }
                        }
                    }
                }
            }
            state.bwd_current.clear();
            std::mem::swap(&mut state.bwd_current, &mut state.bwd_next);
        }
    }

    match best_distance {
        Some(hops) if hops as u8 <= max_hops => {
            let path_count: u64 = state
                .meeting_nodes
                .iter()
                .map(|(_, fwd_paths, bwd_paths)| fwd_paths * bwd_paths)
                .sum();

            let bridges = if include_bridges {
                for (id, _, _) in &state.meeting_nodes {
                    if state.bridge_set.insert(*id) {
                        state.bridge_ids.push(*id);
                    }
                }
                Some(graph.resolve_pubkeys_arc(&state.bridge_ids))
            } else {
                None
            };

            DistanceResult {
                from: from_arc,
                to: to_arc,
                hops: Some(hops),
                path_count,
                mutual_follow,
                bridges,
            }
        }
        Some(_) | None => DistanceResult::not_found(from_arc, to_arc),
    }
}
