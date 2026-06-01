// Pure graph-routing functions — no DOM, no globals.
// Loaded as a plain <script> in the browser; exported via CJS for Node tests.

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function nodeKey(lat, lon) {
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}

// paths may carry a _weight multiplier (e.g. 3 for OSM gap-fill edges)
function buildGraph(paths) {
  const nodes = new Map();
  const adj   = new Map();

  function ensure(lat, lon) {
    const k = nodeKey(lat, lon);
    if (!nodes.has(k)) { nodes.set(k, { lat, lon, k }); adj.set(k, []); }
    return k;
  }
  function link(k1, k2, d) {
    adj.get(k1).push({ to: k2, d });
    adj.get(k2).push({ to: k1, d });
  }

  paths.forEach(path => {
    const c = path.coordinates;
    const w = path._weight || 1;
    const keys = c.map(([lat, lon]) => ensure(lat, lon));
    for (let i = 0; i < keys.length - 1; i++) {
      const d = haversineM(c[i][0], c[i][1], c[i + 1][0], c[i + 1][1]) * w;
      if (!adj.get(keys[i]).some(e => e.to === keys[i + 1])) link(keys[i], keys[i + 1], d);
    }
  });

  // Connect path endpoints within 80 m so separate paths join up.
  // Grid index: ~111 m cells → checking ±1 neighbor in each axis covers all 80 m pairs.
  const CELL = 0.001;
  const endpoints = [];
  const grid = new Map();
  paths.forEach(p => {
    const c = p.coordinates;
    endpoints.push([c[0][0], c[0][1]]);
    endpoints.push([c[c.length - 1][0], c[c.length - 1][1]]);
  });
  endpoints.forEach((ep, idx) => {
    const ck = `${Math.floor(ep[0] / CELL)},${Math.floor(ep[1] / CELL)}`;
    if (!grid.has(ck)) grid.set(ck, []);
    grid.get(ck).push(idx);
  });
  for (let i = 0; i < endpoints.length; i++) {
    const cr = Math.floor(endpoints[i][0] / CELL);
    const cc = Math.floor(endpoints[i][1] / CELL);
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const neighbors = grid.get(`${cr + dr},${cc + dc}`);
        if (!neighbors) continue;
        for (const j of neighbors) {
          if (j <= i) continue;
          const d = haversineM(...endpoints[i], ...endpoints[j]);
          if (d > 0 && d < 80) {
            const ka = nodeKey(...endpoints[i]), kb = nodeKey(...endpoints[j]);
            if (adj.has(ka) && adj.has(kb) && !adj.get(ka).some(e => e.to === kb)) link(ka, kb, d);
          }
        }
      }
    }
  }

  return { nodes, adj };
}

// Walk from startNode to the nearest node with degree ≥ 2 (a real junction).
// Avoids anchoring loops at dead-end leaf nodes.
function snapToJunction(nodes, adj, startNode) {
  if ((adj.get(startNode.k) || []).length >= 2) return startNode;
  let best = startNode, bd = Infinity;
  for (const [k, edges] of adj) {
    if (edges.length >= 2) {
      const n = nodes.get(k);
      const d = haversineM(startNode.lat, startNode.lon, n.lat, n.lon);
      if (d < bd) { bd = d; best = n; }
    }
  }
  return best;
}

// Remove all dead-end spurs by iteratively deleting degree-1 nodes.
// The result only contains nodes that are part of actual cycles — routing on
// this graph guarantees no path will need to backtrack along a dead-end branch.
function pruneDeadEnds(adjIn) {
  const adj = new Map([...adjIn].map(([k, edges]) => [k, [...edges]]));
  const queue = [];
  for (const [k, edges] of adj) {
    if (edges.length <= 1) queue.push(k);
  }
  while (queue.length) {
    const k = queue.pop();
    if (!adj.has(k)) continue;
    const edges = adj.get(k);
    if (edges.length >= 2) continue;
    const neighbor = edges.length === 1 ? edges[0].to : null;
    adj.delete(k);
    if (neighbor && adj.has(neighbor)) {
      const ne = adj.get(neighbor).filter(e => e.to !== k);
      if (ne.length === 0) { adj.delete(neighbor); }
      else {
        adj.set(neighbor, ne);
        if (ne.length === 1) queue.push(neighbor);
      }
    }
  }
  return adj;
}

