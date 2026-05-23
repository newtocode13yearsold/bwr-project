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
    const keys = c.map(([lat, lon]) => ensure(lat, lon));
    for (let i = 0; i < keys.length - 1; i++) {
      const d = haversineM(c[i][0], c[i][1], c[i + 1][0], c[i + 1][1]);
      if (!adj.get(keys[i]).some(e => e.to === keys[i + 1])) link(keys[i], keys[i + 1], d);
    }
  });

  // Connect path endpoints within 80 m so separate paths join up
  const endpoints = [];
  paths.forEach(p => {
    const c = p.coordinates;
    endpoints.push([c[0][0], c[0][1]]);
    endpoints.push([c[c.length - 1][0], c[c.length - 1][1]]);
  });
  for (let i = 0; i < endpoints.length; i++) {
    for (let j = i + 1; j < endpoints.length; j++) {
      const d = haversineM(...endpoints[i], ...endpoints[j]);
      if (d > 0 && d < 80) {
        const ka = nodeKey(...endpoints[i]), kb = nodeKey(...endpoints[j]);
        if (adj.has(ka) && adj.has(kb) && !adj.get(ka).some(e => e.to === kb)) link(ka, kb, d);
      }
    }
  }

  return { nodes, adj };
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
// This guarantees a true loop with zero backtracking.
// paths: pre-filtered array of path objects.
// pathTyp: 'foot' | 'bike' | 'champs' (used only for speed in the result).
function graphLoop(sLat, sLng, targetKm, paths, pathTyp = 'foot') {
  if (!paths.length) throw new Error('Aucun chemin de ce type enregistré');
  const { nodes, adj } = buildGraph(paths);
  if (nodes.size < 4) throw new Error('Pas assez de chemins — ajoutes-en depuis le panneau admin');

  const startNode = nearestNode(nodes, sLat, sLng);
  const targetM   = targetKm * 1000;

  // 1. Dijkstra from start → distances to all nodes
  const { dist, prev: prevOut } = dijkstra(adj, startNode.k);

  // 2. Pick the node closest to half the target distance
  let midKey = null, midDiff = Infinity;
  for (const [k, d] of dist) {
    if (d <= 0) continue;
    const diff = Math.abs(d - targetM / 2);
    if (diff < midDiff) { midDiff = diff; midKey = k; }
  }
  if (!midKey) throw new Error('Le réseau est trop petit pour cette distance');

  // 3. Reconstruct outgoing path start → mid
  const outKeys = rebuildPath(prevOut, startNode.k, midKey);
  if (!outKeys) throw new Error('Impossible de calculer l\'aller');

  // 4. Copy adjacency list and remove all edges used on the way out
  const adjBack = new Map([...adj].map(([k, edges]) => [k, [...edges]]));
  for (let i = 0; i < outKeys.length - 1; i++) {
    const a = outKeys[i], b = outKeys[i + 1];
    adjBack.set(a, adjBack.get(a).filter(e => e.to !== b));
    adjBack.set(b, adjBack.get(b).filter(e => e.to !== a));
  }

  // 5. Route back mid → start on different edges
  const { prev: prevBack } = dijkstra(adjBack, midKey, startNode.k);
  const backKeys = rebuildPath(prevBack, midKey, startNode.k);
  if (!backKeys) throw new Error('Impossible de former une boucle — ajoute plus de chemins dans la zone');

  return graphToResult(nodes, [...outKeys, ...backKeys.slice(1)], pathTyp);
}

if (typeof module !== 'undefined') {
  module.exports = {
    haversineM, nodeKey, buildGraph, dijkstra,
    rebuildPath, nearestNode, graphToResult,
    graphAtob, graphLoop,
  };
}
