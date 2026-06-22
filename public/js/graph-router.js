// Pure graph-routing functions — no DOM, no globals.
// Loaded as a plain <script> in the browser; exported via CJS for Node tests.

// Binary min-heap used by dijkstra — O(log n) push/pop vs O(n log n) sort.
class MinHeap {
  constructor() { this._h = []; }
  get size() { return this._h.length; }
  push(item) { this._h.push(item); this._up(this._h.length - 1); }
  pop() {
    const top = this._h[0];
    const last = this._h.pop();
    if (this._h.length) { this._h[0] = last; this._down(0); }
    return top;
  }
  _up(i) {
    const h = this._h;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p][0] <= h[i][0]) break;
      [h[p], h[i]] = [h[i], h[p]]; i = p;
    }
  }
  _down(i) {
    const h = this._h, n = h.length;
    for (;;) {
      let s = i, l = 2 * i + 1, r = l + 1;
      if (l < n && h[l][0] < h[s][0]) s = l;
      if (r < n && h[r][0] < h[s][0]) s = r;
      if (s === i) break;
      [h[s], h[i]] = [h[i], h[s]]; i = s;
    }
  }
}

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Initial compass bearing (0–360°) from point 1 to point 2.
function bearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Smallest absolute difference between two compass bearings (0–180°).
function bearingDelta(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
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

  // Stitch crossings: connect ANY two nodes (not just endpoints) within STITCH_M.
  // Separate networks — e.g. hand-drawn admin paths and the OSM path network — rarely
  // share exact coordinates where they cross, so without this they stay disconnected
  // and the router gets trapped on whichever network it snapped onto, forcing a long
  // detour. Linking nearby nodes lets the route transfer between every path on the map.
  const STITCH_M = 35;
  const SCELL = 0.0004; // ~44 m cells → ±1 neighbour covers all 35 m pairs
  const allNodes = [...nodes.values()];
  const sgrid = new Map();
  allNodes.forEach(n => {
    const ck = `${Math.floor(n.lat / SCELL)},${Math.floor(n.lon / SCELL)}`;
    if (!sgrid.has(ck)) sgrid.set(ck, []);
    sgrid.get(ck).push(n);
  });
  for (const n of allNodes) {
    const cr = Math.floor(n.lat / SCELL), cc = Math.floor(n.lon / SCELL);
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const bucket = sgrid.get(`${cr + dr},${cc + dc}`);
        if (!bucket) continue;
        for (const m of bucket) {
          if (m.k <= n.k) continue; // visit each unordered pair once
          const d = haversineM(n.lat, n.lon, m.lat, m.lon);
          if (d > 0 && d < STITCH_M && !adj.get(n.k).some(e => e.to === m.k)) link(n.k, m.k, d);
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
  const queue = new MinHeap();
  queue.push([0, start]);

  while (queue.size) {
    const [d, u] = queue.pop();
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

// Like dijkstra but skips edges whose "u|to" key is in the excludeEdges set.
// Avoids copying the entire adjacency map when only a few edges need removing.
function dijkstraExclude(adj, start, end, excludeEdges) {
  const dist = new Map([[start, 0]]);
  const prev = new Map();
  const queue = new MinHeap();
  queue.push([0, start]);

  while (queue.size) {
    const [d, u] = queue.pop();
    if (u === end) break;
    if (d > (dist.get(u) ?? Infinity)) continue;
    for (const { to, d: w } of (adj.get(u) || [])) {
      if (excludeEdges.has(`${u}|${to}`)) continue;
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
function graphAtob(sLat, sLng, eLat, eLng, paths, transportMode = 'foot') {
  if (!paths.length) throw new Error('Aucun chemin de ce type enregistré');
  const { nodes, adj } = buildGraph(paths);
  const sNode = nearestNode(nodes, sLat, sLng);
  const eNode = nearestNode(nodes, eLat, eLng);
  const { prev } = dijkstra(adj, sNode.k, eNode.k);
  const keys = rebuildPath(prev, sNode.k, eNode.k);
  if (!keys) throw new Error('Aucun chemin entre ces deux points');
  return graphToResult(nodes, keys, transportMode);
}

// Loop routing on the graph — routes out one way, removes those edges, routes back differently.
// Dead-end spurs are pruned first so the router never has to backtrack along a branch.
// The return path must arrive at start via a different edge than the outbound departure.
// paths: pre-filtered array of path objects.
// pathTyp: 'foot' | 'bike' | 'champs' (used only for speed in the result).
// seed: when non-zero, biases the turnaround point toward a per-seed compass
// direction so the same start point yields a different loop each day. seed=0
// keeps the deterministic "most direct loop" behaviour (used by the tests).
function graphLoop(sLat, sLng, targetKm, paths, pathTyp = 'foot', seed = 0) {
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

  // Per-day preferred compass direction for the turnaround point. The golden
  // angle (137.508°) spreads consecutive seeds evenly around the circle so
  // successive days point in well-separated directions. angBias() returns 0 when
  // unseeded, so the deterministic path is unchanged.
  const preferredBearing = ((seed % 360) * 137.508) % 360;
  const ANG_WEIGHT = 0.6;
  const startN = nodes.get(startNode.k);
  const angBias = (k) => {
    if (!seed) return 0;
    const n = nodes.get(k);
    if (!n) return 0;
    const brg = bearingDeg(startN.lat, startN.lon, n.lat, n.lon);
    return (bearingDelta(brg, preferredBearing) / 180) * ANG_WEIGHT;
  };

  // 2. Collect mid candidates within ±35% of targetM/2
  // All surviving nodes have degree ≥ 2, so no junction filter needed
  const half = targetM / 2;
  const candidates = [];
  for (const [k, d] of dist) {
    if (d <= 0) continue;
    const ratio = Math.abs(d - half) / half;
    if (ratio < 0.35) candidates.push({ k, d, ratio, ang: angBias(k) });
  }
  if (!candidates.length) {
    for (const [k, d] of dist) {
      if (d > 0) candidates.push({ k, d, ratio: Math.abs(d - half) / half, ang: angBias(k) });
    }
  }
  // Order by distance fit, nudged toward the day's preferred direction.
  candidates.sort((a, b) => (a.ratio + a.ang) - (b.ratio + b.ang));

  // 3. Try top candidates; score each by distance error + overlap penalty; keep best
  let bestLoop = null, bestScore = Infinity;

  for (const cand of candidates.slice(0, 15)) {
    const outKeys = rebuildPath(prevOut, startNode.k, cand.k);
    if (!outKeys) continue;

    // Build the excluded-edge set from the outbound path, then run Dijkstra
    // directly on the original adj while skipping those edges.
    // This avoids an O(N+E) full adjacency-map copy per candidate.
    const outEdgeSet = new Set();
    for (let i = 0; i < outKeys.length - 1; i++) {
      const a = outKeys[i], b = outKeys[i + 1];
      outEdgeSet.add(`${a}|${b}`);
      outEdgeSet.add(`${b}|${a}`);
    }

    const { prev: prevBack } = dijkstraExclude(adj, cand.k, startNode.k, outEdgeSet);
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
    const score       = distErr + overlapFrac * 2 + cand.ang;

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
function graphAtobHybrid(sLat, sLng, eLat, eLng, adminPaths, osmPaths, transportMode = 'foot') {
  const all = [...adminPaths, ...tagOsmGapFill(osmPaths)];
  if (!all.length) throw new Error('Aucun chemin disponible');
  const { nodes, adj } = buildGraph(all);
  const sNode = nearestNode(nodes, sLat, sLng);
  const eNode = nearestNode(nodes, eLat, eLng);
  const { prev } = dijkstra(adj, sNode.k, eNode.k);
  const keys = rebuildPath(prev, sNode.k, eNode.k);
  if (!keys) throw new Error('Aucun chemin entre ces deux points');
  return graphToResult(nodes, keys, transportMode);
}

// Loop routing with admin paths as primary network and OSM paths as weighted
// gap-fill, so loops can continue past the edge of the curated network.
function graphLoopHybrid(sLat, sLng, targetKm, adminPaths, osmPaths, pathTyp = 'foot', seed = 0) {
  const all = [...adminPaths, ...tagOsmGapFill(osmPaths)];
  return graphLoop(sLat, sLng, targetKm, all, pathTyp, seed);
}

if (typeof module !== 'undefined') {
  module.exports = {
    haversineM, nodeKey, buildGraph, dijkstra, dijkstraExclude,
    rebuildPath, nearestNode, graphToResult,
    snapToJunction, pruneDeadEnds, graphAtob, graphAtobHybrid, graphLoop, graphLoopHybrid,
  };
}