function dijkstra(adj, start, end = null) {
  const dist = new Map([[start, 0]]);
  const prev = new Map();
  const queue = [[0, start]];

  while (queue.length) {
    queue.sort((a, b) => a[0] - b[0]);
    const [d, u] = queue.shift();
    if (end && u === end) break;
    if (d > (dist.get(u) ?? Infinity)) continue;
    for (const { to, d: w } of (adj.get(u) || [])) {
      const nd = d + w;
      if (nd < (dist.get(to) ?? Infinity)) {
        dist.set(to, nd); prev.set(to, u); queue.push([nd, to]);
      }
    }
  }
  return { dist, prev };
}

function rebuildPath(prev, start, end) {
  const path = [];
  let cur = end;
  while (cur !== undefined) {
    path.unshift(cur);
    if (cur === start) break;
    cur = prev.get(cur);
  }
  return path[0] === start ? path : null;
}

function nearestNode(nodes, lat, lon) {
  let best = null, bd = Infinity;
  for (const n of nodes.values()) {
    const d = haversineM(lat, lon, n.lat, n.lon);
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}

function graphToResult(nodes, keys, pathTyp) {
  const coords = keys.map(k => { const n = nodes.get(k); return [n.lat, n.lon]; });
  let meters = 0;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = nodes.get(keys[i]), b = nodes.get(keys[i + 1]);
    meters += haversineM(a.lat, a.lon, b.lat, b.lon);
  }
  const speed = pathTyp === 'bike' ? 4.17 : 1.11; // m/s
  return { coords, meters, seconds: meters / speed };
}

// A → B routing on the graph.
// paths: pre-filtered array of path objects (each with a .coordinates array of [lat,lon] pairs).
function graphAtob(sLat, sLng, eLat, eLng, paths) {
  if (!paths.length) throw new Error('Aucun chemin de ce type enregistré');
  const { nodes, adj } = buildGraph(paths);
  const sNode = nearestNode(nodes, sLat, sLng);
  const eNode = nearestNode(nodes, eLat, eLng);
  const { prev } = dijkstra(adj, sNode.k, eNode.k);
  const keys = rebuildPath(prev, sNode.k, eNode.k);
  if (!keys) throw new Error('Aucun chemin entre ces deux points');
  return graphToResult(nodes, keys, 'foot');
}

// Loop routing on the graph — routes out one way, removes those edges, routes back differently.
// Dead-end spurs are pruned first so the router never has to backtrack along a branch.
// The return path must arrive at start via a different edge than the outbound departure.
// paths: pre-filtered array of path objects.
// pathTyp: 'foot' | 'bike' | 'champs' (used only for speed in the result).
function graphLoop(sLat, sLng, targetKm, paths, pathTyp = 'foot') {
  if (!paths.length) throw new Error('Aucun chemin de ce type enregistré');
  const { nodes, adj: adjFull } = buildGraph(paths);
  if (nodes.size < 4) throw new Error('Pas assez de chemins — ajoutes-en depuis le panneau admin');

  // Prune dead-end spurs — only nodes that are part of real cycles remain.
  // Every node in adj has degree ≥ 2 after this step.
  const adj = pruneDeadEnds(adjFull);
  if (adj.size < 4) throw new Error('Pas assez de chemins en boucle dans cette zone — ajoutes-en depuis le panneau admin');

  // Snap start to nearest node that survived pruning
  let startNode;
  {
    const raw = nearestNode(nodes, sLat, sLng);
    if (adj.has(raw.k)) {
      startNode = raw;
    } else {
      let bd = Infinity;
      startNode = raw;
      for (const k of adj.keys()) {
        const n = nodes.get(k);
        if (!n) continue;
        const d = haversineM(sLat, sLng, n.lat, n.lon);
        if (d < bd) { bd = d; startNode = n; }
      }
    }
  }
  const targetM = targetKm * 1000;

  // 1. Dijkstra from start → distances to all nodes in the pruned graph
  const { dist, prev: prevOut } = dijkstra(adj, startNode.k);

  // 2. Collect mid candidates within ±35% of targetM/2
  // All surviving nodes have degree ≥ 2, so no junction filter needed
  const half = targetM / 2;
  const candidates = [];
  for (const [k, d] of dist) {
    if (d <= 0) continue;
    const ratio = Math.abs(d - half) / half;
    if (ratio < 0.35) candidates.push({ k, d, ratio });
  }
  if (!candidates.length) {
    for (const [k, d] of dist) {
      if (d > 0) candidates.push({ k, d, ratio: Math.abs(d - half) / half });
    }
  }
  candidates.sort((a, b) => a.ratio - b.ratio);

  // 3. Try top candidates; score each by distance error + overlap penalty; keep best
  let bestLoop = null, bestScore = Infinity;

  for (const cand of candidates.slice(0, 15)) {
    const outKeys = rebuildPath(prevOut, startNode.k, cand.k);
    if (!outKeys) continue;

    // Remove outbound edges from a copy of the adjacency list.
    // This also removes the departure edge from start, forcing the return
    // to arrive via a different edge (= different path at start/end).
    const adjBack = new Map([...adj].map(([k, edges]) => [k, [...edges]]));
    const outEdgeSet = new Set();
    for (let i = 0; i < outKeys.length - 1; i++) {
      const a = outKeys[i], b = outKeys[i + 1];
      outEdgeSet.add(`${a}|${b}`);
      outEdgeSet.add(`${b}|${a}`);
      adjBack.set(a, adjBack.get(a).filter(e => e.to !== b));
      adjBack.set(b, adjBack.get(b).filter(e => e.to !== a));
    }

    const { prev: prevBack } = dijkstra(adjBack, cand.k, startNode.k);
    const backKeys = rebuildPath(prevBack, cand.k, startNode.k);
    if (!backKeys) continue;

    // Score: distance error + 2× overlap ratio (overlap is the main enemy)
    const allKeys = [...outKeys, ...backKeys.slice(1)];
    let totalM = 0, overlap = 0;
    for (let i = 0; i < allKeys.length - 1; i++) {
      const na = nodes.get(allKeys[i]), nb = nodes.get(allKeys[i + 1]);
      const d = haversineM(na.lat, na.lon, nb.lat, nb.lon);
      totalM += d;
      if (outEdgeSet.has(`${allKeys[i]}|${allKeys[i + 1]}`)) overlap += d;
    }
    const distErr     = Math.abs(totalM - targetM) / targetM;
    const overlapFrac = totalM > 0 ? overlap / totalM : 1;
    const score       = distErr + overlapFrac * 2;

    if (score < bestScore) { bestScore = score; bestLoop = allKeys; }
    if (distErr < 0.15 && overlapFrac < 0.05) break; // good enough
  }

  if (!bestLoop) throw new Error('Impossible de former une boucle — ajoute plus de chemins dans la zone');
  return graphToResult(nodes, bestLoop, pathTyp);
}

// Cost multiplier applied to unnoted OSM paths when blended with curated admin
// paths. A mild >1 value makes the router prefer admin paths when they are
// roughly as direct, but still flow onto OSM paths to continue past the edge of
// the curated network instead of taking a long detour to stay on admin paths.
// (A large value like 3 caused the router to cling to noted paths and detour.)
const OSM_GAPFILL_WEIGHT = 1.4;

// Tag OSM paths with the gap-fill weight, preserving any existing surface weight.
function tagOsmGapFill(osmPaths) {
  return osmPaths.map(p => ({ ...p, _weight: (p._weight || 1) * OSM_GAPFILL_WEIGHT }));
}

// A→B routing with admin paths as primary network and OSM paths as weighted gap-fill.
function graphAtobHybrid(sLat, sLng, eLat, eLng, adminPaths, osmPaths) {
  const all = [...adminPaths, ...tagOsmGapFill(osmPaths)];
  if (!all.length) throw new Error('Aucun chemin disponible');
  const { nodes, adj } = buildGraph(all);
  const sNode = nearestNode(nodes, sLat, sLng);
  const eNode = nearestNode(nodes, eLat, eLng);
  const { prev } = dijkstra(adj, sNode.k, eNode.k);
  const keys = rebuildPath(prev, sNode.k, eNode.k);
  if (!keys) throw new Error('Aucun chemin entre ces deux points');
  return graphToResult(nodes, keys, 'foot');
}

// Loop routing with admin paths as primary network and OSM paths as weighted
// gap-fill, so loops can continue past the edge of the curated network.
function graphLoopHybrid(sLat, sLng, targetKm, adminPaths, osmPaths, pathTyp = 'foot') {
  const all = [...adminPaths, ...tagOsmGapFill(osmPaths)];
  return graphLoop(sLat, sLng, targetKm, all, pathTyp);
}

if (typeof module !== 'undefined') {
  module.exports = {
    haversineM, nodeKey, buildGraph, dijkstra,
    rebuildPath, nearestNode, graphToResult,
    snapToJunction, pruneDeadEnds, graphAtob, graphAtobHybrid, graphLoop, graphLoopHybrid,
  };
}
